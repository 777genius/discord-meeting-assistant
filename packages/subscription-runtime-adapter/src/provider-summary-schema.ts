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

/**
 * The live view deliberately has a smaller contract than the authoritative
 * post-call summary. It is a useful, evidence-backed snapshot, not a promise
 * to enumerate everything that has happened in the meeting.
 */
const incrementalShortTextSchema = z.string().trim().min(1).max(160);
const incrementalTitleSchema = z.string().trim().min(1).max(96);
const russianSentenceSegmenter = new Intl.Segmenter("ru", { granularity: "sentence" });
const incrementalOverviewSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (value) => {
      let sentenceCount = 0;
      for (const segment of russianSentenceSegmenter.segment(value)) {
        if (segment.segment.trim().length > 0) {
          sentenceCount += 1;
        }
        if (sentenceCount > 1) {
          return false;
        }
      }
      return true;
    },
    "Live overview must contain at most one sentence",
  );
const incrementalDeadlineSchema = z.string().trim().min(1).max(96).nullable();
const incrementalEvidenceTurnIdsSchema = z.array(evidenceTurnIdSchema).min(1).max(3);

export const providerIncrementalMeetingSummarySchema = z
  .object({
    actionItems: z.array(
      z
        .object({
          deadline: incrementalDeadlineSchema,
          evidenceTurnIds: incrementalEvidenceTurnIdsSchema,
          ownerSpeakerId: z.string().trim().min(1).max(128).nullable(),
          text: incrementalShortTextSchema,
        })
        .strict(),
    ).max(3),
    decisions: z.array(
      z
        .object({
          evidenceTurnIds: incrementalEvidenceTurnIdsSchema,
          text: incrementalShortTextSchema,
        })
        .strict(),
    ).max(3),
    openQuestions: z.array(
      z
        .object({
          evidenceTurnIds: incrementalEvidenceTurnIdsSchema,
          text: incrementalShortTextSchema,
        })
        .strict(),
    ).max(3),
    overview: incrementalOverviewSchema,
    title: incrementalTitleSchema,
    topics: z.array(
      z
        .object({
          evidenceTurnIds: incrementalEvidenceTurnIdsSchema,
          points: z.array(incrementalShortTextSchema).min(1).max(2),
          title: incrementalTitleSchema,
        })
        .strict(),
    ).max(3),
  })
  .strict();

export type ProviderIncrementalMeetingSummary = z.infer<
  typeof providerIncrementalMeetingSummarySchema
>;

export type ProviderMeetingSummaryWithEvidence =
  | ProviderIncrementalMeetingSummary
  | ProviderMeetingSummary;

export const providerIncrementalMeetingSummaryJsonSchema = {
  additionalProperties: false,
  properties: {
    actionItems: {
      maxItems: 3,
      items: {
        additionalProperties: false,
        properties: {
          deadline: {
            anyOf: [
              { maxLength: 96, minLength: 1, type: "string" },
              { type: "null" },
            ],
          },
          evidenceTurnIds: {
            items: { maxLength: 128, minLength: 1, type: "string" },
            maxItems: 3,
            minItems: 1,
            type: "array",
          },
          ownerSpeakerId: {
            anyOf: [
              { maxLength: 128, minLength: 1, type: "string" },
              { type: "null" },
            ],
          },
          text: { maxLength: 160, minLength: 1, type: "string" },
        },
        required: ["text", "ownerSpeakerId", "deadline", "evidenceTurnIds"],
        type: "object",
      },
      type: "array",
    },
    decisions: {
      items: {
        additionalProperties: false,
        properties: {
          evidenceTurnIds: {
            items: { maxLength: 128, minLength: 1, type: "string" },
            maxItems: 3,
            minItems: 1,
            type: "array",
          },
          text: { maxLength: 160, minLength: 1, type: "string" },
        },
        required: ["text", "evidenceTurnIds"],
        type: "object",
      },
      maxItems: 3,
      type: "array",
    },
    openQuestions: {
      items: {
        additionalProperties: false,
        properties: {
          evidenceTurnIds: {
            items: { maxLength: 128, minLength: 1, type: "string" },
            maxItems: 3,
            minItems: 1,
            type: "array",
          },
          text: { maxLength: 160, minLength: 1, type: "string" },
        },
        required: ["text", "evidenceTurnIds"],
        type: "object",
      },
      maxItems: 3,
      type: "array",
    },
    overview: {
      description: "Exactly one short sentence. It is a selective live snapshot and must not claim completeness.",
      maxLength: 240,
      minLength: 1,
      type: "string",
    },
    title: { maxLength: 96, minLength: 1, type: "string" },
    topics: {
      items: {
        additionalProperties: false,
        properties: {
          evidenceTurnIds: {
            items: { maxLength: 128, minLength: 1, type: "string" },
            maxItems: 3,
            minItems: 1,
            type: "array",
          },
          points: {
            items: { maxLength: 160, minLength: 1, type: "string" },
            maxItems: 2,
            minItems: 1,
            type: "array",
          },
          title: { maxLength: 96, minLength: 1, type: "string" },
        },
        required: ["title", "points", "evidenceTurnIds"],
        type: "object",
      },
      maxItems: 3,
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
