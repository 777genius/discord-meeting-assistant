import { z } from "zod";

const identifierSchema = z.string().trim().min(1);
const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
const identifierCountSchema = z.number().int().nonnegative();
const conversationVoicePurposeSchema = z.enum([
  "addressed-answer",
  "farewell",
  "greeting",
]);
const captureTimestampSchema = z.object({
  epochMilliseconds: z.number().int().positive(),
  monotonicMilliseconds: z.number().nonnegative(),
}).strict();

const operatorSuppliedVoiceCorrelationSchema = z.object({
  attemptId: identifierSchema,
  provenance: z.literal("operator-supplied"),
  purpose: conversationVoicePurposeSchema,
  recordingId: identifierSchema.nullable(),
  verification: z.literal("not-run"),
  turnId: identifierSchema,
}).strict();
const playbackReceiptVoiceCorrelationSchema = z.object({
  attemptId: identifierSchema,
  meetingId: identifierSchema,
  playbackKind: z.literal("answer"),
  provenance: z.literal("playback-readiness-handshake"),
  purpose: z.literal("addressed-answer"),
  recordingId: identifierSchema.nullable(),
  verification: z.literal("not-run"),
  turnId: identifierSchema,
}).strict();

export const conversationVoiceEvidenceV3Schema = z.object({
  capture: z.object({
    acceptedDurationMilliseconds: z.number().int().positive(),
    acceptedPacketCount: z.number().int().positive(),
    cancellation: z.object({ status: z.literal("not-observed") }).strict(),
    endedAt: captureTimestampSchema,
    expectedDuration: z.object({
      maximumMilliseconds: z.number().int().positive(),
      minimumMilliseconds: z.number().int().positive(),
    }).strict(),
    firstPacketAt: captureTimestampSchema,
    ignoredDuplicatePacketCount: identifierCountSchema,
    ignoredLatePacketCount: identifierCountSchema,
    limits: z.object({
      captureTimeoutMilliseconds: z.number().int().positive(),
      maxCaptureDurationMilliseconds: z.number().int().positive(),
      maxPcmBytes: z.number().int().positive(),
    }).strict(),
    pcm: z.object({
      byteLength: z.number().int().positive(),
      channels: z.literal(2),
      encoding: z.literal("s16le"),
      nonSilence: z.object({
        sampleCount: z.number().int().positive(),
        sampleCountAboveThreshold: z.number().int().positive(),
        sampleRatioAboveThreshold: z.number().positive().max(1),
        thresholdSample: z.number().int().positive(),
      }).strict(),
      rms: z.number().positive(),
      sampleRateHertz: z.literal(48_000),
      sha256: sha256Schema,
    }).strict(),
    startedAt: captureTimestampSchema,
    termination: z.literal("expected-duration-reached"),
  }).strict(),
  correlation: z.discriminatedUnion("provenance", [
    operatorSuppliedVoiceCorrelationSchema,
    playbackReceiptVoiceCorrelationSchema,
  ]),
  kind: z.literal("conversation-voice-observer-evidence"),
  observer: z.object({
    applicationId: identifierSchema,
    authenticatedBotId: identifierSchema,
    guildId: identifierSchema,
    privateTestGuildConfirmed: z.literal(true),
    voiceChannelId: identifierSchema,
  }).strict(),
  runId: identifierSchema,
  schemaVersion: z.literal(3),
  source: z.object({
    codec: z.literal("opus"),
    craigBotId: identifierSchema,
    decodedPcm: z.object({
      channels: z.literal(2),
      encoding: z.literal("s16le"),
      sampleRateHertz: z.literal(48_000),
    }).strict(),
    receiver: z.literal("@discordjs/voice"),
  }).strict(),
  transcriptVerification: z.object({ status: z.literal("not-run") }).strict(),
}).strict().superRefine(({ capture }, context) => {
  const { acceptedDurationMilliseconds, expectedDuration } = capture;
  if (expectedDuration.minimumMilliseconds > expectedDuration.maximumMilliseconds) {
    context.addIssue({
      code: "custom",
      message: "Expected duration minimum must not exceed maximum",
      path: ["capture", "expectedDuration", "minimumMilliseconds"],
    });
  }
  if (
    acceptedDurationMilliseconds < expectedDuration.minimumMilliseconds ||
    acceptedDurationMilliseconds > expectedDuration.maximumMilliseconds
  ) {
    context.addIssue({
      code: "custom",
      message: "Accepted duration must be within the retained expected duration range",
      path: ["capture", "acceptedDurationMilliseconds"],
    });
  }
});

export const supplementalPlaybackEvidenceV1Schema = z.object({
  actor: z.object({
    applicationId: identifierSchema,
    authenticatedApplicationId: identifierSchema,
    name: z.literal("speaker-d"),
  }).strict(),
  fixture: z.object({
    durationMs: z.number().int().positive().max(60_000),
    path: identifierSchema,
    purpose: z.literal("speaker-d-botik-question-and-later-group-farewell"),
    sha256: sha256Schema,
  }).strict(),
  playback: z.object({
    endedAtEpochMs: z.number().int().positive(),
    postHoldMilliseconds: z.number().int().nonnegative(),
    preHoldMilliseconds: z.number().int().nonnegative(),
    startedAtEpochMs: z.number().int().positive(),
  }).strict(),
  privateTestGuildConfirmed: z.literal(true),
  runId: identifierSchema,
  schemaVersion: z.literal(1),
  target: z.object({
    guildId: identifierSchema,
    voiceChannelId: identifierSchema,
  }).strict(),
}).strict().refine(
  ({ playback }) => playback.startedAtEpochMs < playback.endedAtEpochMs,
  { message: "Supplemental playback must end after it starts", path: ["playback"] },
);

const greetingPlaybackObservationSchema = z.object({
  greetingLocale: z.enum(["en", "ru"]),
  observedAt: z.iso.datetime(),
  participantId: identifierSchema,
  participantNameStatus: z.enum(["known", "unknown"]),
  turnId: identifierSchema,
  type: z.literal("greeting"),
}).strict();
const participantLifecycleReceiptSchema = z.object({
  eventType: z.enum(["participant.joined", "participant.left"]),
  occurredAt: z.iso.datetime(),
  observedAt: z.iso.datetime(),
  participantId: identifierSchema,
  type: z.literal("participant-lifecycle"),
}).strict();
const farewellPlaybackObservationSchema = z.object({
  evidenceTurnIds: z.array(identifierSchema).min(1),
  locale: z.enum(["en", "ru"]),
  observedAt: z.iso.datetime(),
  playbackAttemptId: identifierSchema,
  reason: identifierSchema,
  turnId: z.literal("meeting-farewell:v1"),
  type: z.literal("farewell"),
}).strict();
const addressedAnswerObservationSchema = z.object({
  observedAt: z.iso.datetime(),
  outcome: z.enum(["active", "queued"]),
  participantId: identifierSchema,
  turnId: identifierSchema,
  type: z.literal("addressed-answer"),
}).strict();

const ttsDeploymentAttestationV1Schema = z.object({
  attemptId: identifierSchema,
  deployment: identifierSchema,
  keyId: sha256Schema,
  model: identifierSchema,
  provider: identifierSchema,
  schemaVersion: z.literal(1),
  signature: sha256Schema,
  sourceRevision: identifierSchema,
  turnId: identifierSchema,
  voice: identifierSchema,
  voiceProfileId: identifierSchema,
}).strict();

const groundedKnowledgeAnswerObservationSchema = z.discriminatedUnion("status", [
  z.object({
    citationTurnIds: z.array(identifierSchema).min(1).max(32),
    evidenceEpoch: identifierSchema,
    knowledgeEpoch: identifierSchema,
    observedAt: z.iso.datetime(),
    participantId: identifierSchema,
    playbackProvenance: z.enum(["literal_tts", "model_tts"]),
    status: z.literal("validated"),
    turnId: identifierSchema,
  }).strict(),
  z.object({
    observedAt: z.iso.datetime(),
    reason: z.enum([
      "barge-in",
      "disconnected",
      "meeting-ended",
      "playback-failed",
      "runtime-shutdown",
      "superseded",
    ]),
    status: z.literal("cancelled"),
    turnId: identifierSchema,
  }).strict(),
]);

const groundedCancellationPcmProofSchema = z.object({
  acceptedPacketCountAfterCancellation: z.literal(0),
  attemptId: identifierSchema,
  cancellationObservedAt: z.iso.datetime(),
  fenceObservedAt: z.iso.datetime(),
  recordingId: identifierSchema,
  source: z.literal("craig-authoritative-playback-track"),
  trackSha256: sha256Schema,
  turnId: identifierSchema,
}).strict().refine(
  ({ cancellationObservedAt, fenceObservedAt }) =>
    Date.parse(fenceObservedAt) >= Date.parse(cancellationObservedAt),
  { message: "authoritative PCM fence cannot precede cancellation" },
);

const conversationPlaybackReceiptBaseSchema = z.object({
  observedAt: z.iso.datetime(),
  playbackAttemptId: identifierSchema,
  playbackKind: z.enum(["answer", "prepared-cue", "thinking-cue"]),
  preparedAssetSha256: sha256Schema.optional(),
  speechProvenance: z.enum(["literal_tts", "model_tts"]).optional(),
  ttsAttestation: ttsDeploymentAttestationV1Schema.optional(),
  thinkingCuePcmSha256: sha256Schema.optional(),
  turnId: identifierSchema,
});
function refinePlaybackProvenance(
  receipt: z.infer<typeof conversationPlaybackReceiptBaseSchema>,
  context: z.RefinementCtx,
): void {
  if (receipt.speechProvenance === undefined && receipt.ttsAttestation !== undefined) {
    context.addIssue({ code: "custom", message: "Only TTS receipts may carry TTS attestation" });
  }
  if (receipt.playbackKind === "prepared-cue" && receipt.speechProvenance !== undefined) {
    context.addIssue({ code: "custom", message: "Prepared cue receipts cannot claim TTS provenance" });
  }
  if (receipt.playbackKind !== "prepared-cue" && receipt.preparedAssetSha256 !== undefined) {
    context.addIssue({ code: "custom", message: "Only prepared cue receipts may carry an asset digest" });
  }
  if (receipt.playbackKind === "thinking-cue" &&
    receipt.thinkingCuePcmSha256 === undefined) {
    context.addIssue({
      code: "custom",
      message: "Thinking cue receipts must carry their exact PCM digest",
    });
  }
  if (receipt.playbackKind !== "thinking-cue" &&
    receipt.thinkingCuePcmSha256 !== undefined) {
    context.addIssue({
      code: "custom",
      message: "Only thinking cue receipts may carry a thinking cue PCM digest",
    });
  }
}
const conversationPlaybackReceiptSchema = z.discriminatedUnion("status", [
  conversationPlaybackReceiptBaseSchema.extend({
    playbackStartedAtEpochMs: z.number().int().positive(),
    playbackStartedAtMonotonicMs: z.number().nonnegative(),
    status: z.literal("started"),
  }).strict(),
  conversationPlaybackReceiptBaseSchema.extend({
    playbackFinishedAtEpochMs: z.number().int().positive(),
    playbackFinishedAtMonotonicMs: z.number().nonnegative(),
    status: z.literal("finished"),
  }).strict(),
  conversationPlaybackReceiptBaseSchema.extend({
    playbackSettledAtEpochMs: z.number().int().positive(),
    playbackSettledAtMonotonicMs: z.number().nonnegative(),
    settlement: z.enum(["played", "unplayed", "partial", "unknown"]),
    status: z.literal("settled"),
  }).strict(),
]).superRefine(refinePlaybackProvenance);

export const conversationLifecycleEvidenceSchema = z.object({
  cancellationPcmProofs: z.array(groundedCancellationPcmProofSchema).default([]),
  events: z.array(z.discriminatedUnion("type", [
    addressedAnswerObservationSchema,
    greetingPlaybackObservationSchema,
    farewellPlaybackObservationSchema,
  ])).min(4),
  groundedAnswers: z.array(groundedKnowledgeAnswerObservationSchema).default([]),
  playbackReceipts: z.array(conversationPlaybackReceiptSchema).default([]),
}).strict().superRefine(({ cancellationPcmProofs, groundedAnswers, playbackReceipts }, context) => {
  for (const cancellation of groundedAnswers.filter((answer) => answer.status === "cancelled")) {
    if (!cancellationPcmProofs.some((proof) =>
      proof.turnId === cancellation.turnId &&
      proof.cancellationObservedAt === cancellation.observedAt)) {
      context.addIssue({
        code: "custom",
        message: "Cancellation requires a matching authoritative Craig PCM fence",
      });
    }
    if (playbackReceipts.some((receipt) => receipt.turnId === cancellation.turnId &&
      Date.parse(receipt.observedAt) > Date.parse(cancellation.observedAt))) {
      context.addIssue({
        code: "custom",
        message: "Cancellation proof cannot retain factual playback after cancellation",
      });
    }
  }
});

export const collectedConversationLifecycleEvidenceSchema =
  conversationLifecycleEvidenceSchema.extend({
    participantLifecycleReceipts: z.array(participantLifecycleReceiptSchema),
  });

export const reconnectNoRepeatEvidenceSchema = z.object({
  lifecycleReceipts: z.array(participantLifecycleReceiptSchema).length(2),
  negativeWindow: z.object({
    endedAt: z.iso.datetime(),
    source: z.literal("sut-rejoin-to-authoritative-recording-end"),
    startedAt: z.iso.datetime(),
  }).strict(),
  participantId: identifierSchema,
}).strict().refine(
  ({ lifecycleReceipts, negativeWindow, participantId }) =>
    lifecycleReceipts.every((receipt) => receipt.participantId === participantId) &&
    lifecycleReceipts.filter(({ eventType }) => eventType === "participant.left").length === 1 &&
    lifecycleReceipts.filter(({ eventType }) => eventType === "participant.joined").length === 1 &&
    Date.parse(negativeWindow.startedAt) < Date.parse(negativeWindow.endedAt),
  {
    message: "Reconnect proof must bind one left/rejoined receipt pair and a later window end",
    path: ["lifecycleReceipts"],
  },
);

export type CollectedConversationLifecycleEvidence = z.infer<
  typeof collectedConversationLifecycleEvidenceSchema
>;
