import { createDecipheriv } from "node:crypto";

import { MAIN_CARDINALITY, type AdmissionAuthority } from "./admission.js";
import { artifactAttemptIdentity, type ArtifactAad, type ArtifactReceipt,
} from "./artifacts.js";
import { canonicalJson, digest, exactRecord, publicKeyFingerprintSha256,
  safeId, sha256 } from "./canonical.js";
import { assertAttemptIdentity, type AttemptIdentity, type SignedValue,
  verifyExternalSignedValue } from "./execution.js";

export const REQUIRED_RETAINED_KINDS = Object.freeze([
  "capability_request", "capability_response", "retrieval_request", "retrieval_response",
  "evidence", "answer_request", "answer_response", "raw_outcome", "adjudication_input",
  "adjudicator_1_result", "adjudicator_2_result", "final_adjudication",
] as const);
export type RetainedArtifactKind = typeof REQUIRED_RETAINED_KINDS[number] | "resolver_result";

export interface RetainedArtifact {
  readonly aadSha256: string;
  readonly artifactBindingSha256: string;
  readonly attemptId: string;
  readonly envelopeSha256: string;
  readonly keyId: string;
  readonly keyBindingSha256: string;
  readonly kind: RetainedArtifactKind;
  readonly plaintextSha256: string;
  readonly questionId: string;
  readonly repetition: 1 | 2 | 3;
  readonly storedBytes: number;
}

export interface ExpectedOutcomeInventory {
  readonly artifactBindingSha256ByKind: Readonly<Partial<Record<RetainedArtifactKind, string>>>;
  readonly finalAdjudicationSha256: string;
  readonly identity: AttemptIdentity;
  readonly resolverRequired: boolean;
}

export interface ArtifactCustodyPort {
  loadKey(input: { readonly keyId: string }): Promise<{
    readonly key: Uint8Array;
    readonly keyCustodySha256: string;
  } | null>;
  readEnvelope(input: { readonly envelopeSha256: string }): Promise<Uint8Array | null>;
}

export function retainedArtifactFromReceipt(receipt: ArtifactReceipt): RetainedArtifact {
  return Object.freeze({ aadSha256: receipt.aadSha256,
    artifactBindingSha256: receipt.artifactBindingSha256, attemptId: receipt.attemptId,
    envelopeSha256: receipt.envelopeSha256, keyBindingSha256: receipt.keyBindingSha256,
    keyId: receipt.keyId, kind: receipt.artifactKind, plaintextSha256: receipt.plaintextSha256,
    questionId: receipt.questionId, repetition: receipt.repetition,
    storedBytes: receipt.storedBytes });
}

export async function verifyExactRetentionInventory(input: { readonly artifacts:
  readonly RetainedArtifact[]; readonly artifactKeyCustodySha256: string;
  readonly campaignByteCeiling: number; readonly custody: ArtifactCustodyPort;
  readonly expectedOutcomes: readonly ExpectedOutcomeInventory[] }): Promise<{
    readonly artifactCount: number; readonly inventorySha256: string;
    readonly totalStoredBytes: number }> {
  digest(input.artifactKeyCustodySha256, "artifact key custody");
  const expected = buildExpectedMembership(input.expectedOutcomes);
  const seen: RetentionSeen = { aadDigests: new Set(), artifactBindings: new Set(),
    envelopeDigests: new Set(), keyBindings: new Set(), memberships: new Set() };
  let totalStoredBytes = 0;
  for (const artifact of input.artifacts) {
    await admitRetainedArtifact(artifact, expected, seen, input.custody,
      input.artifactKeyCustodySha256);
    totalStoredBytes += artifact.storedBytes;
    if (!Number.isSafeInteger(totalStoredBytes)) {
      throw new Error("retained inventory byte count is invalid");
    }
  }
  if (canonicalJson([...seen.memberships].toSorted()) !==
    canonicalJson([...expected.keys()].toSorted())) {
    throw new Error("retained inventory has missing or orphan artifacts");
  }
  if (!Number.isSafeInteger(input.campaignByteCeiling) ||
    totalStoredBytes > input.campaignByteCeiling) {
    throw new Error("retained inventory exceeds campaign byte ceiling");
  }
  return Object.freeze({ artifactCount: seen.memberships.size,
    inventorySha256: sha256([...input.artifacts].toSorted((a, b) =>
      `${a.attemptId}:${a.kind}`.localeCompare(`${b.attemptId}:${b.kind}`))), totalStoredBytes });
}

interface ExpectedArtifactMembership {
  readonly artifactBindingSha256: string;
  readonly finalAdjudicationSha256: string;
  readonly identity: AttemptIdentity;
  readonly kind: RetainedArtifactKind;
}

interface RetentionSeen {
  readonly aadDigests: Set<string>;
  readonly artifactBindings: Set<string>;
  readonly envelopeDigests: Set<string>;
  readonly keyBindings: Set<string>;
  readonly memberships: Set<string>;
}

function buildExpectedMembership(outcomes: readonly ExpectedOutcomeInventory[]):
Map<string, ExpectedArtifactMembership> {
  if (outcomes.length !== MAIN_CARDINALITY.total ||
    new Set(outcomes.map(({ identity }) => identity.attemptId)).size !== MAIN_CARDINALITY.total) {
    throw new Error("expected outcome inventory is not exactly 3 x 240");
  }
  const repetitionQuestions = new Map<number, Set<string>>();
  const expected = new Map<string, ExpectedArtifactMembership>();
  for (const outcome of outcomes) {
    assertAttemptIdentity(outcome.identity);
    digest(outcome.finalAdjudicationSha256, "expected final adjudication");
    if (outcome.identity.callKind !== "answer" || outcome.identity.callOrdinal !== 0) {
      throw new Error("expected outcome does not use canonical answer call semantics");
    }
    const questions = repetitionQuestions.get(outcome.identity.repetition) ?? new Set<string>();
    if (questions.has(outcome.identity.questionId)) {
      throw new Error("expected outcome question membership is duplicated");
    }
    questions.add(outcome.identity.questionId);
    repetitionQuestions.set(outcome.identity.repetition, questions);
    const requiredKinds: readonly RetainedArtifactKind[] = outcome.resolverRequired ?
      [...REQUIRED_RETAINED_KINDS, "resolver_result"] : REQUIRED_RETAINED_KINDS;
    if (canonicalJson(Object.keys(outcome.artifactBindingSha256ByKind).toSorted()) !==
      canonicalJson([...requiredKinds].toSorted())) {
      throw new Error("expected artifact binding inventory is not exact");
    }
    for (const kind of requiredKinds) {
      const identity = artifactAttemptIdentity(outcome.identity, kind);
      const artifactBindingSha256 = digest(outcome.artifactBindingSha256ByKind[kind],
        "expected artifact binding");
      expected.set(`${identity.attemptId}:${kind}`, { artifactBindingSha256,
        finalAdjudicationSha256: outcome.finalAdjudicationSha256, identity, kind });
    }
  }
  const questionSets = [1, 2, 3].map((repetition) =>
    canonicalJson([...(repetitionQuestions.get(repetition) ?? [])].toSorted()));
  if ([1, 2, 3].some((repetition) => repetitionQuestions.get(repetition)?.size !==
    MAIN_CARDINALITY.perRepetition) || new Set(questionSets).size !== 1) {
    throw new Error("expected outcome inventory does not contain three exact repetitions");
  }
  return expected;
}

async function admitRetainedArtifact(artifact: RetainedArtifact,
  expected: ReadonlyMap<string, ExpectedArtifactMembership>, seen: RetentionSeen,
  custody: ArtifactCustodyPort, artifactKeyCustodySha256: string): Promise<void> {
  exactRecord(artifact, ["aadSha256", "artifactBindingSha256", "attemptId", "envelopeSha256",
    "keyBindingSha256", "keyId", "kind", "plaintextSha256", "questionId", "repetition",
    "storedBytes"], "retained artifact");
  const membership = `${artifact.attemptId}:${artifact.kind}`;
  const expectedArtifact = expected.get(membership);
  for (const [label, value] of [["AAD", artifact.aadSha256],
    ["artifact binding", artifact.artifactBindingSha256], ["envelope", artifact.envelopeSha256],
    ["key binding", artifact.keyBindingSha256], ["plaintext", artifact.plaintextSha256]]) {
    digest(value, `retained ${label}`);
  }
  safeId(artifact.keyId, "retained key ID");
  const keyBindingSha256 = sha256({ attemptId: artifact.attemptId, keyId: artifact.keyId,
    kind: artifact.kind, questionId: artifact.questionId, repetition: artifact.repetition,
    schemaVersion: "meeting_knowledge.semantic_quality_retained_key_binding.v1" });
  const artifactBindingSha256 = sha256({ aadSha256: artifact.aadSha256,
    attemptId: artifact.attemptId, envelopeSha256: artifact.envelopeSha256,
    keyBindingSha256, keyId: artifact.keyId, kind: artifact.kind,
    plaintextSha256: artifact.plaintextSha256, questionId: artifact.questionId,
    repetition: artifact.repetition, storedBytes: artifact.storedBytes,
    schemaVersion: "meeting_knowledge.semantic_quality_retained_artifact_binding.v1" });
  if (expectedArtifact === undefined) {
    throw new Error("retained inventory contains an orphan artifact");
  }
  assertArtifactBinding(artifact, expectedArtifact, keyBindingSha256, artifactBindingSha256);
  assertArtifactUnique(artifact, membership, seen);
  const [envelopeBytes, keyMaterial] = await Promise.all([
    custody.readEnvelope({ envelopeSha256: artifact.envelopeSha256 }),
    custody.loadKey({ keyId: artifact.keyId }),
  ]);
  if (envelopeBytes === null || keyMaterial === null ||
    keyMaterial.keyCustodySha256 !== artifactKeyCustodySha256 ||
    keyMaterial.key.byteLength !== 32 || envelopeBytes.byteLength !== artifact.storedBytes ||
    sha256(envelopeBytes) !== artifact.envelopeSha256) {
    throw new Error("retained envelope or pinned key custody does not exist");
  }
  const envelope = decodeStoredEnvelope(envelopeBytes);
  const aad = expectedAad(artifact, expectedArtifact.identity);
  if (canonicalJson(envelope.aad) !== canonicalJson(aad) || artifact.aadSha256 !== sha256(aad)) {
    throw new Error("retained envelope AAD identity is foreign");
  }
  const plaintext = authenticateEnvelope(envelope, keyMaterial.key);
  if (sha256(plaintext) !== artifact.plaintextSha256 || artifact.kind === "final_adjudication" &&
    sha256(plaintext) !== expectedArtifact.finalAdjudicationSha256) {
    throw new Error("retained plaintext does not bind the exact final adjudication");
  }
  seen.memberships.add(membership);
  seen.aadDigests.add(artifact.aadSha256);
  seen.artifactBindings.add(artifact.artifactBindingSha256);
  seen.envelopeDigests.add(artifact.envelopeSha256);
  seen.keyBindings.add(artifact.keyBindingSha256);
}

function expectedAad(artifact: RetainedArtifact, identity: AttemptIdentity): ArtifactAad {
  return { artifactKind: artifact.kind, attemptId: identity.attemptId,
    callKind: identity.callKind, callOrdinal: identity.callOrdinal,
    campaignRootSha256: identity.campaignRootSha256, keyId: artifact.keyId,
    plaintextSha256: artifact.plaintextSha256,
    questionDigestSha256: identity.questionDigestSha256, questionId: identity.questionId,
    releaseRootSha256: identity.releaseRootSha256, repetition: identity.repetition,
    schemaVersion: "meeting_knowledge.semantic_quality_artifact_aad.v3",
    spendReservationSha256: identity.spendReservationSha256 };
}

function assertArtifactBinding(artifact: RetainedArtifact, expected: ExpectedArtifactMembership,
  keyBindingSha256: string, artifactBindingSha256: string): void {
  if (expected.identity.questionId !== artifact.questionId ||
    expected.identity.repetition !== artifact.repetition ||
    !Number.isSafeInteger(artifact.storedBytes) || artifact.storedBytes < 1 ||
    expected.artifactBindingSha256 !== artifact.artifactBindingSha256 ||
    artifact.keyBindingSha256 !== keyBindingSha256 ||
    artifact.artifactBindingSha256 !== artifactBindingSha256) {
    throw new Error("retained inventory contains corruption");
  }
}

function assertArtifactUnique(artifact: RetainedArtifact, membership: string,
  seen: RetentionSeen): void {
  if (seen.memberships.has(membership) || seen.aadDigests.has(artifact.aadSha256) ||
    seen.envelopeDigests.has(artifact.envelopeSha256) ||
    seen.keyBindings.has(artifact.keyBindingSha256) ||
    seen.artifactBindings.has(artifact.artifactBindingSha256)) {
    throw new Error("retained inventory contains duplicates");
  }
}

interface StoredEnvelope {
  readonly aad: unknown;
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly tag: Uint8Array;
}

function decodeStoredEnvelope(bytes: Uint8Array): StoredEnvelope {
  let value: unknown;
  try {value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;} catch {
    throw new Error("retained envelope is not canonical JSON");
  }
  const record = exactRecord(value, ["aad", "algorithm", "ciphertextBase64", "nonceBase64",
    "tagBase64"], "retained envelope");
  if (record.algorithm !== "A256GCM" || ![record.ciphertextBase64, record.nonceBase64,
    record.tagBase64].every((item) => typeof item === "string") ||
    canonicalJson(record) !== Buffer.from(bytes).toString("utf8")) {
    throw new Error("retained envelope encoding is invalid");
  }
  const ciphertext = decodeCanonicalBase64(String(record.ciphertextBase64), "ciphertext");
  const nonce = decodeCanonicalBase64(String(record.nonceBase64), "nonce");
  const tag = decodeCanonicalBase64(String(record.tagBase64), "authentication tag");
  if (nonce.byteLength !== 12 || tag.byteLength !== 16 || ciphertext.byteLength < 1) {
    throw new Error("retained AES-256-GCM envelope is invalid");
  }
  return { aad: record.aad, ciphertext, nonce, tag };
}

function decodeCanonicalBase64(value: string, label: string): Uint8Array {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new Error(`retained envelope ${label} is not canonical base64`);
  }
  return bytes;
}

function authenticateEnvelope(envelope: StoredEnvelope, key: Uint8Array): Uint8Array {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, envelope.nonce);
    decipher.setAAD(Buffer.from(canonicalJson(envelope.aad)));
    decipher.setAuthTag(envelope.tag);
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
  } catch {
    throw new Error("retained envelope AES-256-GCM authentication failed");
  }
}

export const DELETABLE_CAMPAIGN_KINDS = Object.freeze(["derived_index", "temporary_prompt",
  "temporary_projection"] as const);
export const PROTECTED_SOURCE_KINDS = Object.freeze(["authoritative_transcript", "final_transcript",
  "meeting_database", "original_craig_recording", "summary"] as const);

type CleanupTarget = { readonly artifactId: string;
  readonly kind: typeof DELETABLE_CAMPAIGN_KINDS[number] };
type ProtectedOriginal = { readonly artifactId: string;
  readonly kind: typeof PROTECTED_SOURCE_KINDS[number] };

export interface CampaignCreatedTargetInventory {
  readonly campaignRootSha256: string;
  readonly protectedOriginals: readonly ProtectedOriginal[];
  readonly releaseRootSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_campaign_target_inventory.v1";
  readonly targets: readonly CleanupTarget[];
}

export interface CleanupManifest {
  readonly campaignRootSha256: string;
  readonly inventoryReceiptSha256: string;
  readonly protectedOriginals: readonly ProtectedOriginal[];
  readonly releaseRootSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_cleanup_manifest.v4";
  readonly targets: readonly CleanupTarget[];
}

export function verifyCampaignCreatedTargetInventory(input: { readonly authority:
  AdmissionAuthority; readonly campaignRootSha256: string; readonly receipt: unknown;
  readonly releaseRootSha256: string;
  readonly targetInventoryAuthorityKeySha256: string }): { readonly manifest: CleanupManifest;
    readonly receipt: SignedValue<CampaignCreatedTargetInventory> } {
  if (publicKeyFingerprintSha256(input.authority.publicKeyPem, "target inventory authority") !==
    digest(input.targetInventoryAuthorityKeySha256, "target inventory authority key")) {
    throw new Error("campaign target inventory authority is not pinned by release");
  }
  const receipt = verifyExternalSignedValue<CampaignCreatedTargetInventory>(input.receipt,
    input.authority.keyId, input.authority.publicKeyPem, "campaign-created target inventory");
  const inventory = decodeTargetInventory(receipt.payload);
  if (inventory.campaignRootSha256 !== input.campaignRootSha256 ||
    inventory.releaseRootSha256 !== input.releaseRootSha256) {
    throw new Error("campaign target inventory is foreign");
  }
  return Object.freeze({ manifest: Object.freeze({ campaignRootSha256: input.campaignRootSha256,
    inventoryReceiptSha256: sha256(receipt), protectedOriginals: inventory.protectedOriginals,
    releaseRootSha256: input.releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_cleanup_manifest.v4",
    targets: inventory.targets }), receipt });
}

export function verifyCleanupAbsenceReceipt(input: { readonly authorityKeyId: string;
  readonly authorityPublicKeyPem: string; readonly cleanupManifest: CleanupManifest;
  readonly receipt: unknown }): SignedValue<unknown> {
  const receipt = verifyExternalSignedValue(input.receipt, input.authorityKeyId,
    input.authorityPublicKeyPem, "cleanup absence receipt");
  const cleanupManifest = decodeCleanupManifest(input.cleanupManifest);
  const payload = exactRecord(receipt.payload, ["absentArtifactIds", "absentArtifactIdsSha256",
    "campaignRootSha256", "cleanupManifestSha256", "presentProtectedArtifactIds",
    "presentProtectedArtifactIdsSha256", "releaseRootSha256", "schemaVersion"],
  "cleanup absence payload");
  const targetIds = cleanupManifest.targets.map(({ artifactId }) => artifactId).toSorted();
  const protectedIds = cleanupManifest.protectedOriginals.map(({ artifactId }) => artifactId)
    .toSorted();
  const absentIds = decodeArtifactIds(payload.absentArtifactIds, "cleanup absence");
  const presentIds = decodeArtifactIds(payload.presentProtectedArtifactIds, "protected presence");
  if (payload.schemaVersion !== "meeting_knowledge.semantic_quality_cleanup_absence.v4" ||
    payload.campaignRootSha256 !== cleanupManifest.campaignRootSha256 ||
    payload.releaseRootSha256 !== cleanupManifest.releaseRootSha256 ||
    payload.cleanupManifestSha256 !== sha256(cleanupManifest) ||
    canonicalJson(absentIds) !== canonicalJson(targetIds) ||
    payload.absentArtifactIdsSha256 !== sha256(targetIds) ||
    canonicalJson(presentIds) !== canonicalJson(protectedIds) ||
    payload.presentProtectedArtifactIdsSha256 !== sha256(protectedIds)) {
    throw new Error("cleanup absence and protected presence receipt is not authoritative");
  }
  return receipt;
}

function decodeTargetInventory(value: unknown): CampaignCreatedTargetInventory {
  const record = exactRecord(value, ["campaignRootSha256", "protectedOriginals",
    "releaseRootSha256", "schemaVersion", "targets"], "campaign target inventory");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_campaign_target_inventory.v1") {
    throw new Error("campaign target inventory schema is invalid");
  }
  const targets = decodeTypedArtifacts(record.targets, DELETABLE_CAMPAIGN_KINDS,
    "campaign target") as readonly CleanupTarget[];
  const protectedOriginals = decodeTypedArtifacts(record.protectedOriginals,
    PROTECTED_SOURCE_KINDS, "protected original") as readonly ProtectedOriginal[];
  if (targets.length === 0 || protectedOriginals.length === 0) {
    throw new Error("campaign target inventory is incomplete");
  }
  return Object.freeze({ campaignRootSha256: digest(record.campaignRootSha256,
    "target inventory campaign root"), protectedOriginals,
  releaseRootSha256: digest(record.releaseRootSha256, "target inventory release root"),
  schemaVersion: "meeting_knowledge.semantic_quality_campaign_target_inventory.v1", targets });
}

function decodeCleanupManifest(value: unknown): CleanupManifest {
  const record = exactRecord(value, ["campaignRootSha256", "inventoryReceiptSha256",
    "protectedOriginals", "releaseRootSha256", "schemaVersion", "targets"],
  "cleanup manifest");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_cleanup_manifest.v4") {
    throw new Error("cleanup manifest is invalid");
  }
  const targets = decodeTypedArtifacts(record.targets, DELETABLE_CAMPAIGN_KINDS,
    "cleanup target") as readonly CleanupTarget[];
  const protectedOriginals = decodeTypedArtifacts(record.protectedOriginals,
    PROTECTED_SOURCE_KINDS, "protected original") as readonly ProtectedOriginal[];
  if (targets.length === 0 || protectedOriginals.length === 0) {
    throw new Error("cleanup manifest is incomplete");
  }
  return Object.freeze({ campaignRootSha256: digest(record.campaignRootSha256,
    "cleanup campaign root"), inventoryReceiptSha256: digest(record.inventoryReceiptSha256,
    "cleanup inventory receipt"), protectedOriginals,
  releaseRootSha256: digest(record.releaseRootSha256, "cleanup release root"),
  schemaVersion: "meeting_knowledge.semantic_quality_cleanup_manifest.v4", targets });
}

function decodeTypedArtifacts(value: unknown, kinds: readonly string[], label: string):
readonly { readonly artifactId: string; readonly kind: string }[] {
  if (!Array.isArray(value)) {throw new Error(`${label} inventory is invalid`);}
  const items = value.map((entry) => {
    const item = exactRecord(entry, ["artifactId", "kind"], label);
    if (!kinds.includes(String(item.kind))) {throw new Error(`${label} kind is invalid`);}
    return Object.freeze({ artifactId: safeId(item.artifactId, `${label} ID`),
      kind: String(item.kind) });
  });
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
