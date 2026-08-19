import { RecordingIngressError } from "./errors.js";
import { parseCompletedAuthoritativeDuration } from "./spool-completed-duration.js";

type RecordingSpoolStatus = "active" | "aborted" | "finalizing";

const immutableProducerRevision = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

function compareOpaqueIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface StoredLifecycleEvent {
  readonly digest: string;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly type: string;
}

export interface StoredSpeaker {
  readonly fileToken: string;
  readonly speakerId: string;
}

export interface StoredActor {
  readonly actorId: string;
  readonly kind: "automation" | "human" | "unknown";
}

export interface StoredIdentityProvenance {
  readonly actorObservationState: "consistent" | "conflicted";
  readonly actorSemanticsVersion: number;
  readonly producerCapabilityId: string;
  readonly producerRevision: string;
  readonly rosterState: "sealed" | "unsealed";
}

export interface StoredAuthoritativeTrack {
  readonly artifactVersionId: string | null;
  readonly audioLocator: string;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly speakerId: string;
  readonly timelineOffsetMs: number;
  readonly trackNumber: number;
  readonly uploadId: string;
}

export interface RecordingSpoolState {
  readonly actors: readonly StoredActor[] | null;
  readonly authoritativeTracks: readonly StoredAuthoritativeTrack[];
  readonly channelId: string;
  readonly endedAt?: string;
  readonly events: readonly StoredLifecycleEvent[];
  readonly finalEventDigest?: string;
  readonly finalEventId?: string;
  readonly guildId: string;
  readonly identityProvenance: StoredIdentityProvenance | null;
  readonly lifecycleSchemaVersion: 1 | 2 | 3;
  readonly pendingAuthoritativeTracks: readonly StoredAuthoritativeTrack[];
  readonly recordingId: string;
  readonly schemaVersion: 3;
  readonly speakers: readonly StoredSpeaker[];
  readonly startedAt: string;
  readonly status: RecordingSpoolStatus;
}

export type AbortedRecordingState = RecordingSpoolState & {
  readonly endedAt: string;
  readonly status: "aborted";
};

export interface CompletedRecordingState {
  /**
   * Immutable identities of the bytes accepted before finalization. This is
   * deliberately retained beside the public recording snapshot: the snapshot
   * alone cannot prove whether a later upload is an exact retry.
   */
  readonly authoritativeTracks: readonly StoredAuthoritativeTrack[];
  readonly actors: readonly StoredActor[] | null;
  readonly channelId: string;
  readonly events: readonly StoredLifecycleEvent[];
  readonly finalEventDigest: string;
  readonly finalEventId: string;
  readonly guildId: string;
  readonly identityProvenance: StoredIdentityProvenance | null;
  readonly lifecycleSchemaVersion: 1 | 2 | 3;
  readonly recording: {
    readonly authoritativeDurationMs?: number;
    readonly manifestLocator: string;
    readonly recordingId: string;
    readonly speakerAudio: readonly {
      readonly audioLocator: string;
      readonly speakerId: string;
      readonly timelineOffsetMs: number;
    }[];
  };
  readonly recordingId: string;
  readonly schemaVersion: 5;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RecordingIngressError("corrupt-spool", "spool metadata is not an object");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RecordingIngressError("corrupt-spool", `invalid spool field: ${field}`);
  }
  return value;
}

function parseStoredEvent(value: unknown): StoredLifecycleEvent {
  const record = objectValue(value);
  return {
    digest: stringValue(record.digest, "events.digest"),
    eventId: stringValue(record.eventId, "events.eventId"),
    occurredAt: stringValue(record.occurredAt, "events.occurredAt"),
    type: stringValue(record.type, "events.type"),
  };
}

function parseStoredSpeaker(value: unknown): StoredSpeaker {
  const record = objectValue(value);
  return {
    fileToken: stringValue(record.fileToken, "speakers.fileToken"),
    speakerId: stringValue(record.speakerId, "speakers.speakerId"),
  };
}

function parseStoredActor(value: unknown): StoredActor {
  const record = objectValue(value);
  if (record.kind !== "human" && record.kind !== "automation" && record.kind !== "unknown") {
    throw new RecordingIngressError("corrupt-spool", "invalid actor kind");
  }
  return {
    actorId: stringValue(record.actorId, "actors.actorId"),
    kind: record.kind,
  };
}

function parseActorRoster(value: unknown): readonly StoredActor[] | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw new RecordingIngressError("corrupt-spool", "actor roster is not an array");
  }
  const actors = value.map(parseStoredActor)
    .toSorted((left, right) => compareOpaqueIds(left.actorId, right.actorId));
  for (let index = 1; index < actors.length; index += 1) {
    const previous = actors[index - 1];
    const current = actors[index];
    if (previous !== undefined && current !== undefined && previous.actorId === current.actorId) {
      throw new RecordingIngressError(
        "corrupt-spool",
        previous.kind === current.kind
          ? "actor roster repeats an actor"
          : "actor roster contains conflicting actor kinds",
      );
    }
  }
  return actors;
}

function parseIdentityProvenance(value: unknown): StoredIdentityProvenance | null {
  if (value === undefined || value === null) {
    return null;
  }
  const record = objectValue(value);
  const producerCapabilityId = stringValue(
    record.producerCapabilityId,
    "identityProvenance.producerCapabilityId",
  );
  const producerRevision = stringValue(
    record.producerRevision,
    "identityProvenance.producerRevision",
  );
  if (
    (record.actorObservationState !== "consistent" && record.actorObservationState !== "conflicted") ||
    !Number.isSafeInteger(record.actorSemanticsVersion) ||
    (record.actorSemanticsVersion as number) < 1 ||
    (record.actorSemanticsVersion as number) > 1_000 ||
    producerCapabilityId.length > 128 ||
    !immutableProducerRevision.test(producerRevision) ||
    (record.rosterState !== "sealed" && record.rosterState !== "unsealed")
  ) {
    throw new RecordingIngressError("corrupt-spool", "invalid identity provenance");
  }
  return {
    actorObservationState: record.actorObservationState,
    actorSemanticsVersion: record.actorSemanticsVersion as number,
    producerCapabilityId,
    producerRevision,
    rosterState: record.rosterState,
  };
}

function lifecycleSchemaVersion(value: unknown, fallback: 1): 1 | 2 | 3 {
  const version = value ?? fallback;
  if (version !== 1 && version !== 2 && version !== 3) {
    throw new RecordingIngressError("corrupt-spool", "invalid lifecycle schema version");
  }
  return version;
}

function parseStoredAuthoritativeTrack(value: unknown): StoredAuthoritativeTrack {
  const record = objectValue(value);
  if (
    !Number.isSafeInteger(record.sizeBytes) ||
    (record.sizeBytes as number) <= 0 ||
    !Number.isSafeInteger(record.timelineOffsetMs) ||
    (record.timelineOffsetMs as number) < 0 ||
    !Number.isSafeInteger(record.trackNumber) ||
    (record.trackNumber as number) < 1
  ) {
    throw new RecordingIngressError("corrupt-spool", "invalid authoritative track metadata");
  }
  const checksumSha256 = stringValue(record.checksumSha256, "authoritativeTracks.checksumSha256");
  if (!/^[0-9a-f]{64}$/u.test(checksumSha256)) {
    throw new RecordingIngressError("corrupt-spool", "invalid authoritative track checksum");
  }
  return {
    artifactVersionId: record.artifactVersionId === undefined || record.artifactVersionId === null ? null : stringValue(record.artifactVersionId, "authoritativeTracks.artifactVersionId"),
    audioLocator: stringValue(record.audioLocator, "authoritativeTracks.audioLocator"),
    checksumSha256,
    sizeBytes: record.sizeBytes as number,
    speakerId: stringValue(record.speakerId, "authoritativeTracks.speakerId"),
    timelineOffsetMs: record.timelineOffsetMs as number,
    trackNumber: record.trackNumber as number,
    uploadId: stringValue(record.uploadId, "authoritativeTracks.uploadId"),
  };
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, field);
}

export function parseRecordingSpoolState(input: unknown): RecordingSpoolState {
  const record = objectValue(input);
  if (
    (record.schemaVersion !== 1 && record.schemaVersion !== 2 && record.schemaVersion !== 3) ||
    !Array.isArray(record.events) ||
    !Array.isArray(record.speakers)
  ) {
    throw new RecordingIngressError("corrupt-spool", "unsupported spool metadata schema");
  }
  if (record.status !== "active" && record.status !== "aborted" && record.status !== "finalizing") {
    throw new RecordingIngressError("corrupt-spool", "invalid spool recording status");
  }
  const endedAt = optionalString(record.endedAt, "endedAt");
  const finalEventDigest = optionalString(record.finalEventDigest, "finalEventDigest");
  const finalEventId = optionalString(record.finalEventId, "finalEventId");
  const actors = parseActorRoster(record.actors);
  const identityProvenance = parseIdentityProvenance(record.identityProvenance);
  const protocolVersion = lifecycleSchemaVersion(record.lifecycleSchemaVersion, 1);
  if (protocolVersion !== 1 && actors === null) {
    throw new RecordingIngressError("corrupt-spool", "actor lifecycle spool is missing actors");
  }
  if ((protocolVersion === 3) !== (identityProvenance !== null)) {
    throw new RecordingIngressError(
      "corrupt-spool",
      "lifecycle generation and identity provenance do not match",
    );
  }
  return {
    actors,
    authoritativeTracks: Array.isArray(record.authoritativeTracks)
      ? record.authoritativeTracks.map(parseStoredAuthoritativeTrack)
      : [],
    channelId: stringValue(record.channelId, "channelId"),
    ...(endedAt === undefined ? {} : { endedAt }),
    events: record.events.map(parseStoredEvent),
    ...(finalEventDigest === undefined ? {} : { finalEventDigest }),
    ...(finalEventId === undefined ? {} : { finalEventId }),
    guildId: stringValue(record.guildId, "guildId"),
    identityProvenance,
    lifecycleSchemaVersion: protocolVersion,
    pendingAuthoritativeTracks: Array.isArray(record.pendingAuthoritativeTracks)
      ? record.pendingAuthoritativeTracks.map(parseStoredAuthoritativeTrack)
      : [],
    recordingId: stringValue(record.recordingId, "recordingId"),
    schemaVersion: 3,
    speakers: record.speakers.map(parseStoredSpeaker),
    startedAt: stringValue(record.startedAt, "startedAt"),
    status: record.status,
  };
}

export function parseAbortedRecordingState(input: unknown): AbortedRecordingState {
  const state = parseRecordingSpoolState(input);
  if (state.status !== "aborted" || state.endedAt === undefined) {
    throw new RecordingIngressError("corrupt-spool", "aborted receipt is not terminal");
  }
  return { ...state, endedAt: state.endedAt, status: "aborted" };
}

export function parseCompletedRecordingState(input: unknown): CompletedRecordingState {
  const record = objectValue(input);
  const recording = objectValue(record.recording);
  if (
    (record.schemaVersion !== 2 &&
      record.schemaVersion !== 3 &&
      record.schemaVersion !== 4 &&
      record.schemaVersion !== 5) ||
    !Array.isArray(record.events) ||
    !Array.isArray(record.authoritativeTracks) ||
    !Array.isArray(recording.speakerAudio)
  ) {
    throw new RecordingIngressError(
      "corrupt-spool",
      "completion receipt does not contain immutable authoritative track identities",
    );
  }
  const authoritativeTracks = record.authoritativeTracks.map(parseStoredAuthoritativeTrack);
  const actors = parseActorRoster(record.actors);
  const identityProvenance = parseIdentityProvenance(record.identityProvenance);
  const protocolVersion = lifecycleSchemaVersion(record.lifecycleSchemaVersion, 1);
  if (protocolVersion !== 1 && actors === null) {
    throw new RecordingIngressError("corrupt-spool", "actor completion receipt is missing actors");
  }
  if ((protocolVersion === 3) !== (identityProvenance !== null)) {
    throw new RecordingIngressError(
      "corrupt-spool",
      "completion lifecycle generation and identity provenance do not match",
    );
  }
  const speakerAudio = recording.speakerAudio.map((value) => {
    const reference = objectValue(value);
    if (!Number.isSafeInteger(reference.timelineOffsetMs) || (reference.timelineOffsetMs as number) < 0) {
      throw new RecordingIngressError("corrupt-spool", "invalid completion timeline offset");
    }
    return {
      audioLocator: stringValue(reference.audioLocator, "audioLocator"),
      speakerId: stringValue(reference.speakerId, "speakerId"),
      timelineOffsetMs: reference.timelineOffsetMs as number,
    };
  });
  const authoritativeDurationMs = parseCompletedAuthoritativeDuration(
    recording.authoritativeDurationMs,
    record.schemaVersion === 5,
  );
  const recordingId = stringValue(record.recordingId, "recordingId");
  if (recording.recordingId !== recordingId) {
    throw new RecordingIngressError("corrupt-spool", "completion recording identity does not match");
  }
  assertCompletedTrackIdentity(authoritativeTracks, speakerAudio);
  assertTrackActors(actors, speakerAudio);
  return {
    authoritativeTracks,
    actors,
    channelId: stringValue(record.channelId, "channelId"),
    events: record.events.map(parseStoredEvent),
    finalEventDigest: stringValue(record.finalEventDigest, "finalEventDigest"),
    finalEventId: stringValue(record.finalEventId, "finalEventId"),
    guildId: stringValue(record.guildId, "guildId"),
    identityProvenance,
    lifecycleSchemaVersion: protocolVersion,
    recording: {
      ...(authoritativeDurationMs === undefined
        ? {}
        : { authoritativeDurationMs }),
      manifestLocator: stringValue(recording.manifestLocator, "manifestLocator"),
      recordingId: stringValue(recording.recordingId, "recording.recordingId"),
      speakerAudio,
    },
    recordingId,
    schemaVersion: 5,
  };
}

function assertTrackActors(
  actors: readonly StoredActor[] | null,
  speakerAudio: readonly { readonly speakerId: string }[],
): void {
  if (actors === null) {
    return;
  }
  const actorIds = new Set(actors.map((actor) => actor.actorId));
  if (speakerAudio.some((track) => !actorIds.has(track.speakerId))) {
    throw new RecordingIngressError(
      "corrupt-spool",
      "completion receipt has a track without authoritative actor identity",
    );
  }
}

function assertCompletedTrackIdentity(
  tracks: readonly StoredAuthoritativeTrack[],
  speakerAudio: readonly {
    readonly audioLocator: string;
    readonly speakerId: string;
    readonly timelineOffsetMs: number;
  }[],
): void {
  if (tracks.length !== speakerAudio.length) {
    throw new RecordingIngressError(
      "corrupt-spool",
      "completion receipt track identity does not match the recording snapshot",
    );
  }
  const referencesBySpeaker = new Map<string, (typeof speakerAudio)[number]>();
  const uploadIds = new Set<string>();
  const trackNumbers = new Set<number>();
  for (const reference of speakerAudio) {
    if (referencesBySpeaker.has(reference.speakerId)) {
      throw new RecordingIngressError("corrupt-spool", "completion receipt repeats a speaker");
    }
    referencesBySpeaker.set(reference.speakerId, reference);
  }
  for (const track of tracks) {
    if (uploadIds.has(track.uploadId) || trackNumbers.has(track.trackNumber)) {
      throw new RecordingIngressError("corrupt-spool", "completion receipt repeats a track identity");
    }
    uploadIds.add(track.uploadId);
    trackNumbers.add(track.trackNumber);
    const reference = referencesBySpeaker.get(track.speakerId);
    if (
      reference === undefined ||
      reference.audioLocator !== track.audioLocator ||
      reference.timelineOffsetMs !== track.timelineOffsetMs
    ) {
      throw new RecordingIngressError(
        "corrupt-spool",
        "completion receipt track identity does not match the recording snapshot",
      );
    }
  }
}
