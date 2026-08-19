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
  productionSemanticQualification: true,
  qualificationManifestSha256:
    INFINITY_CONTEXT_SDK_PROVENANCE.retainedB77SemanticTransportManifestSha256,
  sdkCommit: INFINITY_CONTEXT_SDK_PROVENANCE.commit,
  serviceRevision: INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedServiceRevision,
});
