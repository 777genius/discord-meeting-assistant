import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import {
  parseAuthoritativeTrackUploadMetadata,
  parseCraigLifecycleEvent,
  parseVoicePacketBatch,
} from "@discord-meeting/craig-gateway-contracts";
import { ZodError } from "zod";

import type {
  AuthoritativeSpeakerTrackUpload,
  LiveVoicePacketBatchCommand,
  MeetingRecordingIngress,
  RecordingLifecycleCommand,
} from "../../../application/recording-ingress.js";
import {
  canonicalLiveAudioFormat,
  RecordingIngressRejectedError,
} from "../../../application/recording-ingress.js";
import { MeetingPublicationTargetUnavailableError } from "../../../application/platform-ingress.js";
import {
  assertBearerToken,
  createBearerTokenGuard,
  isBearerTokenAuthorized,
} from "../../../http/fastify-bearer-auth.js";
import { sendJson } from "../../../http/http-response.js";

export const maximumCraigJsonBodyBytes = 4 * 1_024 * 1_024;
const s3BucketPattern = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const s3KeySegmentPattern = /^[A-Za-z0-9!_.*'()-]+$/u;

export type CraigIngressPort = MeetingRecordingIngress;

interface ActiveCraigRecordingChannel {
  readonly guildId: string;
  readonly voiceChannelId: string;
}

export interface ActiveCraigRecordingChannelReader {
  listActiveGuildVoiceChannels(): Promise<readonly ActiveCraigRecordingChannel[]>;
}

export interface CraigInboundRoutesOptions {
  readonly bearerToken: string;
  readonly configuration: ActiveCraigRecordingChannelReader;
  readonly ingress: CraigIngressPort;
}

export function createCraigInboundRoutesPlugin(
  options: CraigInboundRoutesOptions,
): FastifyPluginCallback {
  assertBearerToken(options.bearerToken);
  return (app, _pluginOptions, done) => {
    app.addContentTypeParser("audio/ogg", (_request, payload, parseDone) => {
      parseDone(null, payload);
    });
    registerCraigInboundRoutes(app, options);
    done();
  };
}

function registerCraigInboundRoutes(
  app: FastifyInstance,
  options: CraigInboundRoutesOptions,
): void {
  app.get(
    "/v1/craig/configuration",
    { onRequest: createBearerTokenGuard(options.bearerToken) },
    async (_request, reply) => {
      const channels = (await options.configuration.listActiveGuildVoiceChannels())
        .toSorted(compareActiveGuildVoiceChannels)
        .map(({ guildId, voiceChannelId }) => ({ guildId, voiceChannelId }));
      return sendJson(reply, 200, { channels, schemaVersion: 1 });
    },
  );
  app.post(
    "/v1/craig/events",
    {
      bodyLimit: maximumCraigJsonBodyBytes,
      onRequest: protectCraigPayload(options.bearerToken, "application/json"),
    },
    async (request, reply) => {
      try {
        await options.ingress.ingestLifecycle(
          mapLifecycleCommand(parseCraigLifecycleEvent(request.body)),
        );
        return sendJson(reply, 202, { status: "accepted" });
      } catch (error: unknown) {
        return respondToCraigFailure(error, reply);
      }
    },
  );
  app.post(
    "/v1/craig/voice-packets",
    {
      bodyLimit: maximumCraigJsonBodyBytes,
      onRequest: protectCraigPayload(options.bearerToken, "application/json"),
    },
    async (request, reply) => {
      try {
        await options.ingress.ingestVoiceBatch(
          mapVoicePacketBatch(parseVoicePacketBatch(request.body)),
        );
        return sendJson(reply, 202, { status: "accepted" });
      } catch (error: unknown) {
        return respondToCraigFailure(error, reply);
      }
    },
  );
  app.post(
    "/v1/craig/authoritative-tracks",
    { onRequest: protectCraigPayload(options.bearerToken, "audio/ogg") },
    async (request, reply) => {
      try {
        const metadata = mapAuthoritativeTrackUpload(parseAuthoritativeTrackMetadataHeader(
          request.headers["x-craig-authoritative-track-metadata"],
        ));
        if (!hasExpectedDeclaredLength(request, metadata.sizeBytes)) {
          request.raw.resume();
          return sendJson(reply, 400, { code: "INVALID_CONTENT_LENGTH" });
        }
        const result = await options.ingress.ingestAuthoritativeTrack(
          metadata,
          asByteStream(request.body),
        );
        return sendJson(
          reply,
          result.replayed ? 200 : 201,
          createDurableTrackUploadAcknowledgement(result),
        );
      } catch (error: unknown) {
        return respondToCraigFailure(error, reply);
      }
    },
  );
}

function createDurableTrackUploadAcknowledgement(
  receipt: Awaited<ReturnType<CraigIngressPort["ingestAuthoritativeTrack"]>>,
) {
  const object = parseImmutableS3Object(receipt.locator, receipt.versionId);
  return {
    checksumSha256: receipt.checksumSha256,
    durable: true,
    immutable: true,
    object,
    recordingId: receipt.recordingId,
    schemaVersion: 1,
    sizeBytes: receipt.sizeBytes,
    trackNumber: receipt.trackNumber,
    uploadId: receipt.uploadId,
  } as const;
}

function parseImmutableS3Object(locator: string, versionId: string) {
  if (
    !locator.startsWith("s3://") ||
    locator.includes("?") ||
    locator.includes("#") ||
    locator.includes("\\") ||
    locator.includes("%") ||
    versionId.length === 0 ||
    versionId === "null" ||
    containsControlCharacter(versionId)
  ) {
    throw new Error("Durability receipt does not contain an immutable S3 object identity");
  }
  const bucketAndKey = locator.slice("s3://".length);
  const separatorIndex = bucketAndKey.indexOf("/");
  const bucket = bucketAndKey.slice(0, separatorIndex);
  const key = bucketAndKey.slice(separatorIndex + 1);
  const keySegments = key.split("/");
  if (
    separatorIndex < 1 ||
    !s3BucketPattern.test(bucket) ||
    bucket.includes("..") ||
    key.length === 0 ||
    key.endsWith("/") ||
    keySegments.some((segment) => !s3KeySegmentPattern.test(segment))
  ) {
    throw new Error("Durability receipt does not contain an immutable S3 object identity");
  }
  return { bucket, key, provider: "s3" as const, versionId };
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 32 || codeUnit === 127) {
      return true;
    }
  }
  return false;
}

function protectCraigPayload(token: string, expectedContentType: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!isBearerTokenAuthorized(request.headers.authorization, token)) {
      sendJson(reply, 401, { code: "UNAUTHORIZED" });
      return;
    }
    if (!hasExpectedContentType(request, expectedContentType)) {
      sendJson(reply, 415, { code: "CONTENT_TYPE_REQUIRED" });
      return;
    }
  };
}

function hasExpectedContentType(request: FastifyRequest, expected: string): boolean {
  const header = request.headers["content-type"];
  if (typeof header !== "string") {
    return false;
  }
  return header.split(";", 1)[0]?.trim() === expected;
}

function hasExpectedDeclaredLength(request: FastifyRequest, expected: number): boolean {
  const header = request.headers["content-length"];
  const declaredLength = typeof header === "string" ? Number(header) : Number.NaN;
  return Number.isSafeInteger(declaredLength) && declaredLength === expected;
}

function asByteStream(value: unknown): AsyncIterable<Uint8Array> {
  if (
    typeof value !== "object" ||
    value === null ||
    !(Symbol.asyncIterator in value)
  ) {
    throw new Error("Fastify audio parser did not preserve the request stream");
  }
  return value as AsyncIterable<Uint8Array>;
}

function parseAuthoritativeTrackMetadataHeader(
  value: string | readonly string[] | undefined,
) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new SyntaxError("invalid authoritative track metadata header");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new SyntaxError("non-canonical authoritative track metadata header");
  }
  return parseAuthoritativeTrackUploadMetadata(
    JSON.parse(decoded.toString("utf8")) as unknown,
  );
}

function mapLifecycleCommand(
  event: ReturnType<typeof parseCraigLifecycleEvent>,
): RecordingLifecycleCommand {
  const { channelId, guildId, ...providerNeutralEvent } = event;
  return {
    ...providerNeutralEvent,
    source: { roomId: channelId, scopeId: guildId },
  };
}

function mapVoicePacketBatch(
  batch: ReturnType<typeof parseVoicePacketBatch>,
): LiveVoicePacketBatchCommand {
  return {
    format: canonicalLiveAudioFormat,
    packets: batch.packets.map((packet) => ({
      mediaTimestamp: packet.rtpTimestamp,
      payloadBase64: packet.opusBase64,
      receivedAtMs: packet.receivedAtMs,
      recordingId: packet.recordingId,
      relativeTimeMs: packet.relativeTimeMs,
      schemaVersion: packet.schemaVersion,
      sequenceNumber: packet.rtpSequence,
      source: { roomId: packet.channelId, scopeId: packet.guildId },
      speakerId: packet.speakerId,
    })),
    schemaVersion: batch.schemaVersion,
  };
}

function mapAuthoritativeTrackUpload(
  metadata: ReturnType<typeof parseAuthoritativeTrackUploadMetadata>,
): AuthoritativeSpeakerTrackUpload {
  return {
    checksumSha256: metadata.checksumSha256,
    recordingId: metadata.recordingId,
    schemaVersion: metadata.schemaVersion,
    sizeBytes: metadata.sizeBytes,
    source: { roomId: metadata.channelId, scopeId: metadata.guildId },
    speakerId: metadata.speakerId,
    timelineOffsetMs: metadata.timelineOffsetMs,
    trackNumber: metadata.trackNumber,
    uploadId: metadata.uploadId,
  };
}

function respondToCraigFailure(
  error: unknown,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof SyntaxError || error instanceof ZodError) {
    return sendJson(reply, 400, { code: "INVALID_REQUEST" });
  }
  if (error instanceof RecordingIngressRejectedError) {
    return respondToRecordingIngressRejection(error, reply);
  }
  if (error instanceof MeetingPublicationTargetUnavailableError) {
    return sendJson(reply, 503, { code: "GUILD_NOT_CONFIGURED" });
  }
  throw error;
}

function respondToRecordingIngressRejection(
  error: RecordingIngressRejectedError,
  reply: FastifyReply,
): FastifyReply {
  switch (error.rejection) {
    case "invalid-request":
      return sendJson(reply, 400, { code: "INVALID_INGRESS_STATE" });
    case "conflict":
      return sendJson(reply, 409, { code: "INGRESS_CONFLICT" });
    case "limit-exceeded":
      return sendJson(reply, 413, { code: "INGRESS_LIMIT_EXCEEDED" });
  }
}

function compareActiveGuildVoiceChannels(
  left: ActiveCraigRecordingChannel,
  right: ActiveCraigRecordingChannel,
): number {
  if (left.guildId !== right.guildId) {
    return left.guildId < right.guildId ? -1 : 1;
  }
  if (left.voiceChannelId !== right.voiceChannelId) {
    return left.voiceChannelId < right.voiceChannelId ? -1 : 1;
  }
  return 0;
}
