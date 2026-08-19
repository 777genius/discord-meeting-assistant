import type { HistoricalEmbeddingTokenizerProfileV1 } from
  "@discord-meeting/meeting-core/meeting-knowledge";

import {
  INFINITY_CONTEXT_SDK_PROVENANCE,
  type InfinityContextProductionQualificationPolicyV1,
} from "./infinity-runtime-provenance.js";

/** Exact retained b77 canary receipt selected by source, never operator input. */
export const INFINITY_CONTEXT_PRODUCTION_QUALIFICATION:
InfinityContextProductionQualificationPolicyV1 = Object.freeze({
  embeddingProfileDigestSha256:
    INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedEmbeddingProfileDigestSha256,
  embeddingProfileId: INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedEmbeddingProfileId,
  productionSemanticQualification: false,
  qualificationManifestSha256:
    INFINITY_CONTEXT_SDK_PROVENANCE.retainedB77SemanticTransportManifestSha256,
  sdkCommit: INFINITY_CONTEXT_SDK_PROVENANCE.commit,
  serviceRevision: INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedServiceRevision,
});

/** Reviewed compatibility tuple for b77 dense serving and local token planning. */
export const INFINITY_CONTEXT_PLANNING_COMPATIBILITY = Object.freeze({
  serviceProfile: Object.freeze({
    embeddingProfileDigestSha256:
      INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedEmbeddingProfileDigestSha256,
    embeddingProfileId: INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedEmbeddingProfileId,
    serviceRevision: INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedServiceRevision,
  }),
  tokenizerProfile: Object.freeze({
    conformanceVectorSetSha256:
      "sha256:59126ff07b10202d43c04bc1d1e87b92040f2ce9760a2e44dfed6cf314deeaf4",
    embeddingModelRevision: "e8f8c211226b894fcb81acc59f3b34ba3efd5f42",
    id: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
    maxInputTokens: 128,
    servingRuntimeRevision: "78502d8e61223d2c73d4bb7aeaea46787e90d596",
    tokenizerArtifactSha256:
      "sha256:2c3387be76557bd40970cec13153b3bbf80407865484b209e655e5e4729076b8",
    tokenizerConfigSha256:
      "sha256:5036ea374ffedd706e3bef33e2e0d6953cb868ef8a490e76e32ba0faa37a6b9b",
  } satisfies HistoricalEmbeddingTokenizerProfileV1),
});

export interface InfinityContextPlanningCompatibilityInputV1 {
  readonly productionQualification: InfinityContextProductionQualificationPolicyV1;
  readonly tokenizerProfile: HistoricalEmbeddingTokenizerProfileV1;
}

/** Fails closed unless service qualification and local tokenizer retain one tuple. */
export function assertInfinityContextPlanningCompatibility(
  input: InfinityContextPlanningCompatibilityInputV1,
): void {
  assertExactFields(
    input.productionQualification,
    INFINITY_CONTEXT_PLANNING_COMPATIBILITY.serviceProfile,
    "service profile",
  );
  assertExactFields(
    input.tokenizerProfile,
    INFINITY_CONTEXT_PLANNING_COMPATIBILITY.tokenizerProfile,
    "tokenizer profile",
  );
}

function assertExactFields(
  actual: object,
  expected: object,
  identity: string,
): void {
  const actualFields = actual as Readonly<Record<string, unknown>>;
  const expectedFields = expected as Readonly<Record<string, unknown>>;
  for (const field of Object.keys(expectedFields)) {
    if (actualFields[field] !== expectedFields[field]) {
      throw new Error(
        `Infinity Context planning ${identity} mismatch: ${String(field)}`,
      );
    }
  }
}
