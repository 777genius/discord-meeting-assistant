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
  playbackStartedAt: captureTimestampSchema,
  provenance: z.literal("playback-started-receipt"),
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
}).strict();

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

const conversationPlaybackReceiptBaseSchema = z.object({
  observedAt: z.iso.datetime(),
  playbackAttemptId: identifierSchema,
  playbackKind: z.enum(["answer", "prepared-cue", "thinking-cue"]),
  turnId: identifierSchema,
});
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
]);

export const conversationLifecycleEvidenceSchema = z.object({
  events: z.array(z.discriminatedUnion("type", [
    addressedAnswerObservationSchema,
    greetingPlaybackObservationSchema,
    farewellPlaybackObservationSchema,
  ])).min(4),
  playbackReceipts: z.array(conversationPlaybackReceiptSchema).default([]),
}).strict();

export type ConversationLifecycleEvidence = z.infer<typeof conversationLifecycleEvidenceSchema>;
