import { PROTECTED_SOURCE_KINDS, createCleanupManifest } from "./retention.js";
import { canonicalJson, digest, exactRecord, safeId, sha256 } from "./canonical.js";
import { verifyExternalSignedValue } from "./execution.js";
import type { CampaignDeletionPort, CanonicalAbsencePort,
  CampaignCallContext, DerivedCampaignArtifact } from "./production-ports.js";

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
}

export async function executeDerivedCleanup(input: {
  readonly absenceAuthority: { readonly keyId: string; readonly publicKeyPem: string };
  readonly campaignRootSha256: string; readonly deletion: CampaignDeletionPort;
  readonly context: CampaignCallContext;
  readonly observation: CanonicalAbsencePort;
  readonly protectedEvidence: readonly ProtectedCampaignEvidence[];
  readonly targets: readonly DerivedCampaignArtifact[];
}): Promise<StrictCleanupReceipt> {
  assertCanonicalProtectedEvidence(input.protectedEvidence);
  const manifest = createCleanupManifest({ campaignRootSha256: input.campaignRootSha256,
    targets: input.targets });
  const cleanupManifestSha256 = sha256(manifest);
  const outcomes = await input.deletion.deleteDerived({ campaignRootSha256:
    input.campaignRootSha256, context: input.context, targets: input.targets });
  const targetIds = input.targets.map(({ artifactId }) => artifactId).toSorted();
  if (canonicalJson(outcomes.map(({ artifactId }) => artifactId).toSorted()) !==
    canonicalJson(targetIds) || outcomes.some(({ outcome }) => outcome === "unknown")) {
    throw new Error("derived cleanup did not produce exact observed deletion outcomes");
  }
  const rawObservation = await input.observation.observe({ campaignRootSha256:
    input.campaignRootSha256, cleanupManifestSha256, context: input.context,
    targetArtifactIds: targetIds });
  const signed = verifyExternalSignedValue(rawObservation, input.absenceAuthority.keyId,
    input.absenceAuthority.publicKeyPem, "canonical absence observation");
  const payload = exactRecord(signed.payload, ["absentArtifactIds", "campaignRootSha256",
    "cleanupManifestSha256", "protectedEvidence", "schemaVersion"],
  "canonical absence observation payload");
  if (payload.schemaVersion !== "meeting_knowledge.semantic_quality_canonical_absence.v1" ||
    payload.campaignRootSha256 !== input.campaignRootSha256 ||
    payload.cleanupManifestSha256 !== cleanupManifestSha256 ||
    !Array.isArray(payload.absentArtifactIds) || !Array.isArray(payload.protectedEvidence) ||
    !(payload.absentArtifactIds as readonly unknown[]).every((value) =>
      typeof value === "string") ||
    canonicalJson(payload.protectedEvidence) !== canonicalJson(input.protectedEvidence)) {
    throw new Error("canonical absence observation does not prove exact cleanup and preservation");
  }
  const absentArtifactIds = payload.absentArtifactIds as readonly string[];
  if (canonicalJson(absentArtifactIds.toSorted((a, b) => a.localeCompare(b))) !==
    canonicalJson(targetIds)) {
    throw new Error("canonical absence observation does not prove exact cleanup and preservation");
  }
  for (const id of absentArtifactIds) {safeId(id, "absent artifact ID");}
  for (const evidence of input.protectedEvidence) {digest(evidence.artifactSha256,
    "protected evidence digest");}
  return Object.freeze({ absenceReceiptSha256: sha256(signed),
    absentArtifactIdsSha256: sha256(targetIds), campaignRootSha256: input.campaignRootSha256,
    cleanupManifestSha256, protectedEvidenceSha256: sha256(input.protectedEvidence),
    targetCount: targetIds.length });
}

function assertCanonicalProtectedEvidence(values: readonly ProtectedCampaignEvidence[]): void {
  const required = ["original_craig_recording", "final_transcript", "meeting_database",
    "frozen_snapshot", "frozen_signed_root"];
  if (values.length < required.length || new Set(values.map(({ kind }) => kind)).size !==
    values.length || required.some((kind) => !values.some((value) => value.kind === kind))) {
    throw new Error("canonical authoritative evidence inventory is incomplete or substituted");
  }
}
