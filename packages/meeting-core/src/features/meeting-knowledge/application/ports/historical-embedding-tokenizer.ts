export interface HistoricalEmbeddingTokenizerProfileV1 {
  readonly conformanceVectorSetSha256: `sha256:${string}`;
  readonly embeddingModelRevision: string;
  readonly id: string;
  readonly maxInputTokens: number;
  readonly servingRuntimeRevision: string;
  readonly tokenizerArtifactSha256: `sha256:${string}`;
  readonly tokenizerConfigSha256: `sha256:${string}`;
}

/** Consumer-owned boundary. Provider tokenizer values never cross into Meeting Core. */
export interface HistoricalEmbeddingTokenizerPort {
  readonly profile: HistoricalEmbeddingTokenizerProfileV1;
  countTokens(text: string): number;
}

export function historicalEmbeddingTokenProfile(
  tokenizer?: HistoricalEmbeddingTokenizerPort,
): string {
  if (tokenizer === undefined) {
    return "meeting-knowledge.wordpiece-conservative.v1";
  }
  return historicalEmbeddingTokenProfileFromProfile(tokenizer.profile);
}

export function historicalEmbeddingTokenProfileFromProfile(
  profile: HistoricalEmbeddingTokenizerProfileV1,
): string {
  return [
    "meeting-knowledge.multilingual-minilm-exact.v1",
    profile.id,
    profile.embeddingModelRevision,
    profile.servingRuntimeRevision,
    profile.tokenizerArtifactSha256,
    profile.tokenizerConfigSha256,
    profile.conformanceVectorSetSha256,
    String(profile.maxInputTokens),
  ].join("|");
}

export interface HistoricalEmbeddingRuntimeCompatibilityV1 {
  /** Reviewed release binding from the exact model/TEI pair to Infinity's dense profile. */
  readonly expectedEmbeddingProfileDigestSha256: `sha256:${string}`;
  readonly expectedEmbeddingProfileId: string;
  readonly expectedTokenizerProfile: HistoricalEmbeddingTokenizerProfileV1;
  /** Values observed from the live Infinity capability endpoint. */
  readonly observedEmbeddingProfileDigestSha256: string | null;
  readonly observedEmbeddingProfileId: string | null;
}

export class HistoricalEmbeddingTokenizerQualificationError extends Error {
  public override readonly name = "HistoricalEmbeddingTokenizerQualificationError";
}

/** Admits an immutable tokenizer only when local and live release evidence matches. */
export function prepareQualifiedHistoricalEmbeddingTokenizer(
  tokenizer: HistoricalEmbeddingTokenizerPort,
  compatibility: HistoricalEmbeddingRuntimeCompatibilityV1,
): HistoricalEmbeddingTokenizerPort {
  assertProfile(compatibility.expectedTokenizerProfile, "expected tokenizer profile");
  if (
    compatibility.expectedEmbeddingProfileId.trim().length === 0 ||
    !/^sha256:[a-f0-9]{64}$/u.test(
      compatibility.expectedEmbeddingProfileDigestSha256,
    )
  ) {
    throw new HistoricalEmbeddingTokenizerQualificationError(
      "expected Infinity embedding profile binding is invalid",
    );
  }
  assertProfile(tokenizer.profile, "observed tokenizer profile");
  if (!sameProfile(tokenizer.profile, compatibility.expectedTokenizerProfile)) {
    throw new HistoricalEmbeddingTokenizerQualificationError(
      "historical embedding tokenizer does not match the reviewed release profile",
    );
  }
  if (
    compatibility.observedEmbeddingProfileId !==
      compatibility.expectedEmbeddingProfileId ||
    compatibility.observedEmbeddingProfileDigestSha256 !==
      compatibility.expectedEmbeddingProfileDigestSha256
  ) {
    throw new HistoricalEmbeddingTokenizerQualificationError(
      "Infinity embedding profile does not match the tokenizer compatibility binding",
    );
  }
  return tokenizer;
}

function assertProfile(
  profile: HistoricalEmbeddingTokenizerProfileV1,
  label: string,
): void {
  const sha256 = /^sha256:[a-f0-9]{64}$/u;
  const gitSha = /^[a-f0-9]{40}$/u;
  if (
    profile.id.trim().length === 0 ||
    !gitSha.test(profile.embeddingModelRevision) ||
    !gitSha.test(profile.servingRuntimeRevision) ||
    !sha256.test(profile.tokenizerArtifactSha256) ||
    !sha256.test(profile.tokenizerConfigSha256) ||
    !sha256.test(profile.conformanceVectorSetSha256) ||
    !Number.isSafeInteger(profile.maxInputTokens) ||
    profile.maxInputTokens < 1
  ) {
    throw new HistoricalEmbeddingTokenizerQualificationError(`${label} is invalid`);
  }
}

function sameProfile(
  left: HistoricalEmbeddingTokenizerProfileV1,
  right: HistoricalEmbeddingTokenizerProfileV1,
): boolean {
  return left.id === right.id &&
    left.embeddingModelRevision === right.embeddingModelRevision &&
    left.servingRuntimeRevision === right.servingRuntimeRevision &&
    left.tokenizerArtifactSha256 === right.tokenizerArtifactSha256 &&
    left.tokenizerConfigSha256 === right.tokenizerConfigSha256 &&
    left.conformanceVectorSetSha256 === right.conformanceVectorSetSha256 &&
    left.maxInputTokens === right.maxInputTokens;
}
