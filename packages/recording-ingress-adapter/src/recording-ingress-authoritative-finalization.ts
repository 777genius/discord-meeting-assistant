import type { CraigLifecycleEvent } from "@discord-meeting/craig-gateway-contracts";
import type { RecordingArtifactSnapshot } from "@discord-meeting/meeting-core/recording";

import type { RecordingBinaryArtifactWriteRequest } from "./contracts.js";
import { RecordingIngressError } from "./errors.js";
import {
  abortIfRequested,
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
  const actors = state.actors;
  if (actors !== null && tracks.some((track) =>
    !actors.some((actor) => actor.actorId === track.speakerId)
  )) {
    throw new RecordingIngressError(
      "invalid-state",
      "authoritative track has no actor in the durable roster",
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
    ...(state.actors === null
      ? {}
      : {
          actors: state.actors.map((actor) => ({
            actorId: actor.actorId,
            kind: actor.kind,
          })),
        }),
    ...(state.identityProvenance === null
      ? {}
      : { identityProvenance: { ...state.identityProvenance } }),
    channelId: state.channelId,
    endedAt: state.endedAt,
    guildId: state.guildId,
    recordingId: state.recordingId,
    schemaVersion: state.lifecycleSchemaVersion,
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
    authoritativeDurationMs: authoritativeDurationMs(state),
    manifestLocator,
    recordingId: state.recordingId,
    speakerAudio: tracks.map((track) => ({
      audioLocator: track.audioLocator,
      speakerId: track.speakerId,
      timelineOffsetMs: track.timelineOffsetMs,
    })),
  };
}

function authoritativeDurationMs(state: RecordingSpoolState): number {
  if (state.endedAt === undefined) {
    throw new RecordingIngressError("corrupt-spool", "recording end time is missing");
  }
  const startedAtMs = Date.parse(state.startedAt);
  const endedAtMs = Date.parse(state.endedAt);
  const durationMs = endedAtMs - startedAtMs;
  if (
    !Number.isSafeInteger(startedAtMs) ||
    !Number.isSafeInteger(endedAtMs) ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 0
  ) {
    throw new RecordingIngressError(
      "corrupt-spool",
      "recording lifecycle does not contain a valid authoritative duration",
    );
  }
  return durationMs;
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
    actors: state.actors,
    channelId: state.channelId,
    events: state.events,
    finalEventDigest: state.finalEventDigest,
    finalEventId: state.finalEventId,
    guildId: state.guildId,
    identityProvenance: state.identityProvenance,
    lifecycleSchemaVersion: state.lifecycleSchemaVersion,
    recording,
    recordingId: state.recordingId,
    schemaVersion: 5,
  };
  await runtime.spool.writeCompleted(completed);
  await runtime.cleanupAfterSuccess(state.recordingId);
}
