import { z } from "zod";

const evidenceIdSchema = z.string().regex(/^evidence-\d{6}$/u);

const providerKnowledgeClaimSchema = z.object({
  evidenceIds: z.array(evidenceIdSchema).max(8),
  text: z.string().trim().min(1).max(600),
}).strict();

export const providerKnowledgeAnswerSchema = z.object({
  claims: z.array(providerKnowledgeClaimSchema).max(12),
  locale: z.enum(["ru", "en", "mixed"]),
  status: z.enum(["answered", "insufficient_evidence", "not_a_question"]),
}).strict().superRefine((value, context) => {
  const validCount = value.status === "answered"
    ? value.claims.length >= 1
    : value.claims.length === 0;
  if (!validCount) {
    context.addIssue({
      code: "custom",
      message: "claims must be present only for answered output",
      path: ["claims"],
    });
  }
});

export type ProviderKnowledgeAnswer = z.infer<typeof providerKnowledgeAnswerSchema>;

export const providerKnowledgeAnswerJsonSchema = {
  additionalProperties: false,
  properties: {
    claims: {
      items: {
        additionalProperties: false,
        properties: {
          evidenceIds: {
            items: { pattern: "^evidence-[0-9]{6}$", type: "string" },
            maxItems: 8,
            minItems: 0,
            type: "array",
          },
          text: { maxLength: 600, minLength: 1, type: "string" },
        },
        required: ["text", "evidenceIds"],
        type: "object",
      },
      maxItems: 12,
      type: "array",
    },
    locale: { enum: ["ru", "en", "mixed"], type: "string" },
    status: {
      enum: ["answered", "insufficient_evidence", "not_a_question"],
      type: "string",
    },
  },
  required: ["status", "locale", "claims"],
  type: "object",
} as const;

const coverageExtractSchema = z.object({
  claims: z.array(z.object({
    evidenceIds: z.array(evidenceIdSchema).min(1).max(8),
    relevance: z.enum(["direct", "conflicting", "context"]),
  }).strict()).max(64),
  reviewedEvidenceIds: z.array(evidenceIdSchema).min(1).max(64),
  status: z.enum(["claims", "no_match"]),
}).strict();

export const providerKnowledgeCoverageExtractSchema = coverageExtractSchema
  .superRefine((value, context) => {
    const selected = value.claims.flatMap(({ evidenceIds }) => evidenceIds);
    const admitted = new Set(selected);
    const reviewed = new Set(value.reviewedEvidenceIds);
    if (
      admitted.size !== selected.length ||
      admitted.size > 64 ||
      reviewed.size !== value.reviewedEvidenceIds.length ||
      selected.some((evidenceId) => !reviewed.has(evidenceId)) ||
      (value.status === "claims") !== (value.claims.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "coverage claims must contain a bounded unique evidence selection",
        path: ["claims"],
      });
    }
  });

export type ProviderKnowledgeCoverageExtract = z.infer<
  typeof providerKnowledgeCoverageExtractSchema
>;

export const providerKnowledgeCoverageExtractJsonSchema = {
  additionalProperties: false,
  properties: {
    claims: {
      items: {
        additionalProperties: false,
        properties: {
          evidenceIds: {
            items: { pattern: "^evidence-[0-9]{6}$", type: "string" },
            maxItems: 8,
            minItems: 1,
            type: "array",
          },
          relevance: {
            enum: ["direct", "conflicting", "context"],
            type: "string",
          },
        },
        required: ["evidenceIds", "relevance"],
        type: "object",
      },
      maxItems: 64,
      type: "array",
    },
    reviewedEvidenceIds: {
      items: { pattern: "^evidence-[0-9]{6}$", type: "string" },
      maxItems: 64,
      minItems: 1,
      type: "array",
    },
    status: { enum: ["claims", "no_match"], type: "string" },
  },
  required: ["status", "claims", "reviewedEvidenceIds"],
  type: "object",
} as const;
