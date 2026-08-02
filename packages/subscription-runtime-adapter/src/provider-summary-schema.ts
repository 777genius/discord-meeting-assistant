import { z } from "zod";

const shortTextSchema = z.string().trim().min(1).max(240);
const titleSchema = z.string().trim().min(1).max(120);
const overviewSchema = z.string().trim().min(1).max(800);
const evidenceTurnIdSchema = z.string().trim().min(1).max(128);
const evidenceTurnIdsSchema = z.array(evidenceTurnIdSchema).min(1).max(8);

export const providerMeetingSummarySchema = z
  .object({
    actionItems: z.array(
      z
        .object({
          deadline: z.string().trim().min(1).max(120).nullable(),
          evidenceTurnIds: evidenceTurnIdsSchema,
          ownerSpeakerId: z.string().trim().min(1).max(128).nullable(),
          text: shortTextSchema,
        })
        .strict(),
    ).max(12),
    decisions: z.array(
      z
        .object({
          evidenceTurnIds: evidenceTurnIdsSchema,
          text: shortTextSchema,
        })
        .strict(),
    ).max(12),
    openQuestions: z.array(
      z
        .object({
          evidenceTurnIds: evidenceTurnIdsSchema,
          text: shortTextSchema,
        })
        .strict(),
    ).max(12),
    overview: overviewSchema,
    title: titleSchema,
    topics: z.array(
      z
        .object({
          evidenceTurnIds: evidenceTurnIdsSchema,
          points: z.array(shortTextSchema).min(1).max(6),
          title: titleSchema,
        })
        .strict(),
    ).max(10),
  })
  .strict();

export type ProviderMeetingSummary = z.infer<typeof providerMeetingSummarySchema>;

export const providerMeetingSummaryJsonSchema = {
  additionalProperties: false,
  properties: {
    actionItems: {
      maxItems: 12,
      items: {
        additionalProperties: false,
        properties: {
          deadline: {
            anyOf: [
              { maxLength: 120, minLength: 1, type: "string" },
              { type: "null" },
            ],
          },
          evidenceTurnIds: {
            items: { maxLength: 128, minLength: 1, type: "string" },
            maxItems: 8,
            minItems: 1,
            type: "array",
          },
          ownerSpeakerId: {
            anyOf: [
              { maxLength: 128, minLength: 1, type: "string" },
              { type: "null" },
            ],
          },
          text: { maxLength: 240, minLength: 1, type: "string" },
        },
        required: ["text", "ownerSpeakerId", "deadline", "evidenceTurnIds"],
        type: "object",
      },
      type: "array",
    },
    decisions: {
      maxItems: 12,
      items: {
        additionalProperties: false,
        properties: {
          evidenceTurnIds: {
            items: { maxLength: 128, minLength: 1, type: "string" },
            maxItems: 8,
            minItems: 1,
            type: "array",
          },
          text: { maxLength: 240, minLength: 1, type: "string" },
        },
        required: ["text", "evidenceTurnIds"],
        type: "object",
      },
      type: "array",
    },
    openQuestions: {
      items: {
        additionalProperties: false,
        properties: {
          evidenceTurnIds: {
            items: { maxLength: 128, minLength: 1, type: "string" },
            maxItems: 8,
            minItems: 1,
            type: "array",
          },
          text: { maxLength: 240, minLength: 1, type: "string" },
        },
        required: ["text", "evidenceTurnIds"],
        type: "object",
      },
      maxItems: 12,
      type: "array",
    },
    overview: { maxLength: 800, minLength: 1, type: "string" },
    title: { maxLength: 120, minLength: 1, type: "string" },
    topics: {
      items: {
        additionalProperties: false,
        properties: {
          evidenceTurnIds: {
            items: { maxLength: 128, minLength: 1, type: "string" },
            maxItems: 8,
            minItems: 1,
            type: "array",
          },
          points: {
            items: { maxLength: 240, minLength: 1, type: "string" },
            maxItems: 6,
            minItems: 1,
            type: "array",
          },
          title: { maxLength: 120, minLength: 1, type: "string" },
        },
        required: ["title", "points", "evidenceTurnIds"],
        type: "object",
      },
      maxItems: 10,
      type: "array",
    },
  },
  required: [
    "title",
    "overview",
    "topics",
    "decisions",
    "actionItems",
    "openQuestions",
  ],
  type: "object",
} as const;
