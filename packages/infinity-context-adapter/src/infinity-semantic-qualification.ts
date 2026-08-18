import {
  INFINITY_CONTEXT_SDK_PROVENANCE,
  type InfinityContextCapabilityAttestationV1,
} from "./infinity-runtime-provenance.js";

export const infinitySemanticQualificationSchema =
  "meeting_knowledge.infinity_semantic_qualification.v2" as const;

export interface InfinitySemanticQualificationManifestV2 {
  readonly claims: {
    readonly productionSemanticQualification: true;
    readonly remoteCleanupVerified: true;
  };
  readonly corpus: {
    readonly focusedQuestionCount: number;
    readonly focusedRecallAt5: number;
    readonly humanTurnsSha256: string;
    readonly turnCount: number;
  };
  readonly embeddingProfile: {
    readonly digestSha256: string;
    readonly id: string;
  };
  readonly observedAt: string;
  readonly source: {
    readonly harnessSha256: string;
    readonly treeSha256: string;
  };
  readonly releaseRevision: string;
  readonly schemaVersion: typeof infinitySemanticQualificationSchema;
  readonly sdk: {
    readonly commit: string;
    readonly packageIntegrity: string;
    readonly packageSha256: string;
    readonly tree: string;
  };
  readonly service: {
    readonly apiVersion: string;
    readonly enabledAdapters: readonly string[];
    readonly name: string;
    readonly revision: string;
  };
}

export interface InfinitySemanticQualificationEvidenceV2 {
  readonly corpusHumanTurnsSha256: string;
  readonly endpointReceipt: InfinityContextCapabilityAttestationV1;
  readonly focusedQuestionCount: number;
  readonly focusedRecallAt5: number;
  readonly observedAt: string;
  readonly releaseRevision: string;
  readonly qualificationHarnessSha256: string;
  readonly releaseSourceTreeSha256: string;
  readonly remoteCleanupVerified: boolean;
  readonly turnCount: number;
}

/**
 * Builds the exact artifact reviewed before a production embedding profile can
 * be pinned in runtime activation. A configured profile name is not proof: the
 * frozen recall corpus and verified cleanup must both pass in the same run.
 */
export function createInfinitySemanticQualificationManifest(
  evidence: InfinitySemanticQualificationEvidenceV2,
): InfinitySemanticQualificationManifestV2 {
  const receipt = evidence.endpointReceipt;
  if (
    receipt.apiVersion === null ||
    receipt.embeddingProfileDigestSha256 === null ||
    receipt.embeddingProfileId === null ||
    receipt.serviceName === null ||
    receipt.serviceRevision === null ||
    !receipt.supportsQdrant ||
    receipt.qdrant?.enabled !== true ||
    !receipt.qdrant.healthy ||
    !receipt.qdrant.supportsSearch ||
    !receipt.qdrant.supportsUpsert
  ) {
    throw new Error(
      "production semantic qualification requires a complete healthy endpoint receipt",
    );
  }
  const embeddingProfileId = text(
    receipt.embeddingProfileId,
    "endpointReceipt.embeddingProfileId",
    256,
  );
  if (/(?:deterministic|mock|non-production)/iu.test(embeddingProfileId)) {
    throw new Error("production semantic qualification requires a non-mock embedding profile");
  }
  if (
    evidence.focusedQuestionCount !== 7 ||
    evidence.focusedRecallAt5 !== 1 ||
    evidence.turnCount !== 421 ||
    !evidence.remoteCleanupVerified
  ) {
    throw new Error(
      "production semantic qualification requires the complete frozen recall and cleanup gate",
    );
  }
  const observedAt = text(evidence.observedAt, "observedAt", 64);
  if (Number.isNaN(Date.parse(observedAt))) {
    throw new Error("observedAt must be an ISO timestamp");
  }
  const enabledAdapters = Object.freeze([...new Set(receipt.enabledAdapters.map(
    (adapter) => text(adapter, "endpointReceipt.enabledAdapters", 128),
  ))].toSorted());
  if (!enabledAdapters.includes("qdrant")) {
    throw new Error("production semantic qualification requires the qdrant adapter");
  }
  return Object.freeze({
    claims: Object.freeze({
      productionSemanticQualification: true as const,
      remoteCleanupVerified: true as const,
    }),
    corpus: Object.freeze({
      focusedQuestionCount: evidence.focusedQuestionCount,
      focusedRecallAt5: evidence.focusedRecallAt5,
      humanTurnsSha256: sha256(evidence.corpusHumanTurnsSha256, "corpusHumanTurnsSha256"),
      turnCount: evidence.turnCount,
    }),
    source: Object.freeze({
      harnessSha256: sha256(evidence.qualificationHarnessSha256, "qualificationHarnessSha256"),
      treeSha256: sha256(evidence.releaseSourceTreeSha256, "releaseSourceTreeSha256"),
    }),
    embeddingProfile: Object.freeze({
      digestSha256: prefixedSha256(
        receipt.embeddingProfileDigestSha256,
        "endpointReceipt.embeddingProfileDigestSha256",
      ),
      id: embeddingProfileId,
    }),
    observedAt,
    releaseRevision: revision(evidence.releaseRevision, "releaseRevision"),
    schemaVersion: infinitySemanticQualificationSchema,
    sdk: Object.freeze({
      commit: INFINITY_CONTEXT_SDK_PROVENANCE.commit,
      packageIntegrity: INFINITY_CONTEXT_SDK_PROVENANCE.immutablePackageIntegrity,
      packageSha256: INFINITY_CONTEXT_SDK_PROVENANCE.packageTarballSha256,
      tree: INFINITY_CONTEXT_SDK_PROVENANCE.tree,
    }),
    service: Object.freeze({
      apiVersion: text(receipt.apiVersion, "endpointReceipt.apiVersion", 128),
      enabledAdapters,
      name: text(receipt.serviceName, "endpointReceipt.serviceName", 256),
      revision: revision(receipt.serviceRevision, "endpointReceipt.serviceRevision"),
    }),
  });
}

function prefixedSha256(value: string, field: string): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${field} must be a sha256-prefixed digest`);
  }
  return value;
}

function revision(value: string, field: string): string {
  if (!/^[a-f0-9]{40}$/u.test(value)) {
    throw new Error(`${field} must be an exact 40-character git revision`);
  }
  return value;
}

function sha256(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${field} must be a SHA-256 digest`);
  }
  return value;
}

function text(value: string, field: string, maximumLength: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new Error(`${field} is outside its bounded text contract`);
  }
  return normalized;
}
