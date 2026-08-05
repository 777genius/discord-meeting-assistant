import { z } from "zod";

export const conversationRuntimeProtocolVersion = 1 as const;
export const conversationRuntimeAudioSampleRateHz = 48_000 as const;
export const conversationRuntimeAudioChannels = 1 as const;
export const maximumConversationAudioChunkBytes = 19_200;

const identifierSchema = z.string().trim().min(1).max(128);
const localeSchema = z.string().trim().min(2).max(35);
const systemPromptSchema = z.string().trim().min(1).max(16_000);
const promptSchema = z.string().trim().min(1).max(8_000);
const sequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const conversationCancellationReasonSchema = z.enum([
  "barge-in",
  "meeting-ended",
  "playback-failed",
  "runtime-shutdown",
  "superseded",
]);

export type ConversationCancellationReason = z.infer<
  typeof conversationCancellationReasonSchema
>;

export const conversationRuntimeStartTurnSchema = z
  .object({
    protocolVersion: z.literal(conversationRuntimeProtocolVersion),
    meetingId: identifierSchema,
    recordingId: identifierSchema,
    turnId: identifierSchema,
    speakerId: identifierSchema,
    idempotencyKey: identifierSchema,
    systemPrompt: systemPromptSchema,
    prompt: promptSchema,
    locale: localeSchema,
    voiceProfileId: identifierSchema,
  })
  .strict();

export type ConversationRuntimeStartTurn = z.infer<
  typeof conversationRuntimeStartTurnSchema
>;

export const conversationRuntimeCancelTurnSchema = z
  .object({
    protocolVersion: z.literal(conversationRuntimeProtocolVersion),
    turnId: identifierSchema,
    attemptId: identifierSchema,
    reason: conversationCancellationReasonSchema,
  })
  .strict();

export type ConversationRuntimeCancelTurn = z.infer<
  typeof conversationRuntimeCancelTurnSchema
>;

const runtimeEventEnvelopeSchema = z.object({
  protocolVersion: z.literal(conversationRuntimeProtocolVersion),
  turnId: identifierSchema,
  attemptId: identifierSchema,
  eventSequence: sequenceSchema,
});

const acceptedEventSchema = runtimeEventEnvelopeSchema
  .extend({ type: z.literal("accepted") })
  .strict();

const textDeltaEventSchema = runtimeEventEnvelopeSchema
  .extend({
    type: z.literal("text-delta"),
    text: z.string().min(1).max(8_000),
  })
  .strict();

const audioFormatSchema = z.literal("pcm_s16le");

const audioStartEventSchema = runtimeEventEnvelopeSchema
  .extend({
    type: z.literal("audio-start"),
    format: audioFormatSchema,
    sampleRateHz: z.literal(conversationRuntimeAudioSampleRateHz),
    channels: z.literal(conversationRuntimeAudioChannels),
  })
  .strict();

const audioChunkEventSchema = runtimeEventEnvelopeSchema
  .extend({
    type: z.literal("audio-chunk"),
    audioSequence: sequenceSchema,
    format: audioFormatSchema,
    sampleRateHz: z.literal(conversationRuntimeAudioSampleRateHz),
    channels: z.literal(conversationRuntimeAudioChannels),
    pcm: z
      .instanceof(Uint8Array)
      .refine(
        (value) =>
          value.byteLength > 0 &&
          value.byteLength <= maximumConversationAudioChunkBytes &&
          value.byteLength % 2 === 0,
        "PCM chunks must contain bounded 16-bit samples",
      ),
  })
  .strict();

const audioEndEventSchema = runtimeEventEnvelopeSchema
  .extend({ type: z.literal("audio-end") })
  .strict();

const usageEventSchema = runtimeEventEnvelopeSchema
  .extend({
    type: z.literal("usage"),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (value) => value.totalTokens >= value.inputTokens + value.outputTokens,
    "total tokens must include input and output tokens",
  );

const completedEventSchema = runtimeEventEnvelopeSchema
  .extend({ type: z.literal("completed") })
  .strict();

const cancelledEventSchema = runtimeEventEnvelopeSchema
  .extend({
    type: z.literal("cancelled"),
    reason: conversationCancellationReasonSchema,
  })
  .strict();

const failedEventSchema = runtimeEventEnvelopeSchema
  .extend({
    type: z.literal("failed"),
    code: z.string().trim().min(1).max(128),
    safeMessage: z.string().trim().min(1).max(512),
    retryable: z.boolean(),
  })
  .strict();

export const conversationRuntimeEventSchema = z.discriminatedUnion("type", [
  acceptedEventSchema,
  textDeltaEventSchema,
  audioStartEventSchema,
  audioChunkEventSchema,
  audioEndEventSchema,
  usageEventSchema,
  completedEventSchema,
  cancelledEventSchema,
  failedEventSchema,
]);

export type ConversationRuntimeEvent = z.infer<
  typeof conversationRuntimeEventSchema
>;

export const conversationRuntimeHealthSchema = z
  .object({
    status: z.enum(["serving", "degraded", "not-serving"]),
    runtimeName: identifierSchema,
    runtimeVersion: z.string().trim().min(1).max(64),
    warningCodes: z.array(identifierSchema).max(64),
  })
  .strict();

export type ConversationRuntimeHealth = z.infer<
  typeof conversationRuntimeHealthSchema
>;

export function parseConversationRuntimeStartTurn(
  input: unknown,
): ConversationRuntimeStartTurn {
  return conversationRuntimeStartTurnSchema.parse(input);
}

export function parseConversationRuntimeCancelTurn(
  input: unknown,
): ConversationRuntimeCancelTurn {
  return conversationRuntimeCancelTurnSchema.parse(input);
}

export function parseConversationRuntimeEvent(input: unknown): ConversationRuntimeEvent {
  return conversationRuntimeEventSchema.parse(input);
}

export function parseConversationRuntimeHealth(
  input: unknown,
): ConversationRuntimeHealth {
  return conversationRuntimeHealthSchema.parse(input);
}
