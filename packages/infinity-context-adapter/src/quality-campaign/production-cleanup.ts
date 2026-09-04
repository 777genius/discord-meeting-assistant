import { PROTECTED_SOURCE_KINDS, type ProtectedOriginal,
  verifyCampaignCreatedTargetInventory, verifyCleanupAbsenceReceipt } from "./cleanup-evidence.js";
import { canonicalJson, digest, exactRecord, safeId, sha256 } from "./canonical.js";
import type { CampaignDeletionPort, CanonicalAbsencePort,
  CampaignCallContext, ProtectedCampaignEvidence, QualityCampaignProductionPorts } from
  "./production-ports.js";
import type { QualityCampaignAuthorityPolicy } from "./release.js";


export type { ProtectedCampaignEvidence } from "./production-ports.js";

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

export interface CleanupReservationStore {
  reserveCleanup(input: { readonly campaignRootSha256: string;
    readonly cleanupManifestSha256: string }): Promise<import("./production-checkpoints.js").CleanupReservationState>;
  markCleanupOutcomeUnknown(input: { readonly campaignRootSha256: string;
    readonly cleanupManifestSha256: string }): Promise<void>;
  completeCleanup(input: { readonly campaignRootSha256: string;
    readonly cleanupManifestSha256: string; readonly evidence: unknown }): Promise<void>;
}

export function decodePersistedCleanup(value: unknown): StrictCleanupReceipt {
  const cleanup = exactRecord(value, ["absenceReceiptSha256", "absentArtifactIdsSha256",
    "campaignRootSha256", "cleanupManifestSha256", "cleanupReceipt",
    "protectedEvidenceSha256", "targetCount", "targetInventoryReceipt"],
  "persisted cleanup evidence");
  if ([cleanup.absenceReceiptSha256, cleanup.absentArtifactIdsSha256,
    cleanup.campaignRootSha256, cleanup.cleanupManifestSha256,
    cleanup.protectedEvidenceSha256].some((item) => typeof item !== "string") ||
    !Number.isSafeInteger(cleanup.targetCount) || Number(cleanup.targetCount) < 1) {
    throw new Error("persisted cleanup evidence is invalid");
  }
  return Object.freeze(cleanup as unknown as StrictCleanupReceipt);
}

export function assertDistinctCleanupAuthorities(absence: { readonly keyId: string;
  readonly publicKeyPem: string }, deletion: { readonly keyId: string;
  readonly publicKeyPem: string }, ports: QualityCampaignProductionPorts): void {
  if (absence.keyId === deletion.keyId || absence.publicKeyPem === deletion.publicKeyPem ||
    ports.absence.authorityId !== absence.keyId || ports.deletion.authorityId !== deletion.keyId) {
    throw new Error("deletion and absence authorities and keys must be independent");
  }
}

export async function executeDerivedCleanup(input: {
  readonly absenceAuthority: { readonly keyId: string; readonly publicKeyPem: string };
  readonly campaignRootSha256: string; readonly deletion: CampaignDeletionPort;
  readonly context: CampaignCallContext;
  readonly observation: CanonicalAbsencePort;
  readonly policy: QualityCampaignAuthorityPolicy;
  readonly protectedEvidence: readonly ProtectedCampaignEvidence[];
  readonly reservationStore: CleanupReservationStore;
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
  const targetIds = manifest.targets.map(({ artifactId }) => artifactId).toSorted();
  const reservationIdentity = { campaignRootSha256: input.campaignRootSha256,
    cleanupManifestSha256 };
  const reservation = await input.reservationStore.reserveCleanup(reservationIdentity);
  if (reservation.state === "completed") {return decodePersistedCleanup(reservation.evidence);}
  if (reservation.state === "created") {
    try {
      const outcomes = await input.deletion.deleteDerived({ campaignRootSha256:
        input.campaignRootSha256, context: input.context, targets: manifest.targets });
      if (canonicalJson(outcomes.map(({ artifactId }) => artifactId).toSorted()) !==
        canonicalJson(targetIds) || outcomes.some(({ outcome }) => outcome === "unknown")) {
        throw new Error("derived cleanup outcome is unknown");
      }
    } catch (error) {
      await input.reservationStore.markCleanupOutcomeUnknown(reservationIdentity);
      throw new Error("derived cleanup outcome is unknown; reconciliation only", { cause: error });
    }
  }
  let rawObservation: unknown;
  try {rawObservation = await input.observation.observe({ campaignRootSha256:
    input.campaignRootSha256, cleanupManifestSha256, context: input.context,
    targetArtifactIds: targetIds });}
  catch (error) {await input.reservationStore.markCleanupOutcomeUnknown(reservationIdentity);
    throw new Error("cleanup absence outcome is unknown; reconciliation only", { cause: error });}
  let signed;
  try {signed = verifyCleanupAbsenceReceipt(input.policy, { authorityKeyId:
    input.absenceAuthority.keyId, cleanupManifest: manifest, receipt: rawObservation });}
  catch (error) {await input.reservationStore.markCleanupOutcomeUnknown(reservationIdentity);
    throw new Error("cleanup absence evidence is invalid; reconciliation only", { cause: error });}
  for (const evidence of input.protectedEvidence) {digest(evidence.artifactSha256,
    "protected evidence digest");}
  const result = Object.freeze({ absenceReceiptSha256: sha256(signed), cleanupReceipt: signed,
    absentArtifactIdsSha256: sha256(targetIds), campaignRootSha256: input.campaignRootSha256,
    cleanupManifestSha256, protectedEvidenceSha256: sha256(input.protectedEvidence),
    targetCount: targetIds.length, targetInventoryReceipt: inventory.receipt });
  try {await input.reservationStore.completeCleanup({ ...reservationIdentity, evidence: result });}
  catch (error) {await input.reservationStore.markCleanupOutcomeUnknown(reservationIdentity);
    throw new Error("cleanup completion durability is unknown; reconciliation only", { cause: error });}
  return result;
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
