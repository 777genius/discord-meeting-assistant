import { PROTECTED_SOURCE_KINDS, type ProtectedOriginal,
  verifyCampaignCreatedTargetInventory, verifyCleanupAbsenceReceipt } from "./cleanup-evidence.js";
import { canonicalJson, digest, safeId, sha256 } from "./canonical.js";
import type { CampaignDeletionPort, CanonicalAbsencePort,
  CampaignCallContext } from "./production-ports.js";
import type { QualityCampaignAuthorityPolicy } from "./release.js";

export interface ProtectedCampaignEvidence {
  readonly artifactId: string;
  readonly artifactSha256: string;
  readonly kind: typeof PROTECTED_SOURCE_KINDS[number] | "frozen_snapshot" |
    "frozen_signed_root";
}

export interface StrictCleanupReceipt {
  readonly absenceReceiptSha256: string;
  readonly absentArtifactIdsSha256: string;
  readonly campaignRootSha256: string;
  readonly cleanupManifestSha256: string;
  readonly protectedEvidenceSha256: string;
  readonly targetCount: number;
  readonly cleanupReceipt: unknown;
  readonly targetInventoryReceipt: unknown;
}

export async function executeDerivedCleanup(input: {
  readonly absenceAuthority: { readonly keyId: string; readonly publicKeyPem: string };
  readonly campaignRootSha256: string; readonly deletion: CampaignDeletionPort;
  readonly context: CampaignCallContext;
  readonly observation: CanonicalAbsencePort;
  readonly policy: QualityCampaignAuthorityPolicy;
  readonly protectedEvidence: readonly ProtectedCampaignEvidence[];
  readonly releaseRootSha256: string;
  readonly targetInventoryAuthority: { readonly keyId: string; readonly publicKeyPem: string };
  readonly targetInventoryAuthorityKeySha256: string;
  readonly targetInventoryReceipt: unknown;
}): Promise<StrictCleanupReceipt> {
  const canonicalProtectedOriginals = assertCanonicalProtectedEvidence(input.protectedEvidence);
  const inventory = verifyCampaignCreatedTargetInventory(input.policy, { authorityKeyId:
    input.targetInventoryAuthority.keyId, campaignRootSha256: input.campaignRootSha256,
  receipt: input.targetInventoryReceipt, releaseRootSha256: input.releaseRootSha256,
  targetInventoryAuthorityKeySha256: input.targetInventoryAuthorityKeySha256 });
  const manifest = inventory.manifest;
  if (canonicalJson(sortProtectedOriginals(manifest.protectedOriginals)) !==
    canonicalJson(sortProtectedOriginals(canonicalProtectedOriginals))) {
    throw new Error("signed protected originals do not match canonical custody evidence");
  }
  const cleanupManifestSha256 = sha256(manifest);
  const outcomes = await input.deletion.deleteDerived({ campaignRootSha256:
    input.campaignRootSha256, context: input.context, targets: manifest.targets });
  const targetIds = manifest.targets.map(({ artifactId }) => artifactId).toSorted();
  if (canonicalJson(outcomes.map(({ artifactId }) => artifactId).toSorted()) !==
    canonicalJson(targetIds) || outcomes.some(({ outcome }) => outcome === "unknown")) {
    throw new Error("derived cleanup did not produce exact observed deletion outcomes");
  }
  const rawObservation = await input.observation.observe({ campaignRootSha256:
    input.campaignRootSha256, cleanupManifestSha256, context: input.context,
    targetArtifactIds: targetIds });
  const signed = verifyCleanupAbsenceReceipt(input.policy, { authorityKeyId:
    input.absenceAuthority.keyId, cleanupManifest: manifest,
    receipt: rawObservation });
  for (const evidence of input.protectedEvidence) {digest(evidence.artifactSha256,
    "protected evidence digest");}
  return Object.freeze({ absenceReceiptSha256: sha256(signed), cleanupReceipt: signed,
    absentArtifactIdsSha256: sha256(targetIds), campaignRootSha256: input.campaignRootSha256,
    cleanupManifestSha256, protectedEvidenceSha256: sha256(input.protectedEvidence),
    targetCount: targetIds.length, targetInventoryReceipt: inventory.receipt });
}

function assertCanonicalProtectedEvidence(values: readonly ProtectedCampaignEvidence[]):
readonly ProtectedOriginal[] {
  const required = [...PROTECTED_SOURCE_KINDS, "frozen_snapshot", "frozen_signed_root"] as const;
  if (values.length !== required.length || new Set(values.map(({ kind }) => kind)).size !==
    values.length || new Set(values.map(({ artifactId }) => artifactId)).size !== values.length ||
    new Set(values.map(({ artifactSha256 }) => artifactSha256)).size !== values.length ||
    required.some((kind) => !values.some((value) => value.kind === kind))) {
    throw new Error("canonical authoritative evidence inventory is incomplete or substituted");
  }
  for (const value of values) {
    safeId(value.artifactId, "protected evidence ID");
    digest(value.artifactSha256, "protected evidence digest");
  }
  return Object.freeze(values.filter((value): value is ProtectedCampaignEvidence & {
    readonly kind: ProtectedOriginal["kind"] } =>
    PROTECTED_SOURCE_KINDS.includes(value.kind as never)).map((value) => Object.freeze({
      artifactId: value.artifactId, artifactSha256: value.artifactSha256, kind: value.kind })));
}

function sortProtectedOriginals(values: readonly ProtectedOriginal[]): readonly ProtectedOriginal[] {
  return values.toSorted((left, right) => left.kind.localeCompare(right.kind));
}
