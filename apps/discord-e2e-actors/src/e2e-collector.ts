import {
  retainedE2eEvidenceV3Schema,
  sameDeploymentProvenance,
  type RetainedE2eEvidenceV3,
} from "./e2e-evidence.js";
import {
  assertDiscordReference,
  assertExactDiscordProjection,
  createMeetingDiscordProjectionKey,
  parseDiscordPublication,
  projectionMarker,
  toEvidenceContainer,
} from "./e2e-discord-projection-inspection.js";
import type {
  CollectEvidenceInput,
  DeploymentEvidenceProbe,
  DiscordEvidenceProbe,
} from "./e2e-retained-evidence-contracts.js";
import {
  assertExactDatabaseCounts,
  assertS3MatchesSnapshot,
  bindActorRun,
  normalizeDatabase,
  parseUnboundActorRun,
} from "./e2e-retained-evidence-snapshot.js";

export type {
  CollectEvidenceInput,
  DatabaseObservation,
  DeploymentEvidenceProbe,
  DiscordEvidenceProbe,
  DiscordProjectionContainerObservation,
  DiscordProjectionMessageObservation,
  DiscordProjectionObservation,
  ReplayJobEvidence,
  S3RecordingEvidence,
} from "./e2e-retained-evidence-contracts.js";

export async function collectRetainedE2eEvidence(
  input: CollectEvidenceInput,
  deployment: DeploymentEvidenceProbe,
  discord: DiscordEvidenceProbe,
): Promise<RetainedE2eEvidenceV3> {
  const unboundActorRun = parseUnboundActorRun(input.actorRun);
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
  const publication = parseDiscordPublication(
    snapshot.publication.externalPublicationId,
    snapshot.publicationTargetId,
  );
  const projectionKey = await createMeetingDiscordProjectionKey(
    snapshot.meetingId,
    snapshot.publicationTargetId,
  );
  const marker = await projectionMarker(projectionKey);
  const [s3, beforeDiscord] = await Promise.all([
    deployment.collectS3(snapshot.recording.manifestLocator, input.recordingId),
    discord.inspect(snapshot.publicationTargetId, marker),
  ]);
  assertS3MatchesSnapshot(s3, snapshot);
  const beforeMessage = assertDiscordReference(beforeDiscord, publication);
  assertExactDiscordProjection(beforeDiscord, publication, "before replay");
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
  const replayPublication = parseDiscordPublication(
    replaySnapshot.publication.externalPublicationId,
    replaySnapshot.publicationTargetId,
  );
  const afterMessage = assertDiscordReference(afterDiscord, replayPublication);
  if (afterMessage.embedDescription !== beforeMessage.embedDescription) {
    throw new Error("Discord projection visible text changed after idempotent replay");
  }
  const recordingDurationMs = recordingDuration(s3);
  assertExactDiscordProjection(afterDiscord, replayPublication, "after replay");
  return retainedE2eEvidenceV3Schema.parse({
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
      container: toEvidenceContainer(publication),
      embedDescription: beforeMessage.embedDescription,
      matchingMessageCount: beforeDiscord.matchingMessages.length,
      matchingThreadCount: beforeDiscord.matchingThreadIds.length,
      messageId: publication.messageId,
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
      container: toEvidenceContainer(replayPublication),
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
      transcriptId: replaySnapshot.transcript.transcriptId,
    },
    schemaVersion: 3,
    stages: [
      { ...snapshot.transcriptionStage, stage: "transcription" },
      { ...snapshot.summaryStage, stage: "summary" },
      { ...snapshot.publicationStage, stage: "publication" },
    ],
    summary: snapshot.summary,
    transcript: snapshot.transcript,
  });
}

function recordingDuration(s3: { readonly tracks: readonly { readonly durationMs: number; readonly timelineOffsetMs: number }[] }): number {
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
  return recordingDurationMs;
}
