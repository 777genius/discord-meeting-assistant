import { z } from "zod";

export const conversationPlaybackReadinessProtocolVersion = 1 as const;
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);

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
    .extend({ type: z.literal("observer-ready") })
    .strict();

export type ConversationAnswerPlaybackReadinessEnvelope = z.infer<
  typeof conversationAnswerPlaybackReadinessEnvelopeSchema
>;
export type ConversationAnswerPlaybackIntent = z.infer<
  typeof conversationAnswerPlaybackIntentSchema
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
