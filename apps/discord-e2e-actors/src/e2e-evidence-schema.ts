import { z } from "zod";

const identifierSchema = z.string().trim().min(1);
const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
const nonNegativeMillisecondsSchema = z.number().int().nonnegative();
const nonNegativeSafeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 0,
  "Expected a nonnegative safe integer",
);
const scenarioKindSchema = z.enum(["overlap", "sequential", "reconnect"]);

const fixtureSchema = z.object({
  actorName: identifierSchema,
  audioPath: identifierSchema,
  audioSha256: sha256Schema,
  durationMs: z.number().int().positive(),
  fixtureId: identifierSchema,
  requiredTerms: z.array(identifierSchema).min(1),
  speechStartOffsetMs: nonNegativeSafeIntegerSchema.default(0),
  sourcePath: identifierSchema,
  sourceSha256: sha256Schema,
  sourceText: identifierSchema,
  speakerId: identifierSchema,
}).refine(
  ({ durationMs, speechStartOffsetMs }) => speechStartOffsetMs < durationMs,
  {
    message: "speechStartOffsetMs must be less than durationMs",
    path: ["speechStartOffsetMs"],
  },
);

const scenarioSchema = z.object({
  expectOverlap: z.boolean(),
  kind: scenarioKindSchema,
  playbackCountByFixture: z.record(identifierSchema, z.number().int().positive()),
  requireReconnect: z.boolean(),
  speakerBDelayMs: nonNegativeMillisecondsSchema,
});

export const fixtureManifestV1Schema = z.object({
  fixtureSetId: identifierSchema,
  fixtures: z.array(fixtureSchema).min(2),
  locale: identifierSchema,
  summaryExpectations: z.object({
    actionItems: z.array(z.object({
      deadline: identifierSchema.nullable(),
      ownerSpeakerId: identifierSchema,
      requiredTerms: z.array(identifierSchema).min(1),
    })).min(1),
    decisionTerms: z.array(identifierSchema).min(1),
    topicTerms: z.array(identifierSchema).min(1),
  }),
  scenarios: z.array(scenarioSchema).min(1),
  schemaVersion: z.literal(1),
  thresholds: z.object({
    maxCharacterErrorRate: z.number().min(0).max(1),
    maxWordErrorRate: z.number().min(0).max(1),
    timestampToleranceMs: nonNegativeMillisecondsSchema,
  }),
});

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

export const retainedE2eEvidenceV2Schema = z.object({
  actorRun: actorRunEvidenceV1Schema,
  deployment: z.object({
    craig: deployedServiceProvenanceSchema,
    meetingPlatform: deployedServiceProvenanceSchema,
  }),
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

export const retainedE2eEvidenceSchema = z.union([
  retainedE2eEvidenceV2Schema,
  retainedE2eEvidenceV3Schema,
]);

export type FixtureManifestV1 = z.infer<typeof fixtureManifestV1Schema>;
export type ActorRunEvidenceV1 = z.infer<typeof actorRunEvidenceV1Schema>;
export type UnboundActorRunEvidenceV1 = z.infer<typeof unboundActorRunEvidenceV1Schema>;
export type DeployedServiceProvenance = z.infer<typeof deployedServiceProvenanceSchema>;
export type DeploymentProvenance = z.infer<typeof retainedE2eEvidenceV2Schema>["deployment"];
export type DeploymentRevisionExpectation = z.infer<typeof deploymentRevisionExpectationSchema>;
export type RetainedE2eEvidenceV2 = z.infer<typeof retainedE2eEvidenceV2Schema>;
export type RetainedE2eEvidenceV3 = z.infer<typeof retainedE2eEvidenceV3Schema>;
export type RetainedE2eEvidence = z.infer<typeof retainedE2eEvidenceSchema>;
