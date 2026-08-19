export interface HistoricalEvidenceBlockPolicyV1 {
  /** Conservative retrieval projection budget; provider input must be at least this large. */
  readonly maximumEmbeddingTokens?: number;
  readonly maxBlockUtf8Bytes: number;
  readonly maxBlocksPerMeeting: number;
  readonly maxTurnsPerBlock: number;
  readonly turnOverlap?: number;
  readonly version: "meeting-knowledge.block-policy.v1";
}

export class HistoricalIndexPlanError extends Error {
  public override readonly name = "HistoricalIndexPlanError";

  public constructor(
    public readonly code: "BLOCK_LIMIT_EXCEEDED" | "INVALID_POLICY" | "STALE_PLAN",
    message: string,
  ) {
    super(message);
  }
}

type HistoricalEvidenceBlockPolicyInputV1 = Omit<
  HistoricalEvidenceBlockPolicyV1,
  "version"
> & { readonly version: string };

export interface ResolvedHistoricalEvidenceBlockPolicyV1 {
  readonly maximumEmbeddingTokens: number;
  readonly maxBlockUtf8Bytes: number;
  readonly maxBlocksPerMeeting: number;
  readonly maxTurnsPerBlock: number;
  readonly turnOverlap: number;
  readonly version: "meeting-knowledge.block-policy.v1";
}

export function resolveHistoricalEvidenceBlockPolicy(
  policy: HistoricalEvidenceBlockPolicyInputV1,
): ResolvedHistoricalEvidenceBlockPolicyV1 {
  const maximumEmbeddingTokens = policy.maximumEmbeddingTokens ?? 96;
  const turnOverlap = policy.turnOverlap ?? 2;
  if (
    policy.version !== "meeting-knowledge.block-policy.v1" ||
    !Number.isSafeInteger(policy.maxBlockUtf8Bytes) ||
    policy.maxBlockUtf8Bytes < 256 ||
    policy.maxBlockUtf8Bytes > 32_768 ||
    !Number.isSafeInteger(policy.maxBlocksPerMeeting) ||
    policy.maxBlocksPerMeeting < 1 ||
    policy.maxBlocksPerMeeting > 500 ||
    !Number.isSafeInteger(policy.maxTurnsPerBlock) ||
    policy.maxTurnsPerBlock < 1 ||
    policy.maxTurnsPerBlock > 64 ||
    !Number.isSafeInteger(maximumEmbeddingTokens) ||
    maximumEmbeddingTokens < 16 ||
    maximumEmbeddingTokens > 512 ||
    !Number.isSafeInteger(turnOverlap) ||
    turnOverlap < 0 ||
    turnOverlap > 8 ||
    turnOverlap >= policy.maxTurnsPerBlock
  ) {
    throw new HistoricalIndexPlanError(
      "INVALID_POLICY",
      "historical evidence block policy is outside its qualified bounds",
    );
  }
  return Object.freeze({
    ...policy,
    maximumEmbeddingTokens,
    turnOverlap,
    version: "meeting-knowledge.block-policy.v1",
  });
}
