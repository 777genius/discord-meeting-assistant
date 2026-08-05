import { z } from "zod";

import {
  actorRunEvidenceV1Schema,
  unboundActorRunEvidenceV1Schema,
  type ActorRunEvidenceV1,
  type UnboundActorRunEvidenceV1,
} from "./e2e-evidence.js";
import type {
  DatabaseObservation,
  S3RecordingEvidence,
} from "./e2e-retained-evidence-contracts.js";

const identifier = z.string().trim().min(1);
const sha256 = z.string().regex(/^[a-f\d]{64}$/u);
const stage = z.object({
  attempts: z.number().int().positive(),
  status: z.literal("succeeded"),
});

const meetingSnapshotSchema = z.object({
  meetingId: identifier,
  publication: z.object({
    externalPublicationId: identifier,
    idempotencyKey: identifier,
  }),
  publicationStage: stage,
  publicationTargetId: identifier,
  recording: z.object({
    manifestLocator: identifier,
    recordingId: identifier,
    speakerAudio: z.array(z.object({
      audioLocator: identifier,
      speakerId: identifier,
      timelineOffsetMs: z.number().int().nonnegative(),
    })).min(1),
  }),
  revision: z.number().int().nonnegative(),
  summary: z.object({
    actionItems: z.array(z.object({
      actionItemId: identifier,
      deadline: identifier.nullable(),
      evidenceTurnIds: z.array(identifier).min(1),
      ownerSpeakerId: identifier.nullable(),
      text: identifier,
    }).strict()),
    decisions: z.array(z.object({
      decisionId: identifier,
      evidenceTurnIds: z.array(identifier).min(1),
      text: identifier,
    }).strict()),
    openQuestions: z.array(z.object({
      evidenceTurnIds: z.array(identifier).min(1),
      id: identifier,
      text: identifier,
    }).strict()),
    overview: identifier,
    summaryId: identifier,
    title: identifier,
    topics: z.array(z.object({
      evidenceTurnIds: z.array(identifier).min(1),
      points: z.array(identifier).min(1),
      title: identifier,
    }).strict()),
    transcriptId: identifier,
    version: z.number().int().positive(),
  }).strict(),
  summaryStage: stage,
  transcript: z.object({
    transcriptId: identifier,
    turns: z.array(z.object({
      endMs: z.number().int().nonnegative(),
      speakerId: identifier,
      startMs: z.number().int().nonnegative(),
      text: identifier,
      turnId: identifier,
    })).min(1),
  }),
  transcriptionStage: stage,
}).loose();

export type CollectedMeetingSnapshot = z.infer<typeof meetingSnapshotSchema>;

export function normalizeDatabase(
  observation: DatabaseObservation,
): Omit<DatabaseObservation, "snapshot"> & { readonly snapshot: CollectedMeetingSnapshot } {
  for (const [name, count] of Object.entries(observation).filter(([key]) => key !== "snapshot")) {
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new Error(`Postgres ${name} is not a safe count`);
    }
  }
  return { ...observation, snapshot: meetingSnapshotSchema.parse(observation.snapshot) };
}

export function assertExactDatabaseCounts(
  observation: DatabaseObservation,
  phase: string,
): void {
  const counts = [
    observation.matchingMeetingCount,
    observation.matchingRecordingCount,
    observation.matchingSummaryCount,
    observation.matchingTranscriptCount,
  ];
  if (counts.some((count) => count !== 1)) {
    throw new Error(`Postgres business identities are not exact-one ${phase}`);
  }
}

export function bindActorRun(
  unbound: UnboundActorRunEvidenceV1,
  recordingId: string,
  s3: S3RecordingEvidence,
): ActorRunEvidenceV1 {
  const startedAt = Date.parse(s3.startedAt);
  const endedAt = Date.parse(s3.endedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt <= startedAt) {
    throw new Error("Authoritative manifest has an invalid recording window");
  }
  const events = unbound.events.map((event) => {
    if (event.atEpochMs < startedAt || event.atEpochMs > endedAt + 5_000) {
      throw new Error("Actor event is outside the authoritative recording window");
    }
    const { atEpochMs, ...rest } = event;
    return { ...rest, atRecordingMs: atEpochMs - startedAt };
  });
  return actorRunEvidenceV1Schema.parse({
    ...unbound,
    events,
    recordingId,
    timelineOrigin: "actor-run-start-correlated-to-recording-id",
  });
}

export function assertS3MatchesSnapshot(
  s3: S3RecordingEvidence,
  snapshot: CollectedMeetingSnapshot,
): void {
  if (
    s3.recordingId !== snapshot.recording.recordingId ||
    s3.manifestLocator !== snapshot.recording.manifestLocator ||
    !sha256.safeParse(s3.manifestChecksumSha256).success ||
    !sha256.safeParse(s3.sourceChecksumSha256).success
  ) {
    throw new Error("S3 manifest does not match the Postgres recording snapshot");
  }
  const snapshotTracks = new Map(
    snapshot.recording.speakerAudio.map((track) => [track.speakerId, track]),
  );
  for (const track of s3.tracks) {
    const expected = snapshotTracks.get(track.speakerId);
    if (
      expected === undefined ||
      expected.audioLocator !== track.locator ||
      expected.timelineOffsetMs !== track.timelineOffsetMs ||
      !sha256.safeParse(track.checksumSha256).success
    ) {
      throw new Error(`S3 track ${track.speakerId} does not match the Postgres snapshot`);
    }
  }
  if (s3.tracks.length !== snapshotTracks.size) {
    throw new Error("S3 track count does not match the Postgres snapshot");
  }
}

export function parseUnboundActorRun(value: unknown): UnboundActorRunEvidenceV1 {
  return unboundActorRunEvidenceV1Schema.parse(value);
}
