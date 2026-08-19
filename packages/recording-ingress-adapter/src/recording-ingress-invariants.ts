import { createHash } from "node:crypto";

import type {
  CraigLifecycleEvent,
  VoicePacketBatch,
} from "@discord-meeting/craig-gateway-contracts";

import type {
  RecordingBinaryArtifactWriteReceipt,
  RecordingIngressLimits,
} from "./contracts.js";
import {
  RecordingIngressAbortedError,
  RecordingIngressError,
} from "./errors.js";
import type { JournalPacket } from "./ogg-opus.js";
import type {
  RecordingSpoolState,
  StoredActor,
  StoredLifecycleEvent,
} from "./spool.js";

const DISCORD_SNOWFLAKE = /^\d{17,20}$/u;
const BASE64 = /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u;

function compareOpaqueIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

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

export interface DecodedPacket extends JournalPacket {
  readonly channelId: string;
  readonly guildId: string;
  readonly recordingId: string;
  readonly speakerId: string;
}

export function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new RecordingIngressAbortedError();
  }
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function journalPacketFingerprint(packet: JournalPacket): string {
  return `${packet.receivedAtMs}:${sha256(packet.opus)}`;
}

export function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new RecordingIngressError("invalid-input", `${field} is invalid`);
  }
  return value;
}

export function requireSnowflake(value: unknown, field: string): string {
  if (typeof value !== "string" || !DISCORD_SNOWFLAKE.test(value)) {
    throw new RecordingIngressError("invalid-input", `${field} is invalid`);
  }
  return value;
}

function normalizeActor(actor: StoredActor): StoredActor {
  const kind: unknown = actor.kind;
  if (kind !== "human" && kind !== "automation" && kind !== "unknown") {
    throw new RecordingIngressError("invalid-input", "actor kind is invalid");
  }
  return {
    actorId: requireSnowflake(actor.actorId, "actor.actorId"),
    kind,
  };
}

export function normalizeActorRoster(
  actors: readonly StoredActor[],
): readonly StoredActor[] {
  const normalized = actors.map(normalizeActor)
    .toSorted((left, right) => compareOpaqueIds(left.actorId, right.actorId));
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (previous !== undefined && current !== undefined && previous.actorId === current.actorId) {
      throw new RecordingIngressError(
        "conflicting-duplicate",
        previous.kind === current.kind
          ? "actor roster repeats an actor"
          : "one actor was assigned conflicting kinds",
      );
    }
  }
  return normalized;
}

export function sameActorRoster(
  left: readonly StoredActor[] | null,
  right: readonly StoredActor[] | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.length === right.length && left.every((actor, index) => {
        const candidate = right[index];
        return candidate !== undefined &&
          actor.actorId === candidate.actorId &&
          actor.kind === candidate.kind;
      });
}

export function sameActorRosterIds(
  left: readonly StoredActor[] | null,
  right: readonly StoredActor[] | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.length === right.length && left.every((actor, index) =>
        actor.actorId === right[index]?.actorId
      );
}

export function addActorToRoster(
  actors: readonly StoredActor[],
  actor: StoredActor,
): readonly StoredActor[] {
  const normalizedActor = normalizeActor(actor);
  const existing = actors.find((candidate) => candidate.actorId === normalizedActor.actorId);
  if (existing === undefined) {
    return [...actors, normalizedActor]
      .toSorted((left, right) => compareOpaqueIds(left.actorId, right.actorId));
  }
  if (existing.kind !== normalizedActor.kind) {
    throw new RecordingIngressError(
      "conflicting-duplicate",
      "one actor was assigned conflicting kinds",
    );
  }
  return actors;
}

export function observeActorInRoster(
  actors: readonly StoredActor[],
  actor: StoredActor,
): {
  readonly actors: readonly StoredActor[];
  readonly conflicted: boolean;
} {
  const normalizedActor = normalizeActor(actor);
  const existing = actors.find((candidate) => candidate.actorId === normalizedActor.actorId);
  if (existing === undefined) {
    return {
      actors: [...actors, normalizedActor]
        .toSorted((left, right) => compareOpaqueIds(left.actorId, right.actorId)),
      conflicted: false,
    };
  }
  return { actors, conflicted: existing.kind !== normalizedActor.kind };
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

export function decodePacket(
  input: VoicePacketBatch["packets"][number],
  maxBytes: number,
): DecodedPacket {
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

export function canonicalLifecycleEvent(event: CraigLifecycleEvent): Record<string, unknown> {
  const common = {
    channelId: requireSnowflake(event.channelId, "event.channelId"),
    eventId: requireIdentifier(event.eventId, "event.eventId"),
    guildId: requireSnowflake(event.guildId, "event.guildId"),
    occurredAt: requireInstant(event.occurredAt, "event.occurredAt"),
    recordingId: requireIdentifier(event.recordingId, "event.recordingId"),
    schemaVersion: event.schemaVersion,
    type: event.type,
    ...(event.schemaVersion === 3
      ? {
          actorObservationState: event.actorObservationState,
          actorSemanticsVersion: event.actorSemanticsVersion,
          producerCapabilityId: event.producerCapabilityId,
          producerRevision: event.producerRevision,
        }
      : {}),
  };
  switch (event.type) {
    case "meeting.started":
      return event.schemaVersion === 1
        ? {
            ...common,
            participantIds: event.participantIds.map(
              (id) => requireSnowflake(id, "participantId"),
            ),
          }
        : {
            ...common,
            actors: normalizeActorRoster(event.actors),
            ...(event.schemaVersion === 3 ? { rosterState: event.rosterState } : {}),
          };
    case "participant.joined":
    case "participant.left":
      return event.schemaVersion === 1
        ? {
            ...common,
            participantId: requireSnowflake(event.participantId, "participantId"),
          }
        : { ...common, actor: normalizeActor(event.actor) };
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
        ...(event.schemaVersion === 1
          ? {}
          : {
              actors: normalizeActorRoster(event.actors),
              ...(event.schemaVersion === 3 ? { rosterState: event.rosterState } : {}),
            }),
        endedAt: requireInstant(event.endedAt, "event.endedAt"),
        sourceFilesChecksumSha256: event.sourceFilesChecksumSha256,
        trackCount: event.trackCount,
      };
  }
}

export function storedEvent(event: CraigLifecycleEvent, digest: string): StoredLifecycleEvent {
  return {
    digest,
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    type: event.type,
  };
}

export function validateLimits(input?: Partial<RecordingIngressLimits>): RecordingIngressLimits {
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

export function normalizeLocatorPrefix(value: string): string {
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

export function ensureRecordingIdentity(
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

export function verifyWriteReceipt(
  request: { readonly checksumSha256: string; readonly locator: string; readonly sizeBytes: number },
  receipt: RecordingBinaryArtifactWriteReceipt,
): void {
  if (
    receipt.checksumSha256 !== request.checksumSha256 ||
    receipt.sizeBytes !== request.sizeBytes ||
    receipt.locator !== request.locator
  ) {
    throw new RecordingIngressError(
      "artifact-write-mismatch",
      "artifact writer did not confirm the expected binary content",
    );
  }
}
