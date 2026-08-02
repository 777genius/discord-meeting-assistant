import { z } from "zod";

import {
  actorRunEvidenceV1Schema,
  retainedE2eEvidenceV2Schema,
  sameDeploymentProvenance,
  unboundActorRunEvidenceV1Schema,
  type ActorRunEvidenceV1,
  type DeploymentProvenance,
  type RetainedE2eEvidenceV2,
  type UnboundActorRunEvidenceV1,
} from "./e2e-evidence.js";

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

type CollectedMeetingSnapshot = z.infer<typeof meetingSnapshotSchema>;

export interface DatabaseObservation {
  readonly matchingMeetingCount: number;
  readonly matchingRecordingCount: number;
  readonly matchingSummaryCount: number;
  readonly matchingTranscriptCount: number;
  readonly snapshot: unknown;
}

interface S3TrackEvidence {
  readonly checksumSha256: string;
  readonly durationMs: number;
  readonly locator: string;
  readonly sizeBytes: number;
  readonly speakerId: string;
  readonly timelineOffsetMs: number;
}

export interface S3RecordingEvidence {
  readonly endedAt: string;
  readonly manifestChecksumSha256: string;
  readonly manifestLocator: string;
  readonly recordingId: string;
  readonly sourceChecksumSha256: string;
  readonly startedAt: string;
  readonly tracks: readonly S3TrackEvidence[];
}

export interface ReplayJobEvidence {
  readonly afterProcessedOn: number;
  readonly beforeProcessedOn: number;
  readonly jobId: string;
  readonly state: "completed";
}

export interface DeploymentEvidenceProbe {
  collectDatabase(recordingId: string): Promise<DatabaseObservation>;
  collectProvenance(): Promise<DeploymentProvenance>;
  collectS3(manifestLocator: string, recordingId: string): Promise<S3RecordingEvidence>;
  replayPostCall(meetingId: string): Promise<ReplayJobEvidence>;
}

export interface DiscordProjectionObservation {
  readonly matchingMessages: readonly DiscordProjectionMessageObservation[];
  readonly matchingThreadIds: readonly string[];
}

export interface DiscordProjectionMessageObservation {
  readonly embedDescription: string;
  readonly messageId: string;
}

export interface DiscordEvidenceProbe {
  inspect(parentChannelId: string, marker: string): Promise<DiscordProjectionObservation>;
}

export interface CollectEvidenceInput {
  readonly actorRun: unknown;
  readonly recordingId: string;
  readonly runId: string;
}

export async function collectRetainedE2eEvidence(
  input: CollectEvidenceInput,
  deployment: DeploymentEvidenceProbe,
  discord: DiscordEvidenceProbe,
): Promise<RetainedE2eEvidenceV2> {
  const unboundActorRun = unboundActorRunEvidenceV1Schema.parse(input.actorRun);
  if (unboundActorRun.runId !== input.runId) {
    throw new Error("Actor evidence does not match the requested run correlation");
  }

  const provenanceBefore = await deployment.collectProvenance();
  const before = normalizeDatabase(await deployment.collectDatabase(input.recordingId));
  assertExactDatabaseCounts(before, "before replay");
  const snapshot = before.snapshot;
  if (snapshot.meetingId !== input.recordingId || snapshot.recording.recordingId !== input.recordingId) {
    throw new Error("Postgres snapshot is not correlated to the requested recording");
  }
  const publication = parsePublication(snapshot.publication.externalPublicationId);
  const marker = await projectionMarker(snapshot.publication.idempotencyKey);
  const [s3, beforeDiscord] = await Promise.all([
    deployment.collectS3(snapshot.recording.manifestLocator, input.recordingId),
    discord.inspect(snapshot.publicationTargetId, marker),
  ]);
  assertS3MatchesSnapshot(s3, snapshot);
  const beforeMessage = assertDiscordReference(beforeDiscord, publication);
  if (
    beforeDiscord.matchingThreadIds.length !== 1 ||
    beforeDiscord.matchingMessages.length !== 1
  ) {
    throw new Error("Discord projection is not exact-one before replay");
  }
  const actorRun = bindActorRun(unboundActorRun, input.recordingId, s3);

  const replayJob = await deployment.replayPostCall(snapshot.meetingId);
  if (replayJob.afterProcessedOn <= replayJob.beforeProcessedOn) {
    throw new Error("Replay job did not complete a later real processing attempt");
  }
  const after = normalizeDatabase(await deployment.collectDatabase(input.recordingId));
  const afterDiscord = await discord.inspect(snapshot.publicationTargetId, marker);
  const provenanceAfter = await deployment.collectProvenance();
  if (!sameDeploymentProvenance(provenanceBefore, provenanceAfter)) {
    throw new Error("Deployment provenance changed while retained evidence was collected");
  }
  const replaySnapshot = after.snapshot;
  const replayPublication = parsePublication(replaySnapshot.publication.externalPublicationId);
  const afterMessage = assertDiscordReference(afterDiscord, replayPublication);
  if (afterMessage.embedDescription !== beforeMessage.embedDescription) {
    throw new Error("Discord projection visible text changed after idempotent replay");
  }

  if (s3.tracks.length === 0) {
    throw new Error("Authoritative S3 manifest has no speaker tracks");
  }
  const recordingMediaOriginMs = Math.min(
    ...s3.tracks.map(({ timelineOffsetMs }) => timelineOffsetMs),
  );
  const recordingDurationMs = recordingMediaOriginMs + Math.max(
    ...s3.tracks.map(({ durationMs }) => durationMs),
  );
  if (!Number.isSafeInteger(recordingDurationMs)) {
    throw new Error("Authoritative S3 recording duration is outside the safe range");
  }
  return retainedE2eEvidenceV2Schema.parse({
    actorRun,
    deployment: provenanceBefore,
    database: {
      matchingMeetingCount: before.matchingMeetingCount,
      matchingRecordingCount: before.matchingRecordingCount,
      matchingSummaryCount: before.matchingSummaryCount,
      matchingTranscriptCount: before.matchingTranscriptCount,
    },
    fixtureManifestVersion: 1,
    fixtureSetId: actorRun.fixtureSetId,
    fixtures: actorRun.fixtures.map((fixture) => ({ ...fixture, codec: "opus" })),
    meetingId: snapshot.meetingId,
    publication: {
      embedDescription: beforeMessage.embedDescription,
      matchingMessageCount: beforeDiscord.matchingMessages.length,
      matchingThreadCount: beforeDiscord.matchingThreadIds.length,
      messageId: publication.messageId,
      threadId: publication.threadId,
    },
    recording: {
      durationMs: recordingDurationMs,
      endedAt: s3.endedAt,
      recordingId: snapshot.recording.recordingId,
      s3: {
        manifestChecksumSha256: s3.manifestChecksumSha256,
        manifestLocator: s3.manifestLocator,
        sourceChecksumSha256: s3.sourceChecksumSha256,
        tracks: s3.tracks,
      },
      speakerIds: s3.tracks.map(({ speakerId }) => speakerId),
      startedAt: s3.startedAt,
    },
    replay: {
      matchingMeetingCount: after.matchingMeetingCount,
      matchingMessageCount: afterDiscord.matchingMessages.length,
      matchingRecordingCount: after.matchingRecordingCount,
      matchingSummaryCount: after.matchingSummaryCount,
      matchingThreadCount: afterDiscord.matchingThreadIds.length,
      matchingTranscriptCount: after.matchingTranscriptCount,
      meetingId: replaySnapshot.meetingId,
      messageId: replayPublication.messageId,
      recordingId: replaySnapshot.recording.recordingId,
      replayJob,
      summaryId: replaySnapshot.summary.summaryId,
      threadId: replayPublication.threadId,
      transcriptId: replaySnapshot.transcript.transcriptId,
    },
    schemaVersion: 2,
    stages: [
      { ...snapshot.transcriptionStage, stage: "transcription" },
      { ...snapshot.summaryStage, stage: "summary" },
      { ...snapshot.publicationStage, stage: "publication" },
    ],
    summary: snapshot.summary,
    transcript: snapshot.transcript,
  });
}

function normalizeDatabase(observation: DatabaseObservation): Omit<DatabaseObservation, "snapshot"> & {
  readonly snapshot: CollectedMeetingSnapshot;
} {
  for (const [name, count] of Object.entries(observation).filter(([key]) => key !== "snapshot")) {
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new Error(`Postgres ${name} is not a safe count`);
    }
  }
  return { ...observation, snapshot: meetingSnapshotSchema.parse(observation.snapshot) };
}

function assertExactDatabaseCounts(
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

function bindActorRun(
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

function assertS3MatchesSnapshot(
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

function assertDiscordReference(
  observation: DiscordProjectionObservation,
  reference: { readonly messageId: string; readonly threadId: string },
): DiscordProjectionMessageObservation {
  const message = observation.matchingMessages.find(({ messageId }) =>
    messageId === reference.messageId
  );
  if (!observation.matchingThreadIds.includes(reference.threadId) || message === undefined) {
    throw new Error("Discord publication receipt is absent from the marker scan");
  }
  return message;
}

function parsePublication(value: string): { readonly messageId: string; readonly threadId: string } {
  const match = /^discord:v1:thread:([^:]+):message:([^:]+)$/u.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error("Postgres publication receipt is not a Discord v1 reference");
  }
  return { messageId: match[2], threadId: match[1] };
}

async function projectionMarker(idempotencyKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(idempotencyKey));
  return `meeting-projection:${Buffer.from(digest).toString("hex").slice(0, 20)}`;
}
