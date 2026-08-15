import { z } from "zod"; import {
  conversationLifecycleEvidenceSchema,
  conversationVoiceEvidenceV3Schema,
  reconnectNoRepeatEvidenceSchema,
  supplementalPlaybackEvidenceV1Schema,
} from "./conversation-retained-evidence-schema.js";
import { conversationVoiceCampaignProofV1Schema } from "./conversation-voice-campaign-proof.js"; import { e2eServiceLevelsV1Schema, serviceLevelSourcesV1Schema, serviceLevelSourcesV2Schema } from "./e2e-service-levels.js";
import { hostedCampaignReleaseReferenceV1Schema } from
  "./hosted-campaign-release-reference.js";
import { hostedVoiceQualificationPolicyV1Schema } from "./hosted-voice-qualification-policy.js";
import { providerlessVoiceDurabilityQualificationV1Schema } from "./providerless-voice-durability-qualification.js";
import { recordingPlaybackEvidenceV1Schema } from "./recording-playback-evidence-schema.js";
import { scenarioKindSchema } from "./e2e-fixture-manifest-schema.js";
const identifierSchema = z.string().trim().min(1); const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
const nonNegativeMillisecondsSchema = z.number().int().nonnegative();

const actorEventSchema = z.object({
  actorName: identifierSchema,
  atRecordingMs: nonNegativeMillisecondsSchema,
  fixtureId: identifierSchema.optional(),
  type: z.enum(["disconnected", "playback-end", "playback-start", "ready"]),
});

const actorWallClockEventSchema = actorEventSchema.omit({ atRecordingMs: true }).extend({
  atEpochMs: z.number().int().positive(),
});

const actorFixtureProofSchema = z.object({
  audioSha256: sha256Schema,
  durationMs: z.number().int().positive(),
  fixtureId: identifierSchema,
  sourceSha256: sha256Schema,
});

export const unboundActorRunEvidenceV1Schema = z.object({
  events: z.array(actorWallClockEventSchema).min(1),
  fixtureSetId: identifierSchema,
  fixtures: z.array(actorFixtureProofSchema).min(2),
  recordingId: z.null(),
  runId: identifierSchema,
  scenario: scenarioKindSchema,
  schemaVersion: z.literal(1),
  timelineOrigin: z.literal("unix-epoch"),
});

export const actorRunEvidenceV1Schema = z.object({
  events: z.array(actorEventSchema).min(1),
  fixtureSetId: identifierSchema,
  fixtures: z.array(actorFixtureProofSchema).min(2),
  recordingId: identifierSchema,
  runId: identifierSchema,
  scenario: scenarioKindSchema,
  schemaVersion: z.literal(1),
  timelineOrigin: z.literal("actor-run-start-correlated-to-recording-id"),
});

const identifierCountSchema = z.number().int().nonnegative();
const dockerContainerIdSchema = z.string().regex(/^[a-f\d]{64}$/u);
const dockerImageIdSchema = z.string().regex(/^sha256:[a-f\d]{64}$/u);
const repositoryDigestSchema = z.string().regex(/^[^\s@]+@sha256:[a-f\d]{64}$/u);
const sourceRevisionSchema = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u);

export const deploymentRevisionExpectationSchema = z.object({
  craig: sourceRevisionSchema,
  meetingPlatform: sourceRevisionSchema,
  pipecat: sourceRevisionSchema.optional(),
  subscriptionRuntime: sourceRevisionSchema.optional(),
}).strict();

const deployedServiceProvenanceSchema = z.object({
  composeConfigHash: sha256Schema,
  composeProject: identifierSchema,
  composeService: identifierSchema,
  containerId: dockerContainerIdSchema,
  containerStartedAt: z.iso.datetime(),
  imageId: dockerImageIdSchema,
  repositoryDigest: repositoryDigestSchema.nullable(),
  sourceRevision: sourceRevisionSchema,
});

const historicalDeploymentProvenanceSchema = z.object({
  craig: deployedServiceProvenanceSchema,
  meetingPlatform: deployedServiceProvenanceSchema,
});

const runtimeDeploymentProvenanceSchema = historicalDeploymentProvenanceSchema.extend({
  subscriptionRuntime: deployedServiceProvenanceSchema,
});

export const currentDeploymentProvenanceSchema = runtimeDeploymentProvenanceSchema.extend({
  pipecat: deployedServiceProvenanceSchema.optional(),
});

export const retainedE2eEvidenceV2Schema = z.object({
  actorRun: actorRunEvidenceV1Schema,
  deployment: historicalDeploymentProvenanceSchema,
  fixtureManifestVersion: z.literal(1),
  fixtureSetId: identifierSchema,
  database: z.object({
    matchingMeetingCount: identifierCountSchema,
    matchingRecordingCount: identifierCountSchema,
    matchingSummaryCount: identifierCountSchema,
    matchingTranscriptCount: identifierCountSchema,
  }),
  fixtures: z.array(z.object({
    audioSha256: sha256Schema,
    codec: z.literal("opus"),
    durationMs: z.number().int().positive(),
    fixtureId: identifierSchema,
    sourceSha256: sha256Schema,
  })).min(2),
  meetingId: identifierSchema,
  publication: z.object({
    embedDescription: z.string().min(1).max(4_000).refine((value) => value.trim().length > 0),
    matchingMessageCount: identifierCountSchema,
    matchingThreadCount: identifierCountSchema,
    messageId: identifierSchema,
    threadId: identifierSchema,
  }),
  recording: z.object({
    durationMs: z.number().int().positive(),
    endedAt: z.iso.datetime(),
    recordingId: identifierSchema,
    s3: z.object({
      manifestChecksumSha256: sha256Schema,
      manifestLocator: identifierSchema,
      sourceChecksumSha256: sha256Schema,
      tracks: z.array(z.object({
        checksumSha256: sha256Schema,
        durationMs: z.number().int().positive(),
        locator: identifierSchema,
        sizeBytes: z.number().int().positive(),
        speakerId: identifierSchema,
        timelineOffsetMs: nonNegativeMillisecondsSchema,
      })).min(1),
    }),
    speakerIds: z.array(identifierSchema).min(1),
    startedAt: z.iso.datetime(),
  }),
  replay: z.object({
    matchingMeetingCount: identifierCountSchema,
    matchingMessageCount: identifierCountSchema,
    matchingRecordingCount: identifierCountSchema,
    matchingSummaryCount: identifierCountSchema,
    matchingThreadCount: identifierCountSchema,
    matchingTranscriptCount: identifierCountSchema,
    meetingId: identifierSchema,
    messageId: identifierSchema,
    recordingId: identifierSchema,
    summaryId: identifierSchema,
    threadId: identifierSchema,
    transcriptId: identifierSchema,
    replayJob: z.object({
      afterProcessedOn: z.number().int().positive(),
      beforeProcessedOn: z.number().int().positive(),
      jobId: identifierSchema,
      state: z.literal("completed"),
    }),
  }),
  schemaVersion: z.literal(2),
  stages: z.array(z.object({
    attempts: z.number().int().positive(),
    stage: z.enum(["publication", "summary", "transcription"]),
    status: z.literal("succeeded"),
  })).min(3),
  summary: z.object({
    actionItems: z.array(z.object({
      actionItemId: identifierSchema,
      deadline: identifierSchema.nullable(),
      evidenceTurnIds: z.array(identifierSchema).min(1),
      ownerSpeakerId: identifierSchema.nullable(),
      text: identifierSchema,
    }).strict()),
    decisions: z.array(z.object({
      decisionId: identifierSchema,
      evidenceTurnIds: z.array(identifierSchema).min(1),
      text: identifierSchema,
    }).strict()),
    openQuestions: z.array(z.object({
      evidenceTurnIds: z.array(identifierSchema).min(1),
      id: identifierSchema,
      text: identifierSchema,
    }).strict()),
    overview: identifierSchema,
    summaryId: identifierSchema,
    title: identifierSchema,
    topics: z.array(z.object({
      evidenceTurnIds: z.array(identifierSchema).min(1),
      points: z.array(identifierSchema).min(1),
      title: identifierSchema,
    }).strict()),
    transcriptId: identifierSchema,
    version: z.number().int().positive(),
  }).strict(),
  transcript: z.object({
    transcriptId: identifierSchema,
    turns: z.array(z.object({
      endMs: nonNegativeMillisecondsSchema,
      speakerId: identifierSchema,
      startMs: nonNegativeMillisecondsSchema,
      text: identifierSchema,
      turnId: identifierSchema,
    })).min(1),
  }),
});

const publicationContainerV3Schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("channel-message"),
    parentChannelId: identifierSchema,
  }),
  z.object({
    kind: z.literal("thread"),
    parentChannelId: identifierSchema,
    threadId: identifierSchema,
  }),
]);

const publicationEvidenceV3Schema = z.object({
  container: publicationContainerV3Schema,
  embedDescription: z.string().min(1).max(4_000).refine((value) => value.trim().length > 0),
  matchingMessageCount: identifierCountSchema,
  matchingThreadCount: identifierCountSchema,
  messageId: identifierSchema,
});

const discordAttachmentEvidenceSchema = z.object({
  filename: identifierSchema,
  sizeBytes: z.number().int().positive(),
}).strict();

const layeredDiscordAttachmentsSchema = z.array(discordAttachmentEvidenceSchema).length(2)
  .refine(
    (attachments) => new Set(attachments.map(({ filename }) => filename)).size === attachments.length,
    "Discord attachment filenames must be unique",
  )
  .refine(
    (attachments) =>
      attachments.some(({ filename }) => filename === "meeting-summary.md") &&
      attachments.some(({ filename }) => filename === "meeting-transcript.md"),
    "Layered Discord evidence requires meeting-summary.md and meeting-transcript.md",
  );

const replayEvidenceV3Schema = z.object({
  container: publicationContainerV3Schema,
  matchingMeetingCount: identifierCountSchema,
  matchingMessageCount: identifierCountSchema,
  matchingRecordingCount: identifierCountSchema,
  matchingSummaryCount: identifierCountSchema,
  matchingThreadCount: identifierCountSchema,
  matchingTranscriptCount: identifierCountSchema,
  meetingId: identifierSchema,
  messageId: identifierSchema,
  recordingId: identifierSchema,
  summaryId: identifierSchema,
  transcriptId: identifierSchema,
  replayJob: z.object({
    afterProcessedOn: z.number().int().positive(),
    beforeProcessedOn: z.number().int().positive(),
    jobId: identifierSchema,
    state: z.literal("completed"),
  }),
});

/**
 * v3 records the physical Discord container faithfully. v2 always modelled a
 * thread, so it remains a supported read format for retained historical proof.
 */
export const retainedE2eEvidenceV3Schema = retainedE2eEvidenceV2Schema
  .omit({ publication: true, replay: true, schemaVersion: true })
  .extend({
    publication: publicationEvidenceV3Schema,
    replay: replayEvidenceV3Schema,
    schemaVersion: z.literal(3),
  });

const processingStageObservationSchema = z.object({
  durationMs: nonNegativeMillisecondsSchema,
  observedAt: z.iso.datetime(),
  outcome: z.literal("succeeded"),
  stage: z.enum(["publication", "summary", "transcription"]),
}).strict();

const summaryRuntimeExecutionObservationSchema = z.object({
  durationMs: nonNegativeMillisecondsSchema,
  model: identifierSchema,
  observedAt: z.iso.datetime(),
  outputSchemaName: identifierSchema,
  policyVersion: identifierSchema,
  purpose: z.literal("discord_meeting.summary.generate"),
  reasoningEffort: identifierSchema,
  runId: identifierSchema,
  status: z.literal("completed"),
}).strict();

export const processingEvidenceSchema = z.object({
  stages: z.array(processingStageObservationSchema).min(3),
  summaryRuntimeExecutions: z.array(summaryRuntimeExecutionObservationSchema).min(1).max(2),
}).strict();

/**
 * v4 binds the summary-producing Subscription Runtime container and retains
 * non-secret stage/runtime latency observations from the correlated deployment.
 */
export const retainedE2eEvidenceV4Schema = retainedE2eEvidenceV3Schema
  .omit({ deployment: true, schemaVersion: true })
  .extend({
    deployment: runtimeDeploymentProvenanceSchema,
    processing: processingEvidenceSchema,
    schemaVersion: z.literal(4),
  });

export const retainedE2eEvidenceV5Schema = retainedE2eEvidenceV4Schema
  .omit({ deployment: true, schemaVersion: true })
  .extend({
    deployment: currentDeploymentProvenanceSchema,
    schemaVersion: z.literal(5),
  });
export const retainedE2eEvidenceV6Schema = retainedE2eEvidenceV5Schema
  .omit({ publication: true, replay: true, schemaVersion: true })
  .extend({
    publication: publicationEvidenceV3Schema.extend({
      attachments: layeredDiscordAttachmentsSchema,
    }),
    replay: replayEvidenceV3Schema.extend({
      attachments: layeredDiscordAttachmentsSchema,
    }),
    recordingPlayback: recordingPlaybackEvidenceV1Schema.optional(),
    schemaVersion: z.literal(6),
  });
export const retainedE2eEvidenceV7Schema = retainedE2eEvidenceV6Schema
  .omit({ schemaVersion: true })
  .extend({
    conversation: z.object({
      botSpeakerId: identifierSchema,
      lifecycle: conversationLifecycleEvidenceSchema,
      voice: z.array(conversationVoiceEvidenceV3Schema).min(5),
    }).strict(),
    schemaVersion: z.literal(7),
  });
export const retainedE2eEvidenceV8Schema = retainedE2eEvidenceV7Schema
  .omit({ conversation: true, schemaVersion: true }).extend({
    conversation: retainedE2eEvidenceV7Schema.shape.conversation.extend({
      reconnectNoRepeat: reconnectNoRepeatEvidenceSchema.optional(),
      supplementalPlayback: supplementalPlaybackEvidenceV1Schema,
      voice: z.array(conversationVoiceEvidenceV3Schema).min(6),
    }),
    schemaVersion: z.literal(8),
  });
export const retainedReconnectE2eEvidenceV8Schema = retainedE2eEvidenceV8Schema
  .omit({ conversation: true, recordingPlayback: true }).extend({
    conversation: retainedE2eEvidenceV8Schema.shape.conversation
      .extend({ reconnectNoRepeat: reconnectNoRepeatEvidenceSchema }),
    recordingPlayback: recordingPlaybackEvidenceV1Schema });
export const retainedE2eEvidenceV9Schema = retainedE2eEvidenceV8Schema.omit({ conversation: true, schemaVersion: true }).extend({
  conversation: retainedE2eEvidenceV8Schema.shape.conversation.extend({ campaignProof: conversationVoiceCampaignProofV1Schema }),
  serviceLevelSources: serviceLevelSourcesV1Schema,
  serviceLevels: e2eServiceLevelsV1Schema,
  schemaVersion: z.literal(9),
});
const retainedE2eEvidenceV10QualificationShape = {
  durabilityQualification: providerlessVoiceDurabilityQualificationV1Schema,
  qualificationPolicy: hostedVoiceQualificationPolicyV1Schema,
  release: hostedCampaignReleaseReferenceV1Schema,
};
const retainedPostCallE2eEvidenceV10Schema = retainedE2eEvidenceV6Schema
  .omit({ schemaVersion: true })
  .extend({
    ...retainedE2eEvidenceV10QualificationShape,
    qualificationKind: z.literal("post-call"),
    schemaVersion: z.literal(10),
  }).strict();
export const retainedVoiceE2eEvidenceV10Schema = retainedE2eEvidenceV9Schema
  .omit({ schemaVersion: true, serviceLevelSources: true })
  .extend({
    ...retainedE2eEvidenceV10QualificationShape,
    qualificationKind: z.literal("voice"),
    schemaVersion: z.literal(10),
    serviceLevelSources: serviceLevelSourcesV2Schema,
  }).strict();
export const retainedE2eEvidenceV10Schema = z.union([
  retainedPostCallE2eEvidenceV10Schema,
  retainedVoiceE2eEvidenceV10Schema,
]).superRefine((value, context) => {
  if (JSON.stringify(value.release) !== JSON.stringify(value.durabilityQualification.release)) {
    context.addIssue({ code: "custom", message: "V10 durability proof is bound to another release" });
  }
  if (value.durabilityQualification.sourceRevision !==
    value.deployment.meetingPlatform.sourceRevision) {
    context.addIssue({ code: "custom", message: "V10 durability proof is bound to another source revision" });
  }
  if (value.qualificationKind === "voice") {
    const grounded = value.conversation.lifecycle.groundedAnswers.filter(
      (observation) => observation.status === "validated",
    );
    const answerEvent = value.conversation.lifecycle.events.find(
      (event) => event.type === "addressed-answer",
    );
    const observation = grounded[0];
    const transcriptTurnIds = new Set(value.transcript.turns.map(({ turnId }) => turnId));
    const receipts = observation === undefined ? [] :
      value.conversation.lifecycle.playbackReceipts.filter(
        ({ turnId }) => turnId === observation.turnId,
      );
    if (grounded.length !== 1 || observation === undefined || answerEvent === undefined ||
      observation.turnId !== answerEvent.turnId ||
      observation.participantId !== answerEvent.participantId ||
      observation.citationTurnIds.some((turnId) => !transcriptTurnIds.has(turnId)) ||
      receipts.length !== 3 || receipts.some((receipt) =>
        receipt.playbackKind !== "answer" || receipt.speechProvenance !== "literal_tts")) {
      context.addIssue({
        code: "custom",
        message: "V10 voice evidence requires one cited grounded literal-speech answer with complete playback provenance",
      });
    }
  }
});
export const retainedE2eEvidenceSchema = z.union([retainedE2eEvidenceV2Schema,
  retainedE2eEvidenceV3Schema, retainedE2eEvidenceV4Schema, retainedE2eEvidenceV5Schema,
  retainedE2eEvidenceV6Schema, retainedE2eEvidenceV7Schema, retainedE2eEvidenceV8Schema,
  retainedE2eEvidenceV9Schema, retainedE2eEvidenceV10Schema]);
export { collectedConversationLifecycleEvidenceSchema, conversationVoiceEvidenceV3Schema } from
  "./conversation-retained-evidence-schema.js";
export { fixtureManifestV1Schema } from "./e2e-fixture-manifest-schema.js";
export type { CollectedConversationLifecycleEvidence } from "./conversation-retained-evidence-schema.js";
export type * from "./e2e-evidence-types.js";
