import { canonicalJson, digest, exactRecord, safeId, sha256 } from "./canonical.js";
import { type SignedValue, verifyExternalSignedValue } from "./execution.js";
import { QualityCampaignAuthorityPolicy } from "./release.js";

export const DELETABLE_CAMPAIGN_KINDS = Object.freeze(["derived_index", "temporary_prompt",
  "temporary_projection"] as const);
export const PROTECTED_SOURCE_KINDS = Object.freeze(["final_transcript", "meeting_database",
  "original_craig_recording"] as const);
type CleanupTarget = { readonly artifactId: string;
  readonly kind: typeof DELETABLE_CAMPAIGN_KINDS[number] };
export type ProtectedOriginal = { readonly artifactId: string; readonly artifactSha256: string;
  readonly kind: typeof PROTECTED_SOURCE_KINDS[number] };

export interface CampaignCreatedTargetInventory {
  readonly campaignRootSha256: string; readonly protectedOriginals: readonly ProtectedOriginal[];
  readonly releaseRootSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_campaign_target_inventory.v2";
  readonly targets: readonly CleanupTarget[];
}
export interface CleanupManifest {
  readonly campaignRootSha256: string; readonly inventoryReceiptSha256: string;
  readonly protectedOriginals: readonly ProtectedOriginal[]; readonly releaseRootSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_cleanup_manifest.v5";
  readonly targets: readonly CleanupTarget[];
}

export function verifyCampaignCreatedTargetInventory(policy: QualityCampaignAuthorityPolicy,
  input: { readonly authorityKeyId: string; readonly campaignRootSha256: string;
  readonly receipt: unknown; readonly releaseRootSha256: string;
  readonly targetInventoryAuthorityKeySha256: string }): { readonly manifest: CleanupManifest;
    readonly receipt: SignedValue<CampaignCreatedTargetInventory> } {
  const authority = policy.assertReference("inventory", input.authorityKeyId);
  if (authority.publicKeyFingerprintSha256 !==
    digest(input.targetInventoryAuthorityKeySha256, "target inventory authority key")) {
    throw new Error("campaign target inventory authority is not pinned by release");
  }
  const receipt = verifyExternalSignedValue<CampaignCreatedTargetInventory>(input.receipt,
    authority.keyId, authority.publicKeyPem, "campaign-created target inventory");
  const inventory = decodeTargetInventory(receipt.payload);
  if (inventory.campaignRootSha256 !== input.campaignRootSha256 ||
    inventory.releaseRootSha256 !== input.releaseRootSha256) {
    throw new Error("campaign target inventory is foreign");
  }
  return Object.freeze({ manifest: Object.freeze({ campaignRootSha256: input.campaignRootSha256,
    inventoryReceiptSha256: sha256(receipt), protectedOriginals: inventory.protectedOriginals,
    releaseRootSha256: input.releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_cleanup_manifest.v5",
    targets: inventory.targets }), receipt });
}

export function verifyCleanupAbsenceReceipt(policy: QualityCampaignAuthorityPolicy, input: {
  readonly authorityKeyId: string; readonly cleanupManifest: CleanupManifest;
  readonly receipt: unknown }): SignedValue<unknown> {
  const authority = policy.assertReference("cleanup", input.authorityKeyId);
  const receipt = verifyExternalSignedValue(input.receipt, input.authorityKeyId,
    authority.publicKeyPem, "cleanup absence receipt");
  const cleanupManifest = decodeCleanupManifest(input.cleanupManifest);
  const payload = exactRecord(receipt.payload, ["absentArtifactIds", "absentArtifactIdsSha256",
    "campaignRootSha256", "cleanupManifestSha256", "presentProtectedOriginals",
    "presentProtectedOriginalsSha256", "releaseRootSha256", "schemaVersion"],
  "cleanup absence payload");
  const targetIds = cleanupManifest.targets.map(({ artifactId }) => artifactId).toSorted();
  const protectedOriginals = sortProtectedOriginals(cleanupManifest.protectedOriginals);
  const absentIds = decodeArtifactIds(payload.absentArtifactIds, "cleanup absence");
  const presentOriginals = decodeProtectedOriginals(payload.presentProtectedOriginals,
    "protected presence");
  if (payload.schemaVersion !== "meeting_knowledge.semantic_quality_cleanup_absence.v5" ||
    payload.campaignRootSha256 !== cleanupManifest.campaignRootSha256 ||
    payload.releaseRootSha256 !== cleanupManifest.releaseRootSha256 ||
    payload.cleanupManifestSha256 !== sha256(cleanupManifest) ||
    canonicalJson(absentIds) !== canonicalJson(targetIds) ||
    payload.absentArtifactIdsSha256 !== sha256(targetIds) ||
    canonicalJson(sortProtectedOriginals(presentOriginals)) !== canonicalJson(protectedOriginals) ||
    payload.presentProtectedOriginalsSha256 !== sha256(protectedOriginals)) {
    throw new Error("cleanup absence and protected presence receipt is not authoritative");
  }
  assertDisjointArtifactIds(absentIds, presentOriginals.map(({ artifactId }) => artifactId),
    "cleanup absence and protected presence overlap");
  return receipt;
}

function decodeTargetInventory(value: unknown): CampaignCreatedTargetInventory {
  const record = exactRecord(value, ["campaignRootSha256", "protectedOriginals",
    "releaseRootSha256", "schemaVersion", "targets"], "campaign target inventory");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_campaign_target_inventory.v2") {
    throw new Error("campaign target inventory schema is invalid");
  }
  const targets = decodeTypedArtifacts(record.targets, DELETABLE_CAMPAIGN_KINDS,
    "campaign target") as readonly CleanupTarget[];
  const protectedOriginals = decodeProtectedOriginals(record.protectedOriginals,
    "protected original");
  validateArtifactSets(targets, protectedOriginals, "campaign cleanup targets");
  return Object.freeze({ campaignRootSha256: digest(record.campaignRootSha256,
    "target inventory campaign root"), protectedOriginals,
  releaseRootSha256: digest(record.releaseRootSha256, "target inventory release root"),
  schemaVersion: "meeting_knowledge.semantic_quality_campaign_target_inventory.v2", targets });
}

function decodeCleanupManifest(value: unknown): CleanupManifest {
  const record = exactRecord(value, ["campaignRootSha256", "inventoryReceiptSha256",
    "protectedOriginals", "releaseRootSha256", "schemaVersion", "targets"], "cleanup manifest");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_cleanup_manifest.v5") {
    throw new Error("cleanup manifest is invalid");
  }
  const targets = decodeTypedArtifacts(record.targets, DELETABLE_CAMPAIGN_KINDS,
    "cleanup target") as readonly CleanupTarget[];
  const protectedOriginals = decodeProtectedOriginals(record.protectedOriginals,
    "protected original");
  validateArtifactSets(targets, protectedOriginals, "cleanup manifest targets");
  return Object.freeze({ campaignRootSha256: digest(record.campaignRootSha256,
    "cleanup campaign root"), inventoryReceiptSha256: digest(record.inventoryReceiptSha256,
    "cleanup inventory receipt"), protectedOriginals,
  releaseRootSha256: digest(record.releaseRootSha256, "cleanup release root"),
  schemaVersion: "meeting_knowledge.semantic_quality_cleanup_manifest.v5", targets });
}

function validateArtifactSets(targets: readonly CleanupTarget[],
  protectedOriginals: readonly ProtectedOriginal[], label: string): void {
  if (targets.length === 0) {
    throw new Error(`${label} inventory is incomplete`);
  }
  assertDisjointArtifactIds(targets.map(({ artifactId }) => artifactId),
    protectedOriginals.map(({ artifactId }) => artifactId), `${label} overlap protected originals`);
}

function decodeProtectedOriginals(value: unknown, label: string): readonly ProtectedOriginal[] {
  if (!Array.isArray(value)) {throw new Error(`${label} inventory is invalid`);}
  const originals = value.map((entry) => {
    const item = exactRecord(entry, ["artifactId", "artifactSha256", "kind"], label);
    if (!PROTECTED_SOURCE_KINDS.includes(String(item.kind) as never)) {
      throw new Error(`${label} kind is invalid`);
    }
    return Object.freeze({ artifactId: safeId(item.artifactId, `${label} ID`),
      artifactSha256: digest(item.artifactSha256, `${label} digest`),
      kind: String(item.kind) as ProtectedOriginal["kind"] });
  });
  if (originals.length !== PROTECTED_SOURCE_KINDS.length ||
    new Set(originals.map(({ artifactId }) => artifactId)).size !== originals.length ||
    new Set(originals.map(({ artifactSha256 }) => artifactSha256)).size !== originals.length ||
    new Set(originals.map(({ kind }) => kind)).size !== originals.length ||
    PROTECTED_SOURCE_KINDS.some((kind) => !originals.some((item) => item.kind === kind))) {
    throw new Error(`${label} inventory is incomplete or duplicated`);
  }
  return Object.freeze(originals);
}

function sortProtectedOriginals(values: readonly ProtectedOriginal[]): readonly ProtectedOriginal[] {
  return values.toSorted((left, right) => left.kind.localeCompare(right.kind));
}

function decodeTypedArtifacts(value: unknown, kinds: readonly string[], label: string):
readonly { readonly artifactId: string; readonly kind: string }[] {
  if (!Array.isArray(value)) {throw new Error(`${label} inventory is invalid`);}
  const items = value.map((entry) => {const item = exactRecord(entry, ["artifactId", "kind"], label);
    if (!kinds.includes(String(item.kind))) {throw new Error(`${label} kind is invalid`);}
    return Object.freeze({ artifactId: safeId(item.artifactId, `${label} ID`),
      kind: String(item.kind) });});
  if (new Set(items.map(({ artifactId }) => artifactId)).size !== items.length) {
    throw new Error(`${label} membership is duplicated`);
  }
  return Object.freeze(items);
}

function decodeArtifactIds(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {throw new Error(`${label} inventory is invalid`);}
  const ids = value.map((artifactId) => safeId(artifactId, `${label} artifact ID`));
  if (new Set(ids).size !== ids.length) {throw new Error(`${label} inventory is duplicated`);}
  return ids.toSorted();
}

function assertDisjointArtifactIds(left: readonly string[], right: readonly string[],
  message: string): void {
  const leftIds = new Set(left); if (right.some((id) => leftIds.has(id))) {throw new Error(message);}
}
