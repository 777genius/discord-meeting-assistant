import type {
  AuthoritativeTrackUploadMetadata,
  CraigLifecycleEvent,
} from "@discord-meeting/craig-gateway-contracts";
import type { RecordingArtifactSnapshot } from "@discord-meeting/meeting-core";

import type {
  AuthoritativeTrackIngressResult,
  RecordingBinaryArtifactWriteRequest,
} from "./contracts.js";
import { RecordingIngressError } from "./errors.js";
import {
  abortIfRequested,
  ensureRecordingIdentity,
  requireIdentifier,
  requireSnowflake,
  sha256,
  verifyWriteReceipt,
} from "./recording-ingress-invariants.js";
import { RecordingIngressRuntime } from "./recording-ingress-runtime.js";
import {
  spoolToken,
  type CompletedRecordingState,
  type RecordingSpoolState,
  type StoredAuthoritativeTrack,
} from "./spool.js";

export type AuthoritativeReadyEvent = Extract<
  CraigLifecycleEvent,
  { readonly type: "recording.authoritative_ready" }
>;

interface AuthoritativeTrackUpload {
  readonly identity: {
    readonly channelId: string;
    readonly guildId: string;
    readonly recordingId: string;
  };
  readonly metadata: AuthoritativeTrackUploadMetadata;
  readonly request: RecordingBinaryArtifactWriteRequest;
  readonly speakerId: string;
}

export async function ingestAuthoritativeTrack(
  runtime: RecordingIngressRuntime,
  metadata: AuthoritativeTrackUploadMetadata,
  body: AsyncIterable<Uint8Array>,
  options: { readonly signal?: AbortSignal } = {},
): Promise<AuthoritativeTrackIngressResult> {
  abortIfRequested(options.signal);
  const upload = createTrackUpload({ body, metadata, runtime, signal: options.signal });
  return runtime.exclusive(
    upload.identity.recordingId,
    async () => {
      abortIfRequested(options.signal);
      return ingestLockedAuthoritativeTrack(runtime, upload);
    },
  );
}

function createTrackUpload(input: {
  readonly body: AsyncIterable<Uint8Array>;
  readonly metadata: AuthoritativeTrackUploadMetadata;
  readonly runtime: RecordingIngressRuntime;
  readonly signal: AbortSignal | undefined;
}): AuthoritativeTrackUpload {
  const recordingId = requireIdentifier(input.metadata.recordingId, "track.recordingId");
  const identity = {
    channelId: requireSnowflake(input.metadata.channelId, "track.channelId"),
    guildId: requireSnowflake(input.metadata.guildId, "track.guildId"),
    recordingId,
  };
  const speakerId = requireSnowflake(input.metadata.speakerId, "track.speakerId");
  const recordingToken = spoolToken("recording-v1", recordingId);
  const locator =
    `${input.runtime.artifactLocatorPrefix}/${recordingToken}/authoritative/speakers/${speakerId}.ogg`;
  const request: RecordingBinaryArtifactWriteRequest = {
    body: input.body,
    checksumSha256: input.metadata.checksumSha256,
    contentType: "audio/ogg",
    locator,
    metadata: {
      "recording-token": recordingToken,
      "source-kind": "craig-original-multitrack",
      "speaker-id": speakerId,
      "track-number": String(input.metadata.trackNumber),
    },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    sizeBytes: input.metadata.sizeBytes,
  };
  return {
    identity,
    metadata: input.metadata,
    request,
    speakerId,
  };
}

async function ingestLockedAuthoritativeTrack(
  runtime: RecordingIngressRuntime,
  upload: AuthoritativeTrackUpload,
): Promise<AuthoritativeTrackIngressResult> {
  const { identity, request } = upload;
  const completed = await runtime.spool.readCompleted(identity.recordingId);
  if (completed !== undefined) {
    ensureRecordingIdentity(completed, identity);
    const track = completedTrackForUpload(completed, createTrackCandidate(upload));
    return completedTrackResult(upload, track.audioLocator, true);
  }
  const aborted = await runtime.spool.readAborted(identity.recordingId);
  if (aborted !== undefined) {
    ensureRecordingIdentity(aborted, identity);
    await runtime.spool.cleanupActive(identity.recordingId);
    throw new RecordingIngressError(
      "invalid-state",
      "cannot upload an authoritative track for an aborted recording",
    );
  }
  const state = await runtime.spool.readRecording(identity.recordingId);
  if (state === undefined) {
    throw new RecordingIngressError(
      "invalid-state",
      "meeting.started must precede authoritative track upload",
    );
  }
  ensureRecordingIdentity(state, identity);
  if (state.status === "aborted") {
    await runtime.spool.archiveAborted(state);
    throw new RecordingIngressError(
      "invalid-state",
      "cannot upload an authoritative track for an aborted recording",
    );
  }
  const candidate = createTrackCandidate(upload);
  const existing = findExistingTrack(state, candidate, runtime.limits.maxSpeakersPerRecording);
  if (existing?.durability === "completed") {
    return completedTrackResult(upload, existing.track.audioLocator, true);
  }
  const pendingState = existing === undefined
    ? {
        ...state,
        pendingAuthoritativeTracks: [...state.pendingAuthoritativeTracks, candidate]
          .toSorted((left, right) => left.trackNumber - right.trackNumber),
      }
    : state;
  if (existing === undefined) {
    await runtime.spool.writeRecording(pendingState);
  }
  const receipt = await runtime.writer.write(request);
  verifyWriteReceipt(request, receipt);
  await runtime.spool.writeRecording({
    ...pendingState,
    authoritativeTracks: [...pendingState.authoritativeTracks, candidate]
      .toSorted((left, right) => left.trackNumber - right.trackNumber),
    pendingAuthoritativeTracks: pendingState.pendingAuthoritativeTracks.filter(
      ({ uploadId }) => uploadId !== candidate.uploadId,
    ),
  });
  return completedTrackResult(upload, receipt.locator, existing !== undefined);
}

function createTrackCandidate(upload: AuthoritativeTrackUpload): StoredAuthoritativeTrack {
  return {
    audioLocator: upload.request.locator,
    checksumSha256: upload.metadata.checksumSha256,
    sizeBytes: upload.metadata.sizeBytes,
    speakerId: upload.speakerId,
    timelineOffsetMs: upload.metadata.timelineOffsetMs,
    trackNumber: upload.metadata.trackNumber,
    uploadId: requireIdentifier(upload.metadata.uploadId, "track.uploadId"),
  };
}

function findExistingTrack(
  state: RecordingSpoolState,
  candidate: StoredAuthoritativeTrack,
  maxSpeakers: number,
): { readonly durability: "completed" | "pending"; readonly track: StoredAuthoritativeTrack } | undefined {
  const matches = [
    ...state.authoritativeTracks.map((track) => ({ durability: "completed" as const, track })),
    ...state.pendingAuthoritativeTracks.map((track) => ({ durability: "pending" as const, track })),
  ].filter(({ track }) =>
    track.uploadId === candidate.uploadId ||
    track.trackNumber === candidate.trackNumber ||
    track.speakerId === candidate.speakerId,
  );
  if (matches.some(({ track }) => !sameTrackIdentity(track, candidate))) {
    throw new RecordingIngressError(
      "conflicting-duplicate",
      "authoritative track identity was replayed with different content",
    );
  }
  if (matches.length > 1) {
    throw new RecordingIngressError(
      "corrupt-spool",
      "authoritative track identity exists in multiple durability states",
    );
  }
  if (
    matches.length === 0 &&
    state.authoritativeTracks.length + state.pendingAuthoritativeTracks.length >= maxSpeakers
  ) {
    throw new RecordingIngressError(
      "limit-exceeded",
      "authoritative recording exceeds the configured speaker limit",
    );
  }
  return matches[0];
}

function completedTrackForUpload(
  completed: CompletedRecordingState,
  candidate: StoredAuthoritativeTrack,
): StoredAuthoritativeTrack {
  const matchingTracks = completed.authoritativeTracks.filter(
    (track) =>
      track.uploadId === candidate.uploadId ||
      track.trackNumber === candidate.trackNumber ||
      track.speakerId === candidate.speakerId,
  );
  if (matchingTracks.length === 0) {
    throw new RecordingIngressError(
      "invalid-state",
      "cannot append an authoritative track after the recording is finalized",
    );
  }
  if (matchingTracks.length > 1) {
    throw new RecordingIngressError(
      "corrupt-spool",
      "completion receipt has ambiguous authoritative track identities",
    );
  }
  const [track] = matchingTracks;
  if (track === undefined) {
    throw new RecordingIngressError("corrupt-spool", "completion receipt track identity is missing");
  }
  if (!sameTrackIdentity(track, candidate)) {
    throw new RecordingIngressError(
      "conflicting-duplicate",
      "authoritative track identity was replayed with different content",
    );
  }
  return track;
}

function sameTrackIdentity(
  left: StoredAuthoritativeTrack,
  right: StoredAuthoritativeTrack,
): boolean {
  return (
    left.audioLocator === right.audioLocator &&
    left.checksumSha256 === right.checksumSha256 &&
    left.sizeBytes === right.sizeBytes &&
    left.speakerId === right.speakerId &&
    left.timelineOffsetMs === right.timelineOffsetMs &&
    left.trackNumber === right.trackNumber &&
    left.uploadId === right.uploadId
  );
}

function completedTrackResult(
  upload: AuthoritativeTrackUpload,
  locator: string,
  replayed: boolean,
): AuthoritativeTrackIngressResult {
  return {
    locator,
    recordingId: upload.identity.recordingId,
    replayed,
    speakerId: upload.speakerId,
  };
}

export async function finalizeAuthoritative(
  runtime: RecordingIngressRuntime,
  state: RecordingSpoolState,
  event: AuthoritativeReadyEvent,
  signal?: AbortSignal,
): Promise<RecordingArtifactSnapshot> {
  abortIfRequested(signal);
  assertReadyToFinalize(state, event);
  const tracks = orderedTracks(state);
  const request = createManifestRequest(runtime, state, event, tracks, signal);
  const receipt = await runtime.writer.write(request);
  verifyWriteReceipt(request, receipt);
  const recording = createRecordingSnapshot(state, tracks, receipt.locator);
  await persistCompleted(runtime, state, recording, tracks);
  return recording;
}

function assertReadyToFinalize(state: RecordingSpoolState, event: AuthoritativeReadyEvent): void {
  if (
    state.status !== "finalizing" ||
    state.endedAt === undefined ||
    state.finalEventId !== event.eventId ||
    state.finalEventDigest === undefined ||
    state.authoritativeTracks.length !== event.trackCount ||
    state.pendingAuthoritativeTracks.length > 0
  ) {
    throw new RecordingIngressError(
      "invalid-state",
      "authoritative recording is not ready to finalize",
    );
  }
}

function orderedTracks(state: RecordingSpoolState): readonly StoredAuthoritativeTrack[] {
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
  return tracks;
}

function createManifestRequest(
  runtime: RecordingIngressRuntime,
  state: RecordingSpoolState,
  event: AuthoritativeReadyEvent,
  tracks: readonly StoredAuthoritativeTrack[],
  signal?: AbortSignal,
): RecordingBinaryArtifactWriteRequest {
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
  const body = new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);
  const recordingToken = spoolToken("recording-v1", state.recordingId);
  return {
    body,
    checksumSha256: sha256(body),
    contentType: "application/json",
    locator: `${runtime.artifactLocatorPrefix}/${recordingToken}/authoritative/manifest.json`,
    metadata: {
      "recording-token": recordingToken,
      "source-kind": "craig-original-multitrack",
    },
    ...(signal === undefined ? {} : { signal }),
    sizeBytes: body.byteLength,
  };
}

function createRecordingSnapshot(
  state: RecordingSpoolState,
  tracks: readonly StoredAuthoritativeTrack[],
  manifestLocator: string,
): RecordingArtifactSnapshot {
  return {
    manifestLocator,
    recordingId: state.recordingId,
    speakerAudio: tracks.map((track) => ({
      audioLocator: track.audioLocator,
      speakerId: track.speakerId,
      timelineOffsetMs: track.timelineOffsetMs,
    })),
  };
}

async function persistCompleted(
  runtime: RecordingIngressRuntime,
  state: RecordingSpoolState,
  recording: RecordingArtifactSnapshot,
  authoritativeTracks: readonly StoredAuthoritativeTrack[],
): Promise<void> {
  if (state.finalEventDigest === undefined || state.finalEventId === undefined) {
    throw new RecordingIngressError("corrupt-spool", "final event evidence is missing");
  }
  const completed: CompletedRecordingState = {
    authoritativeTracks,
    channelId: state.channelId,
    events: state.events,
    finalEventDigest: state.finalEventDigest,
    finalEventId: state.finalEventId,
    guildId: state.guildId,
    recording,
    recordingId: state.recordingId,
    schemaVersion: 2,
  };
  await runtime.spool.writeCompleted(completed);
  await runtime.cleanupAfterSuccess(state.recordingId);
}
