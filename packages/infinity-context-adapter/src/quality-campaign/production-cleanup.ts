import { PROTECTED_SOURCE_KINDS, verifyCampaignCreatedTargetInventory,
  verifyCleanupAbsenceReceipt } from "./retention.js";
import { canonicalJson, digest, sha256 } from "./canonical.js";
import type { CampaignDeletionPort, CanonicalAbsencePort,
  CampaignCallContext } from "./production-ports.js";

export interface ProtectedCampaignEvidence {
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
  readonly protectedEvidence: readonly ProtectedCampaignEvidence[];
  readonly releaseRootSha256: string;
  readonly targetInventoryAuthority: { readonly keyId: string; readonly publicKeyPem: string };
  readonly targetInventoryAuthorityKeySha256: string;
  readonly targetInventoryReceipt: unknown;
}): Promise<StrictCleanupReceipt> {
  assertCanonicalProtectedEvidence(input.protectedEvidence);
  const inventory = verifyCampaignCreatedTargetInventory({ authority:
    input.targetInventoryAuthority, campaignRootSha256: input.campaignRootSha256,
  receipt: input.targetInventoryReceipt, releaseRootSha256: input.releaseRootSha256,
  targetInventoryAuthorityKeySha256: input.targetInventoryAuthorityKeySha256 });
  const manifest = inventory.manifest;
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
  const signed = verifyCleanupAbsenceReceipt({ authorityKeyId: input.absenceAuthority.keyId,
    authorityPublicKeyPem: input.absenceAuthority.publicKeyPem, cleanupManifest: manifest,
    receipt: rawObservation });
  for (const evidence of input.protectedEvidence) {digest(evidence.artifactSha256,
    "protected evidence digest");}
  return Object.freeze({ absenceReceiptSha256: sha256(signed), cleanupReceipt: signed,
    absentArtifactIdsSha256: sha256(targetIds), campaignRootSha256: input.campaignRootSha256,
    cleanupManifestSha256, protectedEvidenceSha256: sha256(input.protectedEvidence),
    targetCount: targetIds.length, targetInventoryReceipt: inventory.receipt });
}

function assertCanonicalProtectedEvidence(values: readonly ProtectedCampaignEvidence[]): void {
  const required = ["original_craig_recording", "final_transcript", "meeting_database",
    "frozen_snapshot", "frozen_signed_root"];
  if (values.length < required.length || new Set(values.map(({ kind }) => kind)).size !==
    values.length || required.some((kind) => !values.some((value) => value.kind === kind))) {
    throw new Error("canonical authoritative evidence inventory is incomplete or substituted");
  }
}
