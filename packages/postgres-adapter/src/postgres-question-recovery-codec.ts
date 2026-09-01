import { QuestionBinding, type GroundingPlan, type QuestionBindingSnapshot } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { z } from "zod";

import {
  canonicalEvidenceFiltersSchema,
  canonicalQuestionBindingValue,
  decodeGroundingPlan,
  decodePersistedQuestionBinding,
  groundingCoverageReductionSchema,
  groundingEvidenceSchema,
  hashJson,
  questionBindingBaseSchema,
  retrievalBindingSchema,
  retrievalV2RequestSchema,
} from "./postgres-meeting-knowledge-codecs.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const boundedText = z.string().trim().min(1).max(32_768);
const retrievalContributionSchema = z.object({
  contributionScorePicos: z.number().int(),
  providerLaneId: boundedText.max(128),
  providerRank: z.number().int().positive(),
  queryId: boundedText.max(128),
  rawScoreKind: z.enum(["bm25", "distance", "relevance", "similarity"]).nullable(),
  rawScoreValue: z.number().nullable(),
}).strict();

/* This closed schema is the protocol-2 shape emitted before composite provenance. */
const preCompositeRetrievalBindingSchema = z.object({
  canonicalEvidenceFilters: canonicalEvidenceFiltersSchema.optional(),
  cutoverEpoch: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/u),
  profileFingerprint: sha256Schema,
  retrievalPath: z.enum(["canonical_local_exact_lexical_v1",
    "infinity_locator_v1", "legacy_downstream_v1"]),
}).strict().or(z.object({
  canonicalEvidenceFilters: canonicalEvidenceFiltersSchema.optional(),
  cutoverEpoch: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/u),
  profileFingerprint: sha256Schema,
  request: retrievalV2RequestSchema,
  retrievalPath: z.literal("infinity_locator_v2"),
}).strict());
const preCompositeProtocol2QuestionBindingSchema = questionBindingBaseSchema.extend({
  bindingProtocolVersion: z.literal(2),
  retrievalBinding: preCompositeRetrievalBindingSchema,
}).strict();

const legacyFocusedRetrievalAuditSchema = z.object({
  capabilityFingerprint: sha256Schema,
  contributions: z.array(retrievalContributionSchema).min(1).max(32),
  fusedScore: z.number(), locator: boundedText.max(1_024),
  profileId: boundedText.max(256), providerRank: z.number().int().positive(),
  requestDigest: sha256Schema, responseDigest: sha256Schema,
}).strict();
const legacyGroundingEvidenceSchema = groundingEvidenceSchema.omit({
  retrievalAudit: true,
}).extend({ retrievalAudit: legacyFocusedRetrievalAuditSchema.optional() }).strict();
const legacyGroundingPlanV1Schema = z.object({
  authorityGeneration: boundedText,
  coverageBitmap: z.array(z.boolean()).max(10_000).optional(),
  coveragePlanDigest: boundedText.optional(),
  coverageReduction: groundingCoverageReductionSchema.optional(),
  evidence: z.array(legacyGroundingEvidenceSchema).max(256),
  mode: z.enum(["exhaustive_coverage", "focused_retrieval"]),
}).strict();

export type PersistedQuestionRecovery =
  | { readonly binding: QuestionBindingSnapshot;
      readonly groundingPlan: GroundingPlan | null;
      readonly migration: "current" | "pre_composite_local_v2";
      readonly status: "decoded" }
  | { readonly reason: "binding_authority_conflict" |
      "binding_structurally_corrupt" | "grounding_plan_structurally_corrupt" |
      "legacy_provenance_authority_conflict" |
      "protocol2_canonical_evidence_filters_absent" |
      "protocol2_composite_authority_absent" |
      "protocol2_local_authority_not_derivable";
      readonly status: "incompatible" };

/** Only reasons with derivable canonical-local authority remain externally actionable. */
export function reconciliationDispositionForRecoveryReason(
  reason: string,
): "quarantined" | "reconcile" {
  return reason.startsWith("protocol2_") ||
    reason === "legacy_provenance_authority_conflict"
    ? "reconcile" : "quarantined";
}

/**
 * Persist the recovery reason independently of which bounded scanner first
 * discovered the incompatible row. This keeps lease and reconciliation replay
 * stable across process loss; reconciliation_reason remains the closed reason.
 */
export function durableQuestionRecoveryRetryReason(reason: string): string {
  return `reconciliation:${reason}`;
}

/** Recovery never supplies absent evidence authority from process configuration. */
export function decodePersistedQuestionRecovery(input: {
  readonly binding: unknown; readonly bindingHash: string;
  readonly groundingPlan: unknown; readonly questionText: string;
}): PersistedQuestionRecovery {
  let currentBinding: QuestionBindingSnapshot | null = null;
  try {
    currentBinding = decodePersistedQuestionBinding(input.binding, input.bindingHash);
  } catch {}
  if (currentBinding !== null) {
    try {
      return { binding: currentBinding,
        groundingPlan: input.groundingPlan === null ? null :
          decodeGroundingPlan(input.groundingPlan, currentBinding, input.questionText),
        migration: "current", status: "decoded" };
    } catch {
      return { reason: "grounding_plan_structurally_corrupt",
        status: "incompatible" };
    }
  }
  const parsed = preCompositeProtocol2QuestionBindingSchema.safeParse(input.binding);
  if (!parsed.success) {
    return { reason: "binding_structurally_corrupt", status: "incompatible" };
  }
  if (!preCompositeProtocol2HashMatches(parsed.data, input.bindingHash)) {
    return { reason: "binding_authority_conflict", status: "incompatible" };
  }
  if (input.groundingPlan !== null &&
    !legacyGroundingPlanV1Schema.safeParse(input.groundingPlan).success) {
    return { reason: "grounding_plan_structurally_corrupt", status: "incompatible" };
  }
  const legacy = parsed.data.retrievalBinding;
  if (legacy.canonicalEvidenceFilters === undefined) {
    return { reason: "protocol2_canonical_evidence_filters_absent",
      status: "incompatible" };
  }
  if (legacy.retrievalPath === "infinity_locator_v2") {
    return { reason: "protocol2_composite_authority_absent", status: "incompatible" };
  }
  if (legacy.retrievalPath !== "canonical_local_exact_lexical_v1") {
    return { reason: "protocol2_local_authority_not_derivable",
      status: "incompatible" };
  }
  const migratedRetrievalBinding = {
    canonicalEvidenceFilters: legacy.canonicalEvidenceFilters,
    cutoverEpoch: legacy.cutoverEpoch,
    localCurrentIdentity: { algorithmId: "canonical_local_exact_lexical_v1" as const,
      profileFingerprint: legacy.profileFingerprint,
      profileId: "meeting-knowledge.local-current.v2" as const },
    originalQuestion: input.questionText, profileFingerprint: legacy.profileFingerprint,
    provenanceSchemaVersion: 1 as const,
    retrievalPath: "canonical_local_exact_lexical_v1" as const,
  };
  let binding: QuestionBindingSnapshot;
  try {
    binding = QuestionBinding.create({ ...parsed.data,
      retrievalBinding: migratedRetrievalBinding }).toSnapshot();
  } catch {
    return { reason: "binding_structurally_corrupt", status: "incompatible" };
  }
  const migratedPlan = input.groundingPlan === null ? null :
    migrateLegacyLocalGroundingPlan(input.groundingPlan, legacy,
      migratedRetrievalBinding, binding, input.questionText);
  return migratedPlan === null && input.groundingPlan !== null
    ? { reason: "legacy_provenance_authority_conflict", status: "incompatible" }
    : { binding, groundingPlan: migratedPlan,
        migration: "pre_composite_local_v2", status: "decoded" };
}

function preCompositeProtocol2HashMatches(
  binding: z.infer<typeof preCompositeProtocol2QuestionBindingSchema>,
  storedHash: string,
): boolean {
  const { authorizationPrincipalRef: _principal, ...dedupe } = binding;
  return storedHash === hashJson(dedupe) ||
    storedHash === hashJson(canonicalQuestionBindingValue(dedupe));
}

function migrateLegacyLocalGroundingPlan(
  value: unknown, oldBinding: z.infer<typeof preCompositeRetrievalBindingSchema>,
  newBinding: z.infer<typeof retrievalBindingSchema>,
  binding: QuestionBindingSnapshot, questionText: string,
): GroundingPlan | null {
  const parsed = legacyGroundingPlanV1Schema.safeParse(value);
  if (!parsed.success || oldBinding.retrievalPath !==
      "canonical_local_exact_lexical_v1") {return null;}
  const localIdentity = newBinding.localCurrentIdentity;
  const laneIdentity = { ...localIdentity, lane: "local_current" as const };
  const oldRequestDigest = hashJson(canonicalQuestionBindingValue({
    question: questionText, retrievalBinding: oldBinding }));
  const newRequestDigest = hashJson(canonicalQuestionBindingValue({
    hardFilters: newBinding.canonicalEvidenceFilters, laneIdentity: localIdentity,
    originalQuestion: questionText, schemaVersion: 1 }));
  const evidence = parsed.data.evidence.map((entry) => {
    const audit = entry.retrievalAudit;
    if (audit === undefined) {return entry;}
    const responseDigest = hashJson(canonicalQuestionBindingValue({
      contributions: audit.contributions, fusedScore: audit.fusedScore,
      locator: audit.locator, providerRank: audit.providerRank }));
    if (audit.capabilityFingerprint !== oldBinding.profileFingerprint ||
      audit.profileId !== oldBinding.retrievalPath ||
      audit.requestDigest !== oldRequestDigest || audit.responseDigest !== responseDigest ||
      audit.locator !== `canonical-turn:${entry.turnId}`) {return null;}
    const { capabilityFingerprint: _capability, profileId: _profile, ...rest } = audit;
    return { ...entry, retrievalAudit: { ...rest, laneIdentity,
      requestDigest: newRequestDigest } };
  });
  if (evidence.some((entry) => entry === null)) {return null;}
  try {
    return decodeGroundingPlan({ ...parsed.data, evidence }, binding, questionText);
  } catch {return null;}
}
