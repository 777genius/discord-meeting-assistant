import type { HistoricalEvidenceBlockPolicyV1 } from "./historical-index-plan.js";
import { DEFAULT_HISTORICAL_EVIDENCE_BLOCK_POLICY } from
  "./historical-index-plan.js";

export interface FocusedRetrievalPolicyV1 {
  readonly blockPolicy: HistoricalEvidenceBlockPolicyV1;
  readonly candidateLimitPerQuery: number;
  readonly maximumDecomposedQueries: number;
  readonly maximumEvidenceBytes: number;
  readonly maximumLocalScanBlocks: number;
  readonly minimumProviderScore: number;
  readonly neighborRadius: number;
  readonly rerankLimit: number;
  readonly searchTimeoutMs: number;
  readonly version: "meeting-knowledge.focused-retrieval.v1";
}

type FocusedRetrievalPolicyInputV1 =
  Omit<FocusedRetrievalPolicyV1, "version"> & { readonly version: string };

export const DEFAULT_FOCUSED_RETRIEVAL_POLICY: FocusedRetrievalPolicyV1 =
  Object.freeze({
    blockPolicy: DEFAULT_HISTORICAL_EVIDENCE_BLOCK_POLICY,
    candidateLimitPerQuery: 40,
    maximumDecomposedQueries: 4,
    maximumEvidenceBytes: 24_000,
    maximumLocalScanBlocks: 512,
    minimumProviderScore: 0.01,
    neighborRadius: 1,
    rerankLimit: 8,
    searchTimeoutMs: 3_000,
    version: "meeting-knowledge.focused-retrieval.v1",
  });

function isBoundedInteger(
  value: number,
  minimum: number,
  maximum: number,
): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

export function validateFocusedRetrievalPolicy(
  policy: FocusedRetrievalPolicyInputV1,
): FocusedRetrievalPolicyV1 {
  if (
    policy.version !== "meeting-knowledge.focused-retrieval.v1" ||
    !isBoundedInteger(policy.candidateLimitPerQuery, 1, 100) ||
    !isBoundedInteger(policy.maximumDecomposedQueries, 1, 8) ||
    !isBoundedInteger(policy.maximumEvidenceBytes, 256, 131_072) ||
    !isBoundedInteger(policy.maximumLocalScanBlocks, 1, 2_048) ||
    !Number.isFinite(policy.minimumProviderScore) ||
    policy.minimumProviderScore < 0 || policy.minimumProviderScore > 1 ||
    !isBoundedInteger(policy.neighborRadius, 0, 4) ||
    !isBoundedInteger(policy.rerankLimit, 1, 64) ||
    !isBoundedInteger(policy.searchTimeoutMs, 1, 60_000)
  ) {
    throw new RangeError(
      "focused historical retrieval policy is outside its qualified bounds",
    );
  }
  return Object.freeze({
    ...policy,
    version: "meeting-knowledge.focused-retrieval.v1",
  });
}
