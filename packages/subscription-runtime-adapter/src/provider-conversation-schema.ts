import { z } from "zod";

/**
 * The live assistant returns one bounded utterance. Keeping the result
 * structured preserves the Subscription Runtime's existing schema validation
 * and execution attestation without widening the sidecar to arbitrary text.
 */
export const providerConversationAnswerSchema = z
  .object({
    answer: z.string().trim().min(1).max(2_000),
  })
  .strict();

export type ProviderConversationAnswer = z.infer<
  typeof providerConversationAnswerSchema
>;

export const providerConversationAnswerJsonSchema = {
  additionalProperties: false,
  properties: {
    answer: { maxLength: 2_000, minLength: 1, type: "string" },
  },
  required: ["answer"],
  type: "object",
} as const;
