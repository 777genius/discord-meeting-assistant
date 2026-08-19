import type {
  AuthoritativeTrackUploadMetadata,
} from "@discord-meeting/craig-gateway-contracts";

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
  verifyWriteReceipt,
} from "./recording-ingress-invariants.js";
import { RecordingIngressRuntime } from "./recording-ingress-runtime.js";
import {
  spoolToken,
  type CompletedRecordingState,
  type RecordingSpoolState,
  type StoredAuthoritativeTrack,
} from "./spool.js";

function requireImmutableArtifactVersionId(versionId: string | null | undefined): string {
  if (typeof versionId !== "string" || versionId.length === 0 || versionId === "null") {
    throw new RecordingIngressError(
      "artifact-write-mismatch",
      "artifact writer did not confirm an immutable object version",
    );
  }
  return versionId;
}

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
    return completedTrackResult(upload, track, true);
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
    return completedTrackResult(upload, existing.track, true);
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
  const completedTrack = {
    ...candidate,
    artifactVersionId: requireImmutableArtifactVersionId(receipt.versionId),
  };
  await runtime.spool.writeRecording({
    ...pendingState,
    authoritativeTracks: [...pendingState.authoritativeTracks, completedTrack]
      .toSorted((left, right) => left.trackNumber - right.trackNumber),
    pendingAuthoritativeTracks: pendingState.pendingAuthoritativeTracks.filter(
      ({ uploadId }) => uploadId !== candidate.uploadId,
    ),
  });
  return completedTrackResult(upload, completedTrack, existing !== undefined);
}

function createTrackCandidate(upload: AuthoritativeTrackUpload): StoredAuthoritativeTrack {
  return {
    artifactVersionId: null,
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
  track: StoredAuthoritativeTrack,
  replayed: boolean,
): AuthoritativeTrackIngressResult {
  const versionId = requireImmutableArtifactVersionId(track.artifactVersionId);
  return {
    checksumSha256: track.checksumSha256,
    locator: track.audioLocator,
    recordingId: upload.identity.recordingId,
    replayed,
    sizeBytes: track.sizeBytes,
    speakerId: upload.speakerId,
    trackNumber: track.trackNumber,
    uploadId: track.uploadId,
    versionId,
  };
}
