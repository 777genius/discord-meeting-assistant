import {
  conversationVoiceEvidenceV3Schema,
  retainedE2eEvidenceV6Schema,
  retainedE2eEvidenceV10Schema,
  sameDeploymentProvenance,
  type RetainedE2eEvidenceV6,
  type RetainedE2eEvidenceV10,
} from "./e2e-evidence.js";
import {
  assertDiscordReference,
  assertExactDiscordProjection,
  createMeetingDiscordFinalSummaryProjectionKey,
  createMeetingDiscordProjectionKey,
  findDiscordReference,
  parseDiscordPublication,
  projectionMarker,
  toEvidenceContainer,
} from "./e2e-discord-projection-inspection.js";
import type {
  DiscordPublicationReference,
} from "./e2e-discord-projection-inspection.js";
import { sameDiscordAttachments } from "./e2e-evidence-publication.js";
import type {
  CollectEvidenceInput,
  DeploymentEvidenceProbe,
  DiscordEvidenceProbe,
  DiscordProjectionMessageObservation,
  DiscordProjectionObservation,
  ReplayTargetAttestation,
  S3RecordingEvidence,
} from "./e2e-retained-evidence-contracts.js";
import {
  assertExactDatabaseCounts,
  alignS3TracksToSnapshot,
  bindActorRun,
  normalizeDatabase,
  parseUnboundActorRun,
} from "./e2e-retained-evidence-snapshot.js";
import { awaitTerminalPostCallEvidence } from "./post-call-evidence-readiness.js";
import { qualifyProviderlessVoiceDurability } from
  "./providerless-voice-durability-qualification.js";

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
): Promise<RetainedE2eEvidenceV10> {
  const unboundActorRun = parseUnboundActorRun(input.actorRun);
  const replayTarget = createReplayTargetAttestation(input, unboundActorRun);
  await deployment.assertReplayTargetSafe(replayTarget);
  const provenanceBefore = await deployment.collectProvenance();
  const before = normalizeDatabase(await awaitTerminalPostCallEvidence(
    () => deployment.collectDatabase(input.recordingId),
    input.recordingId,
  ));
  assertExactDatabaseCounts(before, "before replay");
  const snapshot = before.snapshot;
  if (snapshot.meetingId !== input.recordingId || snapshot.recording.recordingId !== input.recordingId) {
    throw new Error("Postgres snapshot is not correlated to the requested recording");
  }
  const publication = parseDiscordPublication(
    snapshot.publication.externalPublicationId, snapshot.publicationTargetId,
  );
  const [observedS3, locatedBeforeDiscord] = await Promise.all([
    deployment.collectS3(snapshot.recording, input.recordingId),
    inspectPublishedProjection(discord, snapshot.meetingId, snapshot.publicationTargetId, publication),
  ]);
  const { marker, message: beforeMessage, observation: beforeDiscord } = locatedBeforeDiscord;
  const s3 = alignS3TracksToSnapshot(observedS3, snapshot);
  assertExactDiscordProjection(beforeDiscord, publication, "before replay");
  const playbackContext = { deployment, input,
    meetingPlatformContainerId: provenanceBefore.meetingPlatform.containerId,
    message: beforeMessage, s3 };
  const recordingPlayback = await collectSafeRecordingPlaybackEvidence(playbackContext);
  const actorRun = bindActorRun(unboundActorRun, input.recordingId, s3);
  const processing = await deployment.collectProcessing(snapshot.meetingId, s3.startedAt);
  const replayJob = await deployment.replayPostCall(replayTarget);
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
    replaySnapshot.publication.externalPublicationId, replaySnapshot.publicationTargetId,
  );
  const afterMessage = assertDiscordReference(afterDiscord, replayPublication);
  if (afterMessage.embedDescription !== beforeMessage.embedDescription) {
    throw new Error("Discord projection visible text changed after idempotent replay");
  }
  if (afterMessage.recordingPlaybackUrl !== beforeMessage.recordingPlaybackUrl) {
    throw new Error("Discord recording playback capability changed after idempotent replay");
  }
  if (!sameDiscordAttachments(afterMessage.attachments, beforeMessage.attachments)) {
    throw new Error("Discord projection attachments changed after idempotent replay");
  }
  const recordingDurationMs = recordingDuration(s3);
  assertExactDiscordProjection(afterDiscord, replayPublication, "after replay");
  const baseEvidence = retainedE2eEvidenceV6Schema.parse({
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
      attachments: beforeMessage.attachments,
      container: toEvidenceContainer(publication),
      embedDescription: beforeMessage.embedDescription,
      matchingMessageCount: beforeDiscord.matchingMessages.length,
      matchingThreadCount: beforeDiscord.matchingThreadIds.length,
      messageId: publication.messageId,
    },
    processing,
    recording: {
      durationMs: recordingDurationMs,
      endedAt: s3.endedAt,
      recordingId: snapshot.recording.recordingId,
      s3: {
        manifestChecksumSha256: s3.manifestChecksumSha256,
        manifestLocator: s3.manifestLocator,
        manifestRevision: s3.manifestRevision,
        manifestSizeBytes: s3.manifestSizeBytes,
        sourceChecksumSha256: s3.sourceChecksumSha256,
        tracks: s3.tracks,
      },
      speakerIds: s3.tracks.map(({ speakerId }) => speakerId),
      startedAt: s3.startedAt,
    },
    recordingPlayback,
    replay: {
      attachments: afterMessage.attachments,
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
    schemaVersion: 6,
    stages: [
      { ...snapshot.transcriptionStage, stage: "transcription" },
      { ...snapshot.summaryStage, stage: "summary" },
      { ...snapshot.publicationStage, stage: "publication" },
    ],
    summary: snapshot.summary,
    transcript: snapshot.transcript,
  });
  const durabilityQualification = qualifyProviderlessVoiceDurability({
    release: input.release,
    sourceRevision: provenanceBefore.meetingPlatform.sourceRevision,
  });
  if (input.conversation === undefined) {
    return qualifyPostCallEvidence(baseEvidence, input, durabilityQualification);
  }
  const conversation = input.conversation;
  if (deployment.collectConversationLifecycle === undefined) {
    throw new Error("Deployment probe cannot collect conversation lifecycle evidence");
  }
  const lifecycleEvidence = await deployment.collectConversationLifecycle(
    snapshot.meetingId,
    s3.startedAt,
  );
  const { participantLifecycleReceipts, ...lifecycle } = lifecycleEvidence;
  const reconnectNoRepeat = createReconnectNoRepeatEvidence(
    participantLifecycleReceipts, conversation.reconnectParticipantId, s3.endedAt,
  );
  return qualifyVoiceEvidence({
    baseEvidence, conversation, durabilityQualification, input, lifecycle,
    participantLifecycleReceipts, reconnectNoRepeat,
  });
}

type DurabilityQualification = ReturnType<typeof qualifyProviderlessVoiceDurability>;

function qualifyPostCallEvidence(
  baseEvidence: RetainedE2eEvidenceV6,
  input: CollectEvidenceInput,
  durabilityQualification: DurabilityQualification,
): RetainedE2eEvidenceV10 {
  return retainedE2eEvidenceV10Schema.parse({
    ...baseEvidence, durabilityQualification, qualificationKind: "post-call",
    qualificationPolicy: input.qualificationPolicy, release: input.release, schemaVersion: 10,
  });
}

function qualifyVoiceEvidence(context: {
  readonly baseEvidence: RetainedE2eEvidenceV6;
  readonly conversation: NonNullable<CollectEvidenceInput["conversation"]>;
  readonly durabilityQualification: DurabilityQualification;
  readonly input: CollectEvidenceInput;
  readonly lifecycle: Omit<Awaited<ReturnType<NonNullable<
    DeploymentEvidenceProbe["collectConversationLifecycle"]
  >>>, "participantLifecycleReceipts">;
  readonly participantLifecycleReceipts: Awaited<ReturnType<NonNullable<
    DeploymentEvidenceProbe["collectConversationLifecycle"]
  >>>["participantLifecycleReceipts"];
  readonly reconnectNoRepeat: ReturnType<typeof createReconnectNoRepeatEvidence>;
}): RetainedE2eEvidenceV10 {
  const { baseEvidence, conversation, durabilityQualification, input, lifecycle,
    participantLifecycleReceipts, reconnectNoRepeat } = context;
  return retainedE2eEvidenceV10Schema.parse({
    ...baseEvidence,
    conversation: {
      botSpeakerId: conversation.botSpeakerId,
      campaignProof: conversation.campaignProof,
      lifecycle,
      reconnectNoRepeat,
      supplementalPlayback: conversation.supplementalPlayback,
      voice: conversation.voice.map((observation) =>
        bindConversationVoiceRecording(observation, input.recordingId)),
    },
    serviceLevels: conversation.serviceLevels,
    serviceLevelSources: bindServiceLevelSources(input, participantLifecycleReceipts),
    durabilityQualification, qualificationKind: "voice",
    qualificationPolicy: input.qualificationPolicy, release: input.release, schemaVersion: 10,
  });
}

function bindServiceLevelSources(
  input: CollectEvidenceInput,
  participantLifecycleReceipts: Awaited<ReturnType<NonNullable<DeploymentEvidenceProbe["collectConversationLifecycle"]>>>["participantLifecycleReceipts"],
) {
  if (input.conversation?.serviceLevelSources === undefined) {
    throw new Error("V10 collection requires authoritative service-level source receipts");
  }
  return { ...input.conversation.serviceLevelSources, participantLifecycleReceipts };
}

export function createReplayTargetAttestation(
  input: Pick<CollectEvidenceInput, "fixtureSetId" | "recordingId" | "runId">,
  actorRun: ReturnType<typeof parseUnboundActorRun>,
): ReplayTargetAttestation {
  if (actorRun.runId !== input.runId) {
    throw new Error("Actor evidence does not match the requested run correlation");
  }
  if (actorRun.fixtureSetId !== input.fixtureSetId) {
    throw new Error("Actor evidence does not match the requested fixture set");
  }
  return {
    fixtureSetId: input.fixtureSetId,
    recordingId: input.recordingId,
    runId: input.runId,
  };
}

function createReconnectNoRepeatEvidence(
  receipts: Awaited<
    ReturnType<NonNullable<DeploymentEvidenceProbe["collectConversationLifecycle"]>>
  >["participantLifecycleReceipts"],
  participantId: string,
  recordingEndedAt: string,
) {
  const participantEvents = receipts.filter(
    (receipt) => receipt.participantId === participantId,
  );
  const left = participantEvents.filter(({ eventType }) => eventType === "participant.left");
  const rejoined = participantEvents.filter(({ eventType, occurredAt }) =>
    eventType === "participant.joined" &&
      left.some((receipt) => Date.parse(receipt.occurredAt) < Date.parse(occurredAt))
  );
  if (left.length !== 1 || rejoined.length !== 1) {
    throw new Error("Reconnect proof requires one SUT participant left/rejoined receipt pair");
  }
  return {
    lifecycleReceipts: [left[0]!, rejoined[0]!],
    negativeWindow: {
      endedAt: recordingEndedAt,
      source: "sut-rejoin-to-authoritative-recording-end" as const,
      startedAt: rejoined[0]!.occurredAt,
    },
    participantId,
  };
}

function collectRecordingPlaybackEvidence(
  input: CollectEvidenceInput,
  message: DiscordProjectionMessageObservation,
  s3: S3RecordingEvidence,
) {
  return input.recordingPlayback.collect({
    expectedRecordingId: input.recordingId,
    expectedTracks: s3.tracks.map(({ checksumSha256, sizeBytes }) => ({
      checksumSha256,
      sizeBytes,
    })),
    readinessExpectation: input.recordingPlaybackReadiness,
    recordingPlaybackUrl: message.recordingPlaybackUrl,
  });
}

async function collectSafeRecordingPlaybackEvidence(
  context: {
    readonly deployment: DeploymentEvidenceProbe;
    readonly input: CollectEvidenceInput;
    readonly meetingPlatformContainerId: string;
    readonly message: DiscordProjectionMessageObservation;
    readonly s3: S3RecordingEvidence;
  },
) {
  await context.deployment.assertRecordingPlaybackTargetSafe({
    meetingPlatformContainerId: context.meetingPlatformContainerId,
    origin: context.input.recordingPlaybackOrigin,
    scope: context.input.recordingPlaybackTestScope,
  });
  return collectRecordingPlaybackEvidence(context.input, context.message, context.s3);
}

export function bindConversationVoiceRecording(
  observation: unknown,
  recordingId: string,
) {
  const parsed = conversationVoiceEvidenceV3Schema.parse(observation);
  if (
    parsed.correlation.recordingId !== null &&
    parsed.correlation.recordingId !== recordingId
  ) {
    throw new Error("Conversation voice evidence is bound to a different recording");
  }
  return conversationVoiceEvidenceV3Schema.parse({
    ...parsed,
    correlation: { ...parsed.correlation, recordingId },
  });
}

interface LocatedDiscordEvidence {
  readonly marker: string;
  readonly message: DiscordProjectionMessageObservation;
  readonly observation: DiscordProjectionObservation;
}

async function inspectPublishedProjection(
  discord: DiscordEvidenceProbe,
  meetingId: string,
  publicationTargetId: string,
  publication: DiscordPublicationReference,
): Promise<LocatedDiscordEvidence> {
  const projectionKeys = await Promise.all([
    createMeetingDiscordFinalSummaryProjectionKey(meetingId, publicationTargetId),
    createMeetingDiscordProjectionKey(meetingId, publicationTargetId),
  ]);
  for (const projectionKey of projectionKeys) {
    const marker = await projectionMarker(projectionKey);
    const observation = await discord.inspect(publicationTargetId, marker);
    const message = findDiscordReference(observation, publication);
    if (message !== undefined) {
      return { marker, message, observation };
    }
  }
  throw new Error("Discord publication receipt is absent from final and replacement marker scans");
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
