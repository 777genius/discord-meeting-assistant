import {
  MeetingKnowledgeInvariantError,
  requireKnowledgeInteger,
  requireKnowledgeText,
  requireSha256,
} from "./errors.js";
import {
  freezeGroundingPlan,
  normalizeRehydratedTurns,
  opaqueEvidenceId,
} from "./grounding-plan-internals.js";

export type GroundingPlanMode = "exhaustive_coverage" | "focused_retrieval";

export interface CanonicalEvidenceTurn {
  readonly endMs: number;
  readonly speakerId: string;
  readonly startMs: number;
  readonly text: string;
  readonly turnId: string;
}

/** A provider-neutral candidate identity. Candidate locators never return text. */
export interface FocusedMemoryReference {
  readonly meetingId: string;
  /**
   * Deterministic, normalized retrieval relevance. This is ranking metadata,
   * never evidence authority; canonical text and identity are still reloaded
   * locally before generation.
   */
  readonly relevanceScore?: number;
  readonly sourceEndCodePoint?: number;
  readonly sourceStartCodePoint?: number;
  readonly transcriptId: string;
  readonly transcriptVersion: number;
  readonly turnHash: string;
  readonly turnId: string;
}

/** Canonical text loaded locally after focused retrieval selected a reference. */
export interface RehydratedEvidenceTurn extends CanonicalEvidenceTurn {
  /**
   * Exact authoritative release used for a same-room historical turn. Current
   * final-reply evidence may omit it and inherits the immutable question
   * binding. Provider adapters never receive these local identities.
   */
  readonly source?: {
    readonly meetingId: string;
    readonly sourceEndCodePoint?: number;
    readonly sourceStartCodePoint?: number;
    readonly transcriptId: string;
    readonly transcriptVersion: number;
  };
  readonly turnHash: string;
}

export interface GroundingEvidence extends RehydratedEvidenceTurn {
  readonly evidenceId: string;
}

export interface GroundingCoverageReduction {
  readonly evidenceBlockCount: number;
  readonly payload: Readonly<
    Record<string, boolean | number | string | readonly string[]>
  >;
  readonly schemaVersion: 1;
  readonly selectionStatus: "no_match" | "selected";
  readonly selectedCanonicalTurnCount: number;
  readonly selectedEvidenceBlockCount: number;
}

export interface GroundingPlan {
  readonly authorityGeneration: string;
  readonly coverageBitmap?: readonly boolean[];
  readonly coveragePlanDigest?: string;
  readonly coverageReduction?: GroundingCoverageReduction;
  readonly evidence: readonly GroundingEvidence[];
  readonly mode: GroundingPlanMode;
}

export interface GroundingRequestMeasurement {
  readonly inputTokens: number;
  readonly requestBytes: number;
}

export interface GroundingSafetyLimits {
  readonly maximumRequestBytes: number;
  readonly modelContextTokens: number;
  readonly outputTokensReserved: number;
  readonly reasoningTokensReserved: number;
  readonly safeInputTokens: number;
  readonly tokenDriftReserve: number;
}

export type GroundingAdmission =
  | { readonly headroomTokens: number; readonly status: "admitted" }
  | {
      readonly reason: "context_headroom" | "request_bytes" | "safe_input_tokens";
      readonly status: "unsupported_size";
    };

export function focusedMemoryGeneration(canonicalEvidenceHash: string): string {
  return `focused-memory:v1:${requireSha256(
    canonicalEvidenceHash,
    "canonicalEvidenceHash",
  )}`;
}

export function createFocusedRetrievalGroundingPlan(input: {
  readonly authorityGeneration: string;
  readonly coverage: "low" | "sufficient";
  readonly humanActorIds: readonly string[];
  readonly turns: readonly RehydratedEvidenceTurn[];
}): GroundingPlan {
  if (input.coverage !== "sufficient") {
    throw new MeetingKnowledgeInvariantError(
      "INVALID_GROUNDING_PLAN",
      "focused retrieval cannot answer with low coverage",
    );
  }
  const evidence = normalizeRehydratedTurns(input.turns, input.humanActorIds)
    .map((turn, index) => Object.freeze({
      ...turn,
      evidenceId: opaqueEvidenceId(index),
    }));
  return freezeGroundingPlan({
    authorityGeneration: requireKnowledgeText(
      input.authorityGeneration,
      "authorityGeneration",
      512,
    ),
    evidence,
    mode: "focused_retrieval",
  });
}

export function createExhaustiveCoverageGroundingPlan(input: {
  readonly authorityGeneration: string;
  readonly coverageBitmap: readonly boolean[];
  readonly coveragePlanDigest: string;
  readonly coverageReduction: GroundingCoverageReduction;
  readonly humanActorIds: readonly string[];
  readonly turns: readonly RehydratedEvidenceTurn[];
}): GroundingPlan {
  if (
    input.coverageBitmap.some((covered) => !covered) ||
    input.coverageReduction.evidenceBlockCount !== input.coverageBitmap.length ||
    input.coverageReduction.selectedEvidenceBlockCount < 0 ||
    input.coverageReduction.selectedEvidenceBlockCount >
      input.coverageReduction.evidenceBlockCount
  ) {
    throw new MeetingKnowledgeInvariantError(
      "INVALID_GROUNDING_PLAN",
      "exhaustive coverage requires every evidence block to be current and processed",
    );
  }
  const evidence = normalizeRehydratedTurns(input.turns, input.humanActorIds, true)
    .map((turn, index) => Object.freeze({
      ...turn,
      evidenceId: opaqueEvidenceId(index),
    }));
  if (
    input.coverageReduction.selectedCanonicalTurnCount !== evidence.length ||
    (input.coverageReduction.selectionStatus === "no_match") !==
      (evidence.length === 0) ||
    (input.coverageReduction.selectionStatus === "selected" &&
      input.coverageReduction.selectedEvidenceBlockCount < 1)
  ) {
    throw new MeetingKnowledgeInvariantError(
      "INVALID_GROUNDING_PLAN",
      "exhaustive coverage reduction must bind the exact bounded canonical selection",
    );
  }
  assertCoverageReductionPayload(input.coverageReduction.payload);
  return freezeGroundingPlan({
    authorityGeneration: requireKnowledgeText(
      input.authorityGeneration,
      "authorityGeneration",
      512,
    ),
    coverageBitmap: input.coverageBitmap,
    coveragePlanDigest: requireKnowledgeText(
      input.coveragePlanDigest,
      "coveragePlanDigest",
      512,
    ),
    coverageReduction: input.coverageReduction,
    evidence,
    mode: "exhaustive_coverage",
  });
}

/** Only a current complete every-block proof may authorize an uncited absence claim. */
export function exhaustiveCoverageProvesAbsence(plan: GroundingPlan): boolean {
  return plan.mode === "exhaustive_coverage" &&
    plan.coverageBitmap !== undefined &&
    plan.coverageBitmap.every(Boolean) &&
    plan.coverageReduction?.selectionStatus === "no_match" &&
    plan.coverageReduction.selectedCanonicalTurnCount === 0 &&
    plan.coverageReduction.selectedEvidenceBlockCount === 0 &&
    plan.evidence.length === 0;
}

function assertCoverageReductionPayload(
  payload: GroundingCoverageReduction["payload"],
): void {
  const entries = Object.entries(payload);
  if (
    entries.length > 64 ||
    new TextEncoder().encode(JSON.stringify(payload)).byteLength > 32_768
  ) {
    throw new MeetingKnowledgeInvariantError(
      "INVALID_GROUNDING_PLAN",
      "exhaustive coverage reduction is outside its bounded contract",
    );
  }
  for (const [key, value] of entries) {
    if (
      key.length === 0 ||
      new TextEncoder().encode(key).byteLength > 128 ||
      (typeof value !== "boolean" &&
        typeof value !== "number" &&
        typeof value !== "string" &&
        !Array.isArray(value)) ||
      (typeof value === "number" && !Number.isFinite(value)) ||
      (Array.isArray(value) &&
        (value.length > 2_048 || value.some((item) => typeof item !== "string")))
    ) {
      throw new MeetingKnowledgeInvariantError(
        "INVALID_GROUNDING_PLAN",
        "exhaustive coverage reduction contains an invalid value",
      );
    }
  }
}

export function admitGroundingRequest(
  measurement: GroundingRequestMeasurement,
  limits: GroundingSafetyLimits,
): GroundingAdmission {
  const inputTokens = requireKnowledgeInteger(measurement.inputTokens, "inputTokens");
  const requestBytes = requireKnowledgeInteger(measurement.requestBytes, "requestBytes");
  const maximumRequestBytes = requireKnowledgeInteger(
    limits.maximumRequestBytes,
    "maximumRequestBytes",
    1,
  );
  const safeInputTokens = requireKnowledgeInteger(
    limits.safeInputTokens,
    "safeInputTokens",
    1,
  );
  if (requestBytes > maximumRequestBytes) {
    return { reason: "request_bytes", status: "unsupported_size" };
  }
  if (inputTokens > safeInputTokens) {
    return { reason: "safe_input_tokens", status: "unsupported_size" };
  }
  const headroomTokens = requireKnowledgeInteger(
    limits.modelContextTokens,
    "modelContextTokens",
    1,
  ) - inputTokens -
    requireKnowledgeInteger(limits.outputTokensReserved, "outputTokensReserved") -
    requireKnowledgeInteger(limits.reasoningTokensReserved, "reasoningTokensReserved") -
    requireKnowledgeInteger(limits.tokenDriftReserve, "tokenDriftReserve");
  if (headroomTokens < 0) {
    return { reason: "context_headroom", status: "unsupported_size" };
  }
  return { headroomTokens, status: "admitted" };
}
