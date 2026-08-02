import { z } from "zod";

const finiteNonNegativeNumber = z.number().nonnegative();

const transcriptionSegmentSchema = z
  .object({
    id: z.number().int().nonnegative(),
    start: finiteNonNegativeNumber,
    end: finiteNonNegativeNumber,
    text: z.string(),
  })
  .loose()
  .refine((segment) => segment.end > segment.start, {
    message: "segment end must be greater than segment start",
  });

export const verboseTranscriptionSchema = z
  .object({
    duration: finiteNonNegativeNumber,
    language: z.string().min(1),
    text: z.string(),
    segments: z.array(transcriptionSegmentSchema).optional(),
  })
  .loose();

const shortTextSchema = z.string().trim().min(1).max(240);
const titleSchema = z.string().trim().min(1).max(120);
const evidenceTurnIdsSchema = z
  .array(z.string().trim().min(1).max(128))
  .min(1)
  .max(8);

export const providerSummarySchema = z
  .object({
    title: titleSchema,
    overview: z.string().trim().min(1).max(800),
    topics: z.array(
      z
        .object({
          title: titleSchema,
          points: z.array(shortTextSchema).min(1).max(6),
          evidenceTurnIds: evidenceTurnIdsSchema,
        })
        .strict(),
    ).max(10),
    decisions: z.array(
      z
        .object({
          text: shortTextSchema,
          evidenceTurnIds: evidenceTurnIdsSchema,
        })
        .strict(),
    ).max(12),
    actionItems: z.array(
      z
        .object({
          text: shortTextSchema,
          ownerSpeakerId: z.string().trim().min(1).max(128).nullable(),
          deadline: z.string().trim().min(1).max(120).nullable(),
          evidenceTurnIds: evidenceTurnIdsSchema,
        })
        .strict(),
    ).max(12),
    openQuestions: z.array(shortTextSchema).max(12),
  })
  .strict();

export type ProviderSummary = z.infer<typeof providerSummarySchema>;
