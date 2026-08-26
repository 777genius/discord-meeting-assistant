import { canonicalJson, digest, exactRecord, safeId, sha256 } from "./canonical.js";
import { MAIN_CARDINALITY } from "./admission.js";
import { type SignedValue, verifyExternalSignedValue } from "./execution.js";

export const REQUIRED_RETAINED_KINDS = Object.freeze([
  "capability_request", "capability_response", "retrieval_request", "retrieval_response",
  "evidence", "answer_request", "answer_response", "raw_outcome", "adjudication_input",
  "adjudicator_1_result", "adjudicator_2_result", "final_adjudication",
] as const);

export interface RetainedArtifact {
  readonly attemptId: string;
  readonly envelopeSha256: string;
  readonly keyId: string;
  readonly kind: typeof REQUIRED_RETAINED_KINDS[number] | "resolver_result";
  readonly questionId: string;
  readonly repetition: 1 | 2 | 3;
  readonly storedBytes: number;
}

export interface ExpectedOutcomeInventory {
  readonly attemptId: string;
  readonly questionId: string;
  readonly repetition: 1 | 2 | 3;
  readonly resolverRequired: boolean;
}

export function verifyExactRetentionInventory(input: { readonly artifacts:
  readonly RetainedArtifact[]; readonly campaignByteCeiling: number;
  readonly expectedOutcomes: readonly ExpectedOutcomeInventory[] }): {
    readonly artifactCount: number; readonly inventorySha256: string;
    readonly totalStoredBytes: number } {
  if (input.expectedOutcomes.length !== MAIN_CARDINALITY.total ||
    new Set(input.expectedOutcomes.map(({ attemptId }) => attemptId)).size !==
      MAIN_CARDINALITY.total) {throw new Error("expected outcome inventory is not exactly 3 x 240");}
  const expected = new Set<string>();
  for (const outcome of input.expectedOutcomes) {
    for (const kind of REQUIRED_RETAINED_KINDS) {expected.add(`${outcome.attemptId}:${kind}`);}
    if (outcome.resolverRequired) {expected.add(`${outcome.attemptId}:resolver_result`);}
  }
  const actual = new Set<string>();
  let totalStoredBytes = 0;
  for (const artifact of input.artifacts) {
    digest(artifact.envelopeSha256, "retained envelope");
    safeId(artifact.keyId, "retained key ID");
    if (!Number.isSafeInteger(artifact.storedBytes) || artifact.storedBytes < 1 ||
      actual.has(`${artifact.attemptId}:${artifact.kind}`)) {
      throw new Error("retained inventory contains corruption or duplicates");
    }
    actual.add(`${artifact.attemptId}:${artifact.kind}`);
    totalStoredBytes += artifact.storedBytes;
  }
  if (canonicalJson([...actual].toSorted()) !== canonicalJson([...expected].toSorted())) {
    throw new Error("retained inventory has missing or orphan artifacts");
  }
  if (!Number.isSafeInteger(input.campaignByteCeiling) ||
    totalStoredBytes > input.campaignByteCeiling) {
    throw new Error("retained inventory exceeds campaign byte ceiling");
  }
  return Object.freeze({ artifactCount: actual.size,
    inventorySha256: sha256([...input.artifacts].toSorted((a, b) =>
      `${a.attemptId}:${a.kind}`.localeCompare(`${b.attemptId}:${b.kind}`))), totalStoredBytes });
}

export const DELETABLE_CAMPAIGN_KINDS = Object.freeze(["derived_index", "temporary_prompt",
  "temporary_projection"] as const);
export const PROTECTED_SOURCE_KINDS = Object.freeze(["authoritative_transcript", "final_transcript",
  "meeting_database", "original_craig_recording", "summary"] as const);

export function createCleanupManifest(input: { readonly campaignRootSha256: string;
  readonly targets: readonly { readonly artifactId: string;
    readonly kind: typeof DELETABLE_CAMPAIGN_KINDS[number] }[] }): Readonly<Record<string, unknown>> {
  digest(input.campaignRootSha256, "cleanup campaign root");
  if (input.targets.length === 0 || input.targets.some(({ artifactId, kind }) => {
    safeId(artifactId, "cleanup artifact ID");
    return !DELETABLE_CAMPAIGN_KINDS.includes(kind);
  }) || new Set(input.targets.map(({ artifactId }) => artifactId)).size !== input.targets.length) {
    throw new Error("cleanup targets are unsafe or duplicated");
  }
  return Object.freeze({ campaignRootSha256: input.campaignRootSha256,
    protectedKinds: PROTECTED_SOURCE_KINDS, schemaVersion:
    "meeting_knowledge.semantic_quality_cleanup_manifest.v2", targets: input.targets });
}

export function verifyCleanupAbsenceReceipt(input: { readonly authorityKeyId: string;
  readonly authorityPublicKeyPem: string; readonly campaignRootSha256: string;
  readonly cleanupManifestSha256: string; readonly receipt: unknown }):
SignedValue<unknown> {
  const receipt = verifyExternalSignedValue(input.receipt, input.authorityKeyId,
    input.authorityPublicKeyPem, "cleanup absence receipt");
  const payload = exactRecord(receipt.payload, ["absentArtifactIdsSha256",
    "campaignRootSha256", "cleanupManifestSha256", "protectedSourcePreserved",
    "schemaVersion"], "cleanup absence payload");
  if (payload.schemaVersion !== "meeting_knowledge.semantic_quality_cleanup_absence.v2" ||
    payload.campaignRootSha256 !== input.campaignRootSha256 ||
    payload.cleanupManifestSha256 !== input.cleanupManifestSha256 ||
    payload.protectedSourcePreserved !== true) {
    throw new Error("cleanup absence receipt is not authoritative");
  }
  digest(payload.absentArtifactIdsSha256, "absent artifact inventory");
  return receipt;
}

export function admitFinalCampaign(input: { readonly cleanupReceiptSha256: string;
  readonly independentRepetitionPasses: readonly { readonly metricsSha256: string;
    readonly repetition: 1 | 2 | 3; readonly thresholdsPassed: true }[];
  readonly inventorySha256: string; readonly outcomeCount: number;
  readonly rootBindingSha256: string }): { readonly finalAdmissionSha256: string;
    readonly qualified: true } {
  if (input.outcomeCount !== MAIN_CARDINALITY.total ||
    input.independentRepetitionPasses.length !== MAIN_CARDINALITY.repetitions ||
    new Set(input.independentRepetitionPasses.map(({ repetition }) => repetition)).size !== 3) {
    throw new Error("final admission requires three independent 240-outcome repetitions");
  }
  for (const value of [input.cleanupReceiptSha256, input.inventorySha256,
    input.rootBindingSha256, ...input.independentRepetitionPasses.map(({ metricsSha256 }) =>
      metricsSha256)]) {digest(value, "final admission digest");}
  return Object.freeze({ finalAdmissionSha256: sha256(input), qualified: true });
}
