import { createHash } from "node:crypto";

import type {
  AuthoritativeTrackUploadMetadata,
  CraigLifecycleEvent,
  VoicePacketBatch,
} from "@discord-meeting/craig-gateway-contracts";
import type { RecordingArtifactSnapshot } from "@discord-meeting/meeting-core";

import type {
  DurableCraigRecordingIngressOptions,
  LifecycleIngressResult,
  PacketBatchIngressResult,
  RecordingBinaryArtifactWriteReceipt,
  RecordingIngressLimits,
} from "./contracts.js";
import {
  RecordingIngressAbortedError,
  RecordingIngressError,
} from "./errors.js";
import {
  appendJournal,
  journalPacketIdentity,
  journalPacketsEqual,
  scanJournal,
  type JournalScan,
} from "./journal.js";
import {
  compileOggOpus,
  type CompiledOggOpus,
  type JournalPacket,
} from "./ogg-opus.js";
import {
  DurableSpool,
  spoolToken,
  type AbortedRecordingState,
  type CompletedRecordingState,
  type RecordingSpoolState,
  type StoredLifecycleEvent,
  type StoredAuthoritativeTrack,
  type StoredSpeaker,
} from "./spool.js";

const DISCORD_SNOWFLAKE = /^\d{17,20}$/u;
const BASE64 = /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u;
const ACTIVE_CAPACITY_LOCK = Symbol("active-capacity");
const noOperation = (): void => undefined;

export const DEFAULT_RECORDING_INGRESS_LIMITS: RecordingIngressLimits =
  Object.freeze({
    maxActiveRecordings: 100,
    maxBatchOpusBytes: 1 * 1_024 * 1_024,
    maxLifecycleEventsPerRecording: 10_000,
    maxOpusBytesPerPacket: 4_096,
    maxPacketsPerBatch: 256,
    maxPacketsPerRecording: 2_000_000,
    maxPacketsPerSpeaker: 500_000,
    maxRecordingOpusBytes: 2 * 1_024 * 1_024 * 1_024,
    maxSpeakerOpusBytes: 64 * 1_024 * 1_024,
    maxSpeakersPerRecording: 64,
  });

interface DecodedPacket extends JournalPacket {
  readonly channelId: string;
  readonly guildId: string;
  readonly recordingId: string;
  readonly speakerId: string;
}

interface CompiledTrack extends CompiledOggOpus {
  readonly checksumSha256: string;
  readonly locator: string;
  readonly speakerId: string;
}

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new RecordingIngressAbortedError();
  }
}

function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new RecordingIngressError("invalid-input", `${field} is invalid`);
  }
  return value;
}

function requireSnowflake(value: unknown, field: string): string {
  if (typeof value !== "string" || !DISCORD_SNOWFLAKE.test(value)) {
    throw new RecordingIngressError("invalid-input", `${field} is invalid`);
  }
  return value;
}

function requireIntegerInRange(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RecordingIngressError("invalid-input", `${field} is invalid`);
  }
  return value as number;
}

function requireInstant(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new RecordingIngressError("invalid-input", `${field} is invalid`);
  }
  return value;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeCanonicalBase64(value: unknown, maxBytes: number): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > Math.ceil(maxBytes / 3) * 4 ||
    !BASE64.test(value)
  ) {
    throw new RecordingIngressError("invalid-input", "opusBase64 is invalid");
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.byteLength === 0 ||
    decoded.byteLength > maxBytes ||
    decoded.toString("base64") !== value
  ) {
    throw new RecordingIngressError("invalid-input", "opusBase64 is invalid");
  }
  return Uint8Array.from(decoded);
}

function decodePacket(input: VoicePacketBatch["packets"][number], maxBytes: number): DecodedPacket {
  return {
    channelId: requireSnowflake(input.channelId, "packet.channelId"),
    guildId: requireSnowflake(input.guildId, "packet.guildId"),
    opus: decodeCanonicalBase64(input.opusBase64, maxBytes),
    receivedAtMs: requireIntegerInRange(
      input.receivedAtMs,
      "packet.receivedAtMs",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    recordingId: requireIdentifier(input.recordingId, "packet.recordingId"),
    relativeTimeMs: requireIntegerInRange(
      input.relativeTimeMs,
      "packet.relativeTimeMs",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    rtpSequence: requireIntegerInRange(input.rtpSequence, "packet.rtpSequence", 0, 0xffff),
    rtpTimestamp: requireIntegerInRange(
      input.rtpTimestamp,
      "packet.rtpTimestamp",
      0,
      0xffff_ffff,
    ),
    speakerId: requireSnowflake(input.speakerId, "packet.speakerId"),
  };
}

function canonicalLifecycleEvent(event: CraigLifecycleEvent): Record<string, unknown> {
  const common = {
    channelId: requireSnowflake(event.channelId, "event.channelId"),
    eventId: requireIdentifier(event.eventId, "event.eventId"),
    guildId: requireSnowflake(event.guildId, "event.guildId"),
    occurredAt: requireInstant(event.occurredAt, "event.occurredAt"),
    recordingId: requireIdentifier(event.recordingId, "event.recordingId"),
    schemaVersion: event.schemaVersion,
    type: event.type,
  };
  switch (event.type) {
    case "meeting.started":
      return {
        ...common,
        participantIds: event.participantIds.map((id) => requireSnowflake(id, "participantId")),
      };
    case "participant.joined":
    case "participant.left":
      return {
        ...common,
        participantId: requireSnowflake(event.participantId, "participantId"),
      };
    case "meeting.connection_lost":
    case "meeting.connection_recovered":
    case "meeting.ended":
    case "meeting.aborted":
      return { ...common, reason: event.reason };
    case "recording.artifact_ready":
      return {
        ...common,
        endedAt: requireInstant(event.endedAt, "event.endedAt"),
        multitrackManifestKey: event.multitrackManifestKey,
        usersManifestKey: event.usersManifestKey,
      };
    case "recording.authoritative_ready":
      return {
        ...common,
        endedAt: requireInstant(event.endedAt, "event.endedAt"),
        sourceFilesChecksumSha256: event.sourceFilesChecksumSha256,
        trackCount: event.trackCount,
      };
  }
}

function storedEvent(event: CraigLifecycleEvent, digest: string): StoredLifecycleEvent {
  return {
    digest,
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    type: event.type,
  };
}

function validateLimits(input?: Partial<RecordingIngressLimits>): RecordingIngressLimits {
  const limits = { ...DEFAULT_RECORDING_INGRESS_LIMITS, ...input };
  for (const [field, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RecordingIngressError("invalid-input", `invalid ingress limit: ${field}`);
    }
  }
  if (limits.maxPacketsPerSpeaker > limits.maxPacketsPerRecording) {
    throw new RecordingIngressError(
      "invalid-input",
      "speaker packet limit cannot exceed recording packet limit",
    );
  }
  if (
    limits.maxOpusBytesPerPacket > limits.maxBatchOpusBytes ||
    limits.maxBatchOpusBytes > limits.maxRecordingOpusBytes ||
    limits.maxSpeakerOpusBytes > limits.maxRecordingOpusBytes
  ) {
    throw new RecordingIngressError(
      "invalid-input",
      "packet, batch and speaker byte limits must fit the recording byte limit",
    );
  }
  return Object.freeze(limits);
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

function normalizeLocatorPrefix(value: string): string {
  const prefix = value.replace(/\/+$/u, "");
  let decodedSegments: readonly string[];
  try {
    decodedSegments = prefix.split("/").map((segment) => decodeURIComponent(segment));
  } catch (error) {
    throw new RecordingIngressError("path-policy", "artifact locator prefix is unsafe", {
      cause: error,
    });
  }
  if (
    prefix.length === 0 ||
    containsControlCharacter(prefix) ||
    prefix.includes("\\") ||
    prefix.includes("?") ||
    prefix.includes("#") ||
    decodedSegments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\"),
    )
  ) {
    throw new RecordingIngressError("path-policy", "artifact locator prefix is unsafe");
  }
  return prefix;
}

function ensureRecordingIdentity(
  state: Pick<RecordingSpoolState, "channelId" | "guildId" | "recordingId">,
  input: { readonly channelId: string; readonly guildId: string; readonly recordingId: string },
): void {
  if (
    state.recordingId !== input.recordingId ||
    state.guildId !== input.guildId ||
    state.channelId !== input.channelId
  ) {
    throw new RecordingIngressError(
      "invalid-state",
      "recording, guild and channel identity cannot change",
    );
  }
}

function verifyWriteReceipt(
  request: { readonly checksumSha256: string; readonly locator: string; readonly sizeBytes: number },
  receipt: RecordingBinaryArtifactWriteReceipt,
): void {
  if (
    receipt.checksumSha256 !== request.checksumSha256 ||
    receipt.sizeBytes !== request.sizeBytes ||
    typeof receipt.locator !== "string" ||
    receipt.locator.length === 0
  ) {
    throw new RecordingIngressError(
      "artifact-write-mismatch",
      "artifact writer did not confirm the expected binary content",
    );
  }
}

export class DurableCraigRecordingIngress {
  readonly #artifactLocatorPrefix: string;
  readonly #limits: RecordingIngressLimits;
  readonly #finalizationSource: DurableCraigRecordingIngressOptions["finalizationSource"];
  readonly #locks = new Map<string | symbol, Promise<void>>();
  readonly #spool: DurableSpool;
  readonly #writer: DurableCraigRecordingIngressOptions["writer"];

  public constructor(options: DurableCraigRecordingIngressOptions) {
    this.#artifactLocatorPrefix = normalizeLocatorPrefix(options.artifactLocatorPrefix);
    this.#limits = validateLimits(options.limits);
    this.#finalizationSource = options.finalizationSource;
    this.#spool = new DurableSpool(options.spoolRoot);
    this.#writer = options.writer;
  }

  public async ingestAuthoritativeTrack(
    metadata: AuthoritativeTrackUploadMetadata,
    body: AsyncIterable<Uint8Array>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<{
    readonly locator: string;
    readonly recordingId: string;
    readonly replayed: boolean;
    readonly speakerId: string;
  }> {
    abortIfRequested(options.signal);
    if (this.#finalizationSource !== "craig-original") {
      throw new RecordingIngressError(
        "unsupported-event",
        "authoritative track upload is disabled for this ingress",
      );
    }
    const recordingId = requireIdentifier(metadata.recordingId, "track.recordingId");
    const identity = {
      channelId: requireSnowflake(metadata.channelId, "track.channelId"),
      guildId: requireSnowflake(metadata.guildId, "track.guildId"),
      recordingId,
    };
    const speakerId = requireSnowflake(metadata.speakerId, "track.speakerId");
    const recordingToken = spoolToken("recording-v1", recordingId);
    const locator = `${this.#artifactLocatorPrefix}/${recordingToken}/authoritative/speakers/${speakerId}.ogg`;
    const request = {
      body,
      checksumSha256: metadata.checksumSha256,
      contentType: "audio/ogg",
      locator,
      metadata: {
        "recording-token": recordingToken,
        "source-kind": "craig-original-multitrack",
        "speaker-id": speakerId,
        "track-number": String(metadata.trackNumber),
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      sizeBytes: metadata.sizeBytes,
    } as const;

    return this.#exclusive(recordingId, async () => {
      abortIfRequested(options.signal);
      const completed = await this.#spool.readCompleted(recordingId);
      if (completed !== undefined) {
        ensureRecordingIdentity(completed, identity);
        const receipt = await this.#writer.write(request);
        verifyWriteReceipt(request, receipt);
        return { locator: receipt.locator, recordingId, replayed: true, speakerId };
      }
      const aborted = await this.#spool.readAborted(recordingId);
      if (aborted !== undefined) {
        ensureRecordingIdentity(aborted, identity);
        await this.#spool.cleanupActive(recordingId);
        throw new RecordingIngressError(
          "invalid-state",
          "cannot upload an authoritative track for an aborted recording",
        );
      }
      const state = await this.#spool.readRecording(recordingId);
      if (state === undefined) {
        throw new RecordingIngressError(
          "invalid-state",
          "meeting.started must precede authoritative track upload",
        );
      }
      ensureRecordingIdentity(state, identity);
      if (state.status === "aborted") {
        await this.#spool.archiveAborted(state);
        throw new RecordingIngressError(
          "invalid-state",
          "cannot upload an authoritative track for an aborted recording",
        );
      }
      const candidate: StoredAuthoritativeTrack = {
        audioLocator: locator,
        checksumSha256: metadata.checksumSha256,
        sizeBytes: metadata.sizeBytes,
        speakerId,
        timelineOffsetMs: metadata.timelineOffsetMs,
        trackNumber: metadata.trackNumber,
        uploadId: requireIdentifier(metadata.uploadId, "track.uploadId"),
      };
      const existing = state.authoritativeTracks.find(
        (track) =>
          track.uploadId === candidate.uploadId ||
          track.trackNumber === candidate.trackNumber ||
          track.speakerId === candidate.speakerId,
      );
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(candidate)) {
        throw new RecordingIngressError(
          "conflicting-duplicate",
          "authoritative track identity was replayed with different content",
        );
      }
      if (existing === undefined && state.authoritativeTracks.length >= this.#limits.maxSpeakersPerRecording) {
        throw new RecordingIngressError(
          "limit-exceeded",
          "authoritative recording exceeds the configured speaker limit",
        );
      }

      const receipt = await this.#writer.write(request);
      verifyWriteReceipt(request, receipt);
      if (existing === undefined) {
        await this.#spool.writeRecording({
          ...state,
          authoritativeTracks: [...state.authoritativeTracks, { ...candidate, audioLocator: receipt.locator }]
            .toSorted((left, right) => left.trackNumber - right.trackNumber),
        });
      }
      return {
        locator: receipt.locator,
        recordingId,
        replayed: existing !== undefined,
        speakerId,
      };
    });
  }

  async #exclusive<T>(key: string | symbol, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release = noOperation;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#locks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(key) === tail) {
        this.#locks.delete(key);
      }
    }
  }

  public async ingestPacketBatch(
    batch: VoicePacketBatch,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<PacketBatchIngressResult> {
    abortIfRequested(options.signal);
    if (batch.packets.length === 0 || batch.packets.length > this.#limits.maxPacketsPerBatch) {
      throw new RecordingIngressError("limit-exceeded", "voice packet batch is invalid or too large");
    }
    const packets = batch.packets.map((packet) =>
      decodePacket(packet, this.#limits.maxOpusBytesPerPacket),
    );
    if (
      packets.reduce((total, packet) => total + packet.opus.byteLength, 0) >
      this.#limits.maxBatchOpusBytes
    ) {
      throw new RecordingIngressError(
        "limit-exceeded",
        "voice packet batch exceeds the configured byte limit",
      );
    }
    const first = packets[0];
    if (first === undefined) {
      throw new RecordingIngressError("invalid-input", "voice packet batch is empty");
    }
    for (const packet of packets) {
      if (
        packet.recordingId !== first.recordingId ||
        packet.guildId !== first.guildId ||
        packet.channelId !== first.channelId
      ) {
        throw new RecordingIngressError(
          "invalid-input",
          "one packet batch must belong to one recording, guild and channel",
        );
      }
    }

    return this.#exclusive(first.recordingId, async () => {
      abortIfRequested(options.signal);
      if ((await this.#spool.readCompleted(first.recordingId)) !== undefined) {
        throw new RecordingIngressError("invalid-state", "recording is already finalized");
      }
      const aborted = await this.#spool.readAborted(first.recordingId);
      if (aborted !== undefined) {
        ensureRecordingIdentity(aborted, first);
        await this.#spool.cleanupActive(first.recordingId);
        throw new RecordingIngressError("invalid-state", "recording is already aborted");
      }
      let state = await this.#spool.readRecording(first.recordingId);
      if (state === undefined) {
        throw new RecordingIngressError("invalid-state", "meeting.started must precede audio packets");
      }
      ensureRecordingIdentity(state, first);
      if (state.status !== "active") {
        if (state.status === "aborted") {
          await this.#spool.archiveAborted(state);
        }
        throw new RecordingIngressError(
          "invalid-state",
          `cannot append packets while recording is ${state.status}`,
        );
      }

      const incomingSpeakerIds = [...new Set(packets.map(({ speakerId }) => speakerId))].toSorted();
      const knownSpeakerIds = new Set(state.speakers.map(({ speakerId }) => speakerId));
      const newSpeakers = incomingSpeakerIds
        .filter((speakerId) => !knownSpeakerIds.has(speakerId))
        .map<StoredSpeaker>((speakerId) => ({
          fileToken: spoolToken("speaker-v1", speakerId),
          speakerId,
        }));
      if (state.speakers.length + newSpeakers.length > this.#limits.maxSpeakersPerRecording) {
        throw new RecordingIngressError(
          "limit-exceeded",
          "recording exceeds the configured speaker limit",
        );
      }
      if (newSpeakers.length > 0) {
        state = {
          ...state,
          speakers: [...state.speakers, ...newSpeakers].toSorted((left, right) =>
            left.speakerId.localeCompare(right.speakerId),
          ),
        };
        // The speaker-to-hashed-file mapping is durable before its first append.
        await this.#spool.writeRecording(state);
      }

      const scans = new Map<string, JournalScan>();
      let recordingPacketCount = 0;
      let recordingOpusBytes = 0;
      for (const speaker of state.speakers) {
        const scan = await scanJournal(
          this.#spool.speakerJournalPath(state.recordingId, speaker.fileToken),
          {
            maxOpusBytesPerPacket: this.#limits.maxOpusBytesPerPacket,
            maxPackets: this.#limits.maxPacketsPerSpeaker,
            repairIncompleteTail: true,
          },
        );
        scans.set(speaker.speakerId, scan);
        recordingPacketCount += scan.packets.length;
        recordingOpusBytes += scan.opusBytes;
      }

      let duplicatePackets = 0;
      const acceptedBySpeaker = new Map<string, JournalPacket[]>();
      for (const packet of packets) {
        abortIfRequested(options.signal);
        const scan = scans.get(packet.speakerId);
        if (scan === undefined) {
          throw new RecordingIngressError("corrupt-spool", "speaker mapping is missing");
        }
        const accepted = acceptedBySpeaker.get(packet.speakerId) ?? [];
        const candidates = [...scan.packets, ...accepted];
        const identity = journalPacketIdentity(packet);
        const duplicate = candidates.find(
          (candidate) => journalPacketIdentity(candidate) === identity,
        );
        if (duplicate !== undefined) {
          if (!journalPacketsEqual(duplicate, packet)) {
            throw new RecordingIngressError(
              "conflicting-duplicate",
              "packet identity was replayed with different content",
            );
          }
          duplicatePackets += 1;
          continue;
        }
        accepted.push(packet);
        acceptedBySpeaker.set(packet.speakerId, accepted);
        recordingPacketCount += 1;
        recordingOpusBytes += packet.opus.byteLength;
        if (
          scan.packets.length + accepted.length > this.#limits.maxPacketsPerSpeaker ||
          scan.opusBytes +
              accepted.reduce((total, candidate) => total + candidate.opus.byteLength, 0) >
            this.#limits.maxSpeakerOpusBytes ||
          recordingPacketCount > this.#limits.maxPacketsPerRecording ||
          recordingOpusBytes > this.#limits.maxRecordingOpusBytes
        ) {
          throw new RecordingIngressError(
            "limit-exceeded",
            "recording exceeds a configured packet or byte limit",
          );
        }
      }

      for (const speaker of state.speakers) {
        const accepted = acceptedBySpeaker.get(speaker.speakerId) ?? [];
        if (accepted.length > 0) {
          abortIfRequested(options.signal);
          await appendJournal(
            this.#spool.speakerJournalPath(state.recordingId, speaker.fileToken),
            accepted,
          );
        }
      }
      return {
        acceptedPackets: packets.length - duplicatePackets,
        duplicatePackets,
        recordingId: state.recordingId,
      };
    });
  }

  public async ingestLifecycleEvent(
    event: CraigLifecycleEvent,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<LifecycleIngressResult> {
    abortIfRequested(options.signal);
    const canonical = canonicalLifecycleEvent(event);
    const digest = sha256(JSON.stringify(canonical));

    return this.#exclusive(event.recordingId, async () => {
      abortIfRequested(options.signal);
      const completed = await this.#spool.readCompleted(event.recordingId);
      if (completed !== undefined) {
        ensureRecordingIdentity(completed, event);
        const completedReplay = completed.events.find(
          ({ eventId }) => eventId === event.eventId,
        );
        if (completedReplay === undefined) {
          throw new RecordingIngressError("invalid-state", "recording is already finalized");
        }
        if (digest !== completedReplay.digest) {
          throw new RecordingIngressError(
            "conflicting-duplicate",
            "lifecycle event ID was replayed with different content",
          );
        }
        await this.#cleanupAfterSuccess(event.recordingId);
        return event.type === "recording.authoritative_ready" ||
          (event.type === "meeting.ended" && this.#finalizationSource === "live-packet-spool")
          ? { kind: "finalized", recording: completed.recording, replayed: true }
          : { kind: "accepted", recordingId: completed.recordingId, replayed: true };
      }

      const aborted = await this.#spool.readAborted(event.recordingId);
      if (aborted !== undefined) {
        return this.#replayAborted(aborted, event, digest);
      }

      let state = await this.#spool.readRecording(event.recordingId);
      if (state === undefined) {
        if (event.type !== "meeting.started") {
          throw new RecordingIngressError(
            "invalid-state",
            "meeting.started must be the first lifecycle event",
          );
        }
        state = await this.#exclusive(ACTIVE_CAPACITY_LOCK, async () => {
          if ((await this.#spool.activeRecordingCount()) >= this.#limits.maxActiveRecordings) {
            throw new RecordingIngressError(
              "limit-exceeded",
              "active recording limit has been reached",
            );
          }
          const initialState: RecordingSpoolState = {
            authoritativeTracks: [],
            channelId: event.channelId,
            events: [storedEvent(event, digest)],
            guildId: event.guildId,
            recordingId: event.recordingId,
            schemaVersion: 1,
            speakers: [],
            startedAt: event.occurredAt,
            status: "active",
          };
          await this.#spool.writeRecording(initialState);
          return initialState;
        });
        return { kind: "accepted", recordingId: event.recordingId, replayed: false };
      }

      ensureRecordingIdentity(state, event);
      if (state.status === "aborted") {
        return this.#replayAborted(await this.#spool.archiveAborted(state), event, digest);
      }
      const replay = state.events.find(({ eventId }) => eventId === event.eventId);
      if (replay !== undefined) {
        if (replay.digest !== digest) {
          throw new RecordingIngressError(
            "conflicting-duplicate",
            "lifecycle event ID was replayed with different content",
          );
        }
        if (
          event.type === "meeting.ended" &&
          state.status === "finalizing" &&
          this.#finalizationSource === "live-packet-spool"
        ) {
          const recording = await this.#finalizePacketSpool(state, options.signal);
          return { kind: "finalized", recording, replayed: true };
        }
        if (
          event.type === "recording.authoritative_ready" &&
          state.status === "finalizing" &&
          this.#finalizationSource === "craig-original"
        ) {
          const recording = await this.#finalizeAuthoritative(state, event, options.signal);
          return { kind: "finalized", recording, replayed: true };
        }
        return { kind: "accepted", recordingId: state.recordingId, replayed: true };
      }

      if (event.type === "recording.artifact_ready") {
        throw new RecordingIngressError(
          "unsupported-event",
          "recording.artifact_ready is outbound evidence, not an ingress command",
        );
      }
      if (event.type === "recording.authoritative_ready") {
        if (this.#finalizationSource !== "craig-original") {
          throw new RecordingIngressError(
            "unsupported-event",
            "authoritative-ready is disabled for this ingress",
          );
        }
        if (state.status !== "finalizing" || state.endedAt === undefined) {
          throw new RecordingIngressError(
            "invalid-state",
            "meeting.ended must precede authoritative-ready",
          );
        }
        const authoritativeEndedAt = Date.parse(event.endedAt);
        const lifecycleEndedAt = Date.parse(state.endedAt);
        const startedAt = Date.parse(state.startedAt);
        if (
          authoritativeEndedAt < startedAt ||
          authoritativeEndedAt > lifecycleEndedAt + 60_000
        ) {
          throw new RecordingIngressError(
            "invalid-state",
            "authoritative-ready endedAt is outside the recording lifecycle",
          );
        }
        if (event.trackCount !== state.authoritativeTracks.length) {
          throw new RecordingIngressError(
            "invalid-state",
            "authoritative-ready track count does not match durable uploads",
          );
        }
        const finalizingState: RecordingSpoolState = {
          ...state,
          endedAt: event.endedAt,
          events: [...state.events, storedEvent(event, digest)],
          finalEventDigest: digest,
          finalEventId: event.eventId,
        };
        await this.#spool.writeRecording(finalizingState);
        const recording = await this.#finalizeAuthoritative(
          finalizingState,
          event,
          options.signal,
        );
        return { kind: "finalized", recording, replayed: false };
      }
      if (state.status !== "active") {
        throw new RecordingIngressError(
          "invalid-state",
          `cannot apply a new event while recording is ${state.status}`,
        );
      }
      if (state.events.length >= this.#limits.maxLifecycleEventsPerRecording) {
        throw new RecordingIngressError(
          "limit-exceeded",
          "recording exceeds the lifecycle event replay limit",
        );
      }

      const events = [...state.events, storedEvent(event, digest)];
      if (event.type === "meeting.aborted") {
        const abortedState: AbortedRecordingState = {
          ...state,
          endedAt: event.occurredAt,
          events,
          status: "aborted",
        };
        await this.#spool.archiveAborted(abortedState);
        return { kind: "aborted", recordingId: state.recordingId, replayed: false };
      }
      if (event.type === "meeting.ended") {
        const finalizingState: RecordingSpoolState = {
          ...state,
          endedAt: event.occurredAt,
          events,
          finalEventDigest: digest,
          finalEventId: event.eventId,
          status: "finalizing",
        };
        await this.#spool.writeRecording(finalizingState);
        if (this.#finalizationSource === "craig-original") {
          return { kind: "accepted", recordingId: state.recordingId, replayed: false };
        }
        const recording = await this.#finalizePacketSpool(finalizingState, options.signal);
        return { kind: "finalized", recording, replayed: false };
      }

      const nextState: RecordingSpoolState = { ...state, events };
      await this.#spool.writeRecording(nextState);
      return { kind: "accepted", recordingId: state.recordingId, replayed: false };
    });
  }

  async #replayAborted(
    aborted: AbortedRecordingState,
    event: CraigLifecycleEvent,
    digest: string,
  ): Promise<LifecycleIngressResult> {
    ensureRecordingIdentity(aborted, event);
    const replay = aborted.events.find(({ eventId }) => eventId === event.eventId);
    if (replay === undefined) {
      throw new RecordingIngressError("invalid-state", "recording is already aborted");
    }
    if (digest !== replay.digest) {
      throw new RecordingIngressError(
        "conflicting-duplicate",
        "lifecycle event ID was replayed with different content",
      );
    }
    await this.#spool.cleanupActive(event.recordingId);
    return { kind: "aborted", recordingId: aborted.recordingId, replayed: true };
  }

  async #finalizePacketSpool(
    state: RecordingSpoolState,
    signal?: AbortSignal,
  ): Promise<RecordingArtifactSnapshot> {
    abortIfRequested(signal);
    if (
      state.status !== "finalizing" ||
      state.endedAt === undefined ||
      state.finalEventId === undefined ||
      state.finalEventDigest === undefined
    ) {
      throw new RecordingIngressError("invalid-state", "recording is not ready to finalize");
    }

    const tracks: CompiledTrack[] = [];
    for (const speaker of state.speakers.toSorted((left, right) =>
      left.speakerId.localeCompare(right.speakerId),
    )) {
      abortIfRequested(signal);
      const scan = await scanJournal(
        this.#spool.speakerJournalPath(state.recordingId, speaker.fileToken),
        {
          maxOpusBytesPerPacket: this.#limits.maxOpusBytesPerPacket,
          maxPackets: this.#limits.maxPacketsPerSpeaker,
          repairIncompleteTail: true,
        },
      );
      if (scan.packets.length === 0) {
        continue;
      }
      const compiled = compileOggOpus(state.recordingId, speaker.speakerId, scan.packets);
      const recordingToken = spoolToken(
        "recording-v1",
        state.recordingId,
      );
      const requestedLocator = `${this.#artifactLocatorPrefix}/${recordingToken}/speakers/${speaker.speakerId}.ogg`;
      const checksumSha256 = sha256(compiled.bytes);
      const request = {
        body: compiled.bytes,
        checksumSha256,
        contentType: "audio/ogg",
        locator: requestedLocator,
        metadata: {
          "recording-token": recordingToken,
          "speaker-id": speaker.speakerId,
        },
        ...(signal === undefined ? {} : { signal }),
        sizeBytes: compiled.bytes.byteLength,
      } as const;
      const receipt = await this.#writer.write(request);
      verifyWriteReceipt(request, receipt);
      tracks.push({
        ...compiled,
        checksumSha256,
        locator: receipt.locator,
        speakerId: speaker.speakerId,
      });
    }

    abortIfRequested(signal);
    const manifest = {
      channelId: state.channelId,
      endedAt: state.endedAt,
      guildId: state.guildId,
      recordingId: state.recordingId,
      schemaVersion: 1,
      tracks: tracks.map((track) => ({
        checksumSha256: track.checksumSha256,
        durationMs: track.durationMs,
        locator: track.locator,
        packetCount: track.packetCount,
        serial: track.serial,
        sizeBytes: track.bytes.byteLength,
        speakerId: track.speakerId,
        timelineOffsetMs: track.timelineOffsetMs,
      })),
    } as const;
    const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);
    const manifestChecksum = sha256(manifestBytes);
    const manifestRequest = {
      body: manifestBytes,
      checksumSha256: manifestChecksum,
      contentType: "application/json",
      locator: `${this.#artifactLocatorPrefix}/${spoolToken(
        "recording-v1",
        state.recordingId,
      )}/manifest.json`,
      metadata: {
        "recording-token": spoolToken("recording-v1", state.recordingId),
      },
      ...(signal === undefined ? {} : { signal }),
      sizeBytes: manifestBytes.byteLength,
    } as const;
    const manifestReceipt = await this.#writer.write(manifestRequest);
    verifyWriteReceipt(manifestRequest, manifestReceipt);

    const recording: RecordingArtifactSnapshot = {
      manifestLocator: manifestReceipt.locator,
      recordingId: state.recordingId,
      speakerAudio: tracks.map((track) => ({
        audioLocator: track.locator,
        speakerId: track.speakerId,
        timelineOffsetMs: track.timelineOffsetMs,
      })),
    };
    await this.#persistCompleted(state, recording);
    return recording;
  }

  async #finalizeAuthoritative(
    state: RecordingSpoolState,
    event: Extract<CraigLifecycleEvent, { readonly type: "recording.authoritative_ready" }>,
    signal?: AbortSignal,
  ): Promise<RecordingArtifactSnapshot> {
    abortIfRequested(signal);
    if (
      state.status !== "finalizing" ||
      state.endedAt === undefined ||
      state.finalEventId !== event.eventId ||
      state.finalEventDigest === undefined ||
      state.authoritativeTracks.length !== event.trackCount
    ) {
      throw new RecordingIngressError(
        "invalid-state",
        "authoritative recording is not ready to finalize",
      );
    }
    const tracks = state.authoritativeTracks.toSorted(
      (left, right) => left.trackNumber - right.trackNumber,
    );
    if (
      new Set(tracks.map(({ speakerId }) => speakerId)).size !== tracks.length ||
      new Set(tracks.map(({ trackNumber }) => trackNumber)).size !== tracks.length
    ) {
      throw new RecordingIngressError(
        "corrupt-spool",
        "authoritative recording contains duplicate track identities",
      );
    }

    const manifest = {
      channelId: state.channelId,
      endedAt: state.endedAt,
      guildId: state.guildId,
      recordingId: state.recordingId,
      schemaVersion: 1,
      source: {
        checksumSha256: event.sourceFilesChecksumSha256,
        kind: "craig-original-multitrack",
      },
      startedAt: state.startedAt,
      tracks: tracks.map((track) => ({
        checksumSha256: track.checksumSha256,
        locator: track.audioLocator,
        sizeBytes: track.sizeBytes,
        speakerId: track.speakerId,
        timelineOffsetMs: track.timelineOffsetMs,
        trackNumber: track.trackNumber,
      })),
    } as const;
    const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);
    const manifestChecksum = sha256(manifestBytes);
    const recordingToken = spoolToken("recording-v1", state.recordingId);
    const request = {
      body: manifestBytes,
      checksumSha256: manifestChecksum,
      contentType: "application/json",
      locator: `${this.#artifactLocatorPrefix}/${recordingToken}/authoritative/manifest.json`,
      metadata: {
        "recording-token": recordingToken,
        "source-kind": "craig-original-multitrack",
      },
      ...(signal === undefined ? {} : { signal }),
      sizeBytes: manifestBytes.byteLength,
    } as const;
    const receipt = await this.#writer.write(request);
    verifyWriteReceipt(request, receipt);
    const recording: RecordingArtifactSnapshot = {
      manifestLocator: receipt.locator,
      recordingId: state.recordingId,
      speakerAudio: tracks.map((track) => ({
        audioLocator: track.audioLocator,
        speakerId: track.speakerId,
        timelineOffsetMs: track.timelineOffsetMs,
      })),
    };
    await this.#persistCompleted(state, recording);
    return recording;
  }

  async #persistCompleted(
    state: RecordingSpoolState,
    recording: RecordingArtifactSnapshot,
  ): Promise<void> {
    if (state.finalEventDigest === undefined || state.finalEventId === undefined) {
      throw new RecordingIngressError("corrupt-spool", "final event evidence is missing");
    }
    const completed: CompletedRecordingState = {
      channelId: state.channelId,
      events: state.events,
      finalEventDigest: state.finalEventDigest,
      finalEventId: state.finalEventId,
      guildId: state.guildId,
      recording,
      recordingId: state.recordingId,
      schemaVersion: 1,
    };
    await this.#spool.writeCompleted(completed);
    await this.#cleanupAfterSuccess(state.recordingId);
  }

  async #cleanupAfterSuccess(recordingId: string): Promise<void> {
    try {
      await this.#spool.cleanupActive(recordingId);
    } catch {
      // The durable completion receipt is authoritative. A later replay retries
      // cleanup, but cleanup failure cannot turn confirmed artifact writes into
      // an unknown outcome.
    }
  }
}
