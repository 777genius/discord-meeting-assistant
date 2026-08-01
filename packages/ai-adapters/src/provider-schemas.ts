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

const evidenceTurnIdsSchema = z.array(z.string().min(1)).min(1);

export const providerSummarySchema = z
  .object({
    title: z.string().min(1),
    overview: z.string().min(1),
    decisions: z.array(
      z
        .object({
          text: z.string().min(1),
          evidenceTurnIds: evidenceTurnIdsSchema,
        })
        .strict(),
    ),
    actionItems: z.array(
      z
        .object({
          text: z.string().min(1),
          ownerSpeakerId: z.string().min(1).nullable(),
          evidenceTurnIds: evidenceTurnIdsSchema,
        })
        .strict(),
    ),
    openQuestions: z.array(z.string().min(1)),
  })
  .strict();

export type ProviderSummary = z.infer<typeof providerSummarySchema>;
