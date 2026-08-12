import { z } from "zod";

export const conversationPlaybackReadinessProtocolVersion = 1 as const;
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
const discordSnowflakeSchema = z.string().regex(/^\d{17,20}$/u);

export const conversationAnswerPlaybackReadinessEnvelopeSchema = z.object({
  capturePlan: z.literal("addressed-answer"),
  kind: z.literal("answer"),
  meetingId: identifierSchema,
  playbackAttemptId: identifierSchema,
  protocolVersion: z.literal(conversationPlaybackReadinessProtocolVersion),
  runId: identifierSchema,
  turnId: identifierSchema,
}).strict();

export const conversationAnswerPlaybackIntentSchema =
  conversationAnswerPlaybackReadinessEnvelopeSchema
    .extend({ type: z.literal("playback-intent") })
    .strict();

export const conversationAnswerObserverReadySchema =
  conversationAnswerPlaybackReadinessEnvelopeSchema
    .extend({
      authenticatedObserverBotId: discordSnowflakeSchema,
      intentDigestSha256: sha256Schema,
      intentObservedAt: z.iso.datetime(),
      planDigestSha256: sha256Schema,
      readyPublishedAt: z.iso.datetime(),
      target: z.object({
        craigBotId: discordSnowflakeSchema,
        guildId: discordSnowflakeSchema,
        observerApplicationId: discordSnowflakeSchema,
        voiceChannelId: discordSnowflakeSchema,
      }).strict(),
      type: z.literal("observer-ready"),
    })
    .strict();

export const conversationGreetingPlaybackReadinessEnvelopeSchema = z.object({
  capturePlan: z.literal("observer-greeting"),
  kind: z.literal("greeting"),
  meetingId: identifierSchema,
  participantId: discordSnowflakeSchema,
  protocolVersion: z.literal(conversationPlaybackReadinessProtocolVersion),
  runId: identifierSchema,
  turnId: identifierSchema,
}).strict();

export const conversationGreetingPlaybackIntentSchema =
  conversationGreetingPlaybackReadinessEnvelopeSchema
    .extend({ type: z.literal("playback-intent") })
    .strict();

export const conversationGreetingObserverReadySchema =
  conversationGreetingPlaybackReadinessEnvelopeSchema
    .extend({
      authenticatedObserverBotId: discordSnowflakeSchema,
      intentDigestSha256: sha256Schema,
      intentObservedAt: z.iso.datetime(),
      readyPublishedAt: z.iso.datetime(),
      target: z.object({
        craigBotId: discordSnowflakeSchema,
        guildId: discordSnowflakeSchema,
        observerApplicationId: discordSnowflakeSchema,
        voiceChannelId: discordSnowflakeSchema,
      }).strict(),
      type: z.literal("observer-ready"),
    })
    .strict();

export type ConversationAnswerPlaybackReadinessEnvelope = z.infer<
  typeof conversationAnswerPlaybackReadinessEnvelopeSchema
>;
export type ConversationAnswerPlaybackIntent = z.infer<
  typeof conversationAnswerPlaybackIntentSchema
>;
export type ConversationAnswerObserverReady = z.infer<
  typeof conversationAnswerObserverReadySchema
>;
export type ConversationGreetingPlaybackReadinessEnvelope = z.infer<
  typeof conversationGreetingPlaybackReadinessEnvelopeSchema
>;
export type ConversationGreetingPlaybackIntent = z.infer<
  typeof conversationGreetingPlaybackIntentSchema
>;
export type ConversationGreetingObserverReady = z.infer<
  typeof conversationGreetingObserverReadySchema
>;

/** Stable canonical input for the content-addressed handshake filenames. */
export function serializeConversationAnswerPlaybackReadinessEnvelope(
  input: unknown,
): string {
  const source = z.union([
    conversationAnswerPlaybackReadinessEnvelopeSchema,
    conversationAnswerPlaybackIntentSchema,
    conversationAnswerObserverReadySchema,
  ]).parse(input);
  const envelope = conversationAnswerPlaybackReadinessEnvelopeSchema.parse({
    capturePlan: source.capturePlan,
    kind: source.kind,
    meetingId: source.meetingId,
    playbackAttemptId: source.playbackAttemptId,
    protocolVersion: source.protocolVersion,
    runId: source.runId,
    turnId: source.turnId,
  });
  return JSON.stringify([
    envelope.protocolVersion,
    envelope.runId,
    envelope.meetingId,
    envelope.turnId,
    envelope.playbackAttemptId,
    envelope.kind,
    envelope.capturePlan,
  ]);
}

/** Stable canonical input for the content-addressed greeting handshake filenames. */
export function serializeConversationGreetingPlaybackReadinessEnvelope(
  input: unknown,
): string {
  const source = z.union([
    conversationGreetingPlaybackReadinessEnvelopeSchema,
    conversationGreetingPlaybackIntentSchema,
    conversationGreetingObserverReadySchema,
  ]).parse(input);
  const envelope = conversationGreetingPlaybackReadinessEnvelopeSchema.parse({
    capturePlan: source.capturePlan,
    kind: source.kind,
    meetingId: source.meetingId,
    participantId: source.participantId,
    protocolVersion: source.protocolVersion,
    runId: source.runId,
    turnId: source.turnId,
  });
  return JSON.stringify([
    envelope.protocolVersion,
    envelope.runId,
    envelope.meetingId,
    envelope.participantId,
    envelope.turnId,
    envelope.kind,
    envelope.capturePlan,
  ]);
}
