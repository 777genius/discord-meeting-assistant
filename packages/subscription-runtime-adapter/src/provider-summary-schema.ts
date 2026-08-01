import { z } from "zod";

const nonEmptyStringSchema = z.string().trim().min(1);
const evidenceTurnIdsSchema = z.array(nonEmptyStringSchema).min(1);

export const providerMeetingSummarySchema = z
  .object({
    actionItems: z.array(
      z
        .object({
          evidenceTurnIds: evidenceTurnIdsSchema,
          ownerSpeakerId: nonEmptyStringSchema.nullable(),
          text: nonEmptyStringSchema,
        })
        .strict(),
    ),
    decisions: z.array(
      z
        .object({
          evidenceTurnIds: evidenceTurnIdsSchema,
          text: nonEmptyStringSchema,
        })
        .strict(),
    ),
    openQuestions: z.array(nonEmptyStringSchema),
    overview: nonEmptyStringSchema,
    title: nonEmptyStringSchema,
  })
  .strict();

export type ProviderMeetingSummary = z.infer<typeof providerMeetingSummarySchema>;

export const providerMeetingSummaryJsonSchema = {
  additionalProperties: false,
  properties: {
    actionItems: {
      items: {
        additionalProperties: false,
        properties: {
          evidenceTurnIds: {
            items: { minLength: 1, type: "string" },
            minItems: 1,
            type: "array",
          },
          ownerSpeakerId: {
            anyOf: [
              { minLength: 1, type: "string" },
              { type: "null" },
            ],
          },
          text: { minLength: 1, type: "string" },
        },
        required: ["text", "ownerSpeakerId", "evidenceTurnIds"],
        type: "object",
      },
      type: "array",
    },
    decisions: {
      items: {
        additionalProperties: false,
        properties: {
          evidenceTurnIds: {
            items: { minLength: 1, type: "string" },
            minItems: 1,
            type: "array",
          },
          text: { minLength: 1, type: "string" },
        },
        required: ["text", "evidenceTurnIds"],
        type: "object",
      },
      type: "array",
    },
    openQuestions: {
      items: { minLength: 1, type: "string" },
      type: "array",
    },
    overview: { minLength: 1, type: "string" },
    title: { minLength: 1, type: "string" },
  },
  required: ["title", "overview", "decisions", "actionItems", "openQuestions"],
  type: "object",
} as const;
