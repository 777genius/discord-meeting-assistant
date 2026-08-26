import { canonicalJson, digest, exactRecord, safeId, sha256 } from "./canonical.js";
import { MAIN_CARDINALITY } from "./admission.js";
import type { ArtifactAad, ArtifactReceipt } from "./artifacts.js";
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
  readonly identity: AttemptIdentity;
  readonly resolverRequired: boolean;
}

export interface ArtifactStoreVerificationPort {
  /** Returns bytes only after the authoritative store has opened and authenticated the envelope. */
  openVerified(input: { readonly envelopeSha256: string; readonly keyId: string }): Promise<{
    readonly envelopeBytes: Uint8Array;
    readonly plaintext: Uint8Array;
  } | null>;
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
  readonly RetainedArtifact[]; readonly campaignByteCeiling: number;
  readonly expectedOutcomes: readonly ExpectedOutcomeInventory[];
  readonly store: ArtifactStoreVerificationPort }): Promise<{
    readonly artifactCount: number; readonly inventorySha256: string;
    readonly totalStoredBytes: number }> {
  const expected = buildExpectedMembership(input.expectedOutcomes);
  const seen: RetentionSeen = { aadDigests: new Set(), artifactBindings: new Set(),
    envelopeDigests: new Set(), keyBindings: new Set(), memberships: new Set() };
  let totalStoredBytes = 0;
  for (const artifact of input.artifacts) {
    await admitRetainedArtifact(artifact, expected, seen, input.store);
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

interface RetentionSeen {
  readonly aadDigests: Set<string>;
  readonly artifactBindings: Set<string>;
  readonly envelopeDigests: Set<string>;
  readonly keyBindings: Set<string>;
  readonly memberships: Set<string>;
}

function buildExpectedMembership(outcomes: readonly ExpectedOutcomeInventory[]):
Map<string, ExpectedOutcomeInventory> {
  if (outcomes.length !== MAIN_CARDINALITY.total ||
    new Set(outcomes.map(({ identity }) => identity.attemptId)).size !== MAIN_CARDINALITY.total) {
    throw new Error("expected outcome inventory is not exactly 3 x 240");
  }
  const repetitionQuestions = new Map<number, Set<string>>();
  const expected = new Map<string, ExpectedOutcomeInventory>();
  for (const outcome of outcomes) {
    assertAttemptIdentity(outcome.identity);
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
      digest(outcome.artifactBindingSha256ByKind[kind], "expected artifact binding");
      expected.set(`${outcome.identity.attemptId}:${kind}`, outcome);
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
  expected: ReadonlyMap<string, ExpectedOutcomeInventory>, seen: RetentionSeen,
  store: ArtifactStoreVerificationPort): Promise<void> {
  exactRecord(artifact, ["aadSha256", "artifactBindingSha256", "attemptId", "envelopeSha256",
    "keyBindingSha256", "keyId", "kind", "plaintextSha256", "questionId", "repetition",
    "storedBytes"], "retained artifact");
  const membership = `${artifact.attemptId}:${artifact.kind}`;
  const outcome = expected.get(membership);
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
  if (outcome === undefined) {throw new Error("retained inventory contains an orphan artifact");}
  assertArtifactBinding(artifact, outcome, keyBindingSha256, artifactBindingSha256);
  assertArtifactUnique(artifact, membership, seen);
  const opened = await store.openVerified({ envelopeSha256: artifact.envelopeSha256,
    keyId: artifact.keyId });
  if (opened === null || opened.envelopeBytes.byteLength !== artifact.storedBytes ||
    sha256(opened.envelopeBytes) !== artifact.envelopeSha256 ||
    sha256(opened.plaintext) !== artifact.plaintextSha256) {
    throw new Error("retained envelope does not exist or cannot be authenticated");
  }
  const envelope = decodeStoredEnvelope(opened.envelopeBytes);
  const aad: ArtifactAad = { artifactKind: artifact.kind,
    attemptId: outcome.identity.attemptId, callKind: outcome.identity.callKind,
    callOrdinal: outcome.identity.callOrdinal,
    campaignRootSha256: outcome.identity.campaignRootSha256, keyId: artifact.keyId,
    plaintextSha256: artifact.plaintextSha256,
    questionDigestSha256: outcome.identity.questionDigestSha256,
    questionId: outcome.identity.questionId,
    releaseRootSha256: outcome.identity.releaseRootSha256,
    repetition: outcome.identity.repetition,
    schemaVersion: "meeting_knowledge.semantic_quality_artifact_aad.v3",
    spendReservationSha256: outcome.identity.spendReservationSha256 };
  if (canonicalJson(envelope.aad) !== canonicalJson(aad) ||
    artifact.aadSha256 !== sha256(aad)) {
    throw new Error("retained envelope AAD identity is foreign");
  }
  seen.memberships.add(membership);
  seen.aadDigests.add(artifact.aadSha256);
  seen.artifactBindings.add(artifact.artifactBindingSha256);
  seen.envelopeDigests.add(artifact.envelopeSha256);
  seen.keyBindings.add(artifact.keyBindingSha256);
}

function assertArtifactBinding(artifact: RetainedArtifact, outcome: ExpectedOutcomeInventory,
  keyBindingSha256: string, artifactBindingSha256: string): void {
  if (outcome.identity.questionId !== artifact.questionId ||
    outcome.identity.repetition !== artifact.repetition ||
    !Number.isSafeInteger(artifact.storedBytes) || artifact.storedBytes < 1 ||
    outcome.artifactBindingSha256ByKind[artifact.kind] !== artifact.artifactBindingSha256 ||
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

function decodeStoredEnvelope(bytes: Uint8Array): { readonly aad: unknown } {
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
  return { aad: record.aad };
}

export const DELETABLE_CAMPAIGN_KINDS = Object.freeze(["derived_index", "temporary_prompt",
  "temporary_projection"] as const);
export const PROTECTED_SOURCE_KINDS = Object.freeze(["authoritative_transcript", "final_transcript",
  "meeting_database", "original_craig_recording", "summary"] as const);

export interface CleanupManifest {
  readonly campaignRootSha256: string;
  readonly protectedKinds: typeof PROTECTED_SOURCE_KINDS;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_cleanup_manifest.v3";
  readonly targets: readonly { readonly artifactId: string;
    readonly kind: typeof DELETABLE_CAMPAIGN_KINDS[number] }[];
}

export function createCleanupManifest(input: { readonly campaignRootSha256: string;
  readonly targets: readonly { readonly artifactId: string;
    readonly kind: typeof DELETABLE_CAMPAIGN_KINDS[number] }[] }): CleanupManifest {
  digest(input.campaignRootSha256, "cleanup campaign root");
  if (input.targets.length === 0 || input.targets.some(({ artifactId, kind }) => {
    safeId(artifactId, "cleanup artifact ID");
    return !DELETABLE_CAMPAIGN_KINDS.includes(kind);
  }) || new Set(input.targets.map(({ artifactId }) => artifactId)).size !== input.targets.length) {
    throw new Error("cleanup targets are unsafe or duplicated");
  }
  return Object.freeze({ campaignRootSha256: input.campaignRootSha256,
    protectedKinds: PROTECTED_SOURCE_KINDS, schemaVersion:
    "meeting_knowledge.semantic_quality_cleanup_manifest.v3", targets:
    Object.freeze(input.targets.map((target) => Object.freeze({ ...target }))) });
}

export function verifyCleanupAbsenceReceipt(input: { readonly authorityKeyId: string;
  readonly authorityPublicKeyPem: string; readonly campaignRootSha256: string;
  readonly cleanupManifest: CleanupManifest; readonly receipt: unknown }): SignedValue<unknown> {
  const receipt = verifyExternalSignedValue(input.receipt, input.authorityKeyId,
    input.authorityPublicKeyPem, "cleanup absence receipt");
  const cleanupManifest = decodeCleanupManifest(input.cleanupManifest);
  const payload = exactRecord(receipt.payload, ["absentArtifactIds", "absentArtifactIdsSha256",
    "campaignRootSha256", "cleanupManifestSha256", "protectedSourcePreserved",
    "schemaVersion"], "cleanup absence payload");
  const targetIds = cleanupManifest.targets.map(({ artifactId }) => artifactId)
    .toSorted((left, right) => left.localeCompare(right));
  const absentIds = decodeAbsentArtifactIds(payload.absentArtifactIds);
  if (cleanupManifest.campaignRootSha256 !== input.campaignRootSha256 ||
    payload.schemaVersion !== "meeting_knowledge.semantic_quality_cleanup_absence.v3" ||
    payload.campaignRootSha256 !== input.campaignRootSha256 ||
    payload.cleanupManifestSha256 !== sha256(cleanupManifest) ||
    payload.protectedSourcePreserved !== true ||
    canonicalJson(absentIds) !== canonicalJson(targetIds) ||
    payload.absentArtifactIdsSha256 !== sha256(targetIds)) {
    throw new Error("cleanup absence receipt is not authoritative");
  }
  return receipt;
}

function decodeAbsentArtifactIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((artifactId) => typeof artifactId !== "string")) {
    throw new Error("cleanup absence inventory is invalid");
  }
  return (value as string[]).toSorted((left, right) => left.localeCompare(right));
}

function decodeCleanupManifest(value: unknown): CleanupManifest {
  const record = exactRecord(value, ["campaignRootSha256", "protectedKinds", "schemaVersion",
    "targets"], "cleanup manifest");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_cleanup_manifest.v3" ||
    canonicalJson(record.protectedKinds) !== canonicalJson(PROTECTED_SOURCE_KINDS) ||
    !Array.isArray(record.targets) || record.targets.length === 0) {
    throw new Error("cleanup manifest is invalid");
  }
  const targets = record.targets.map((target) => {
    const item = exactRecord(target, ["artifactId", "kind"], "cleanup target");
    if (!DELETABLE_CAMPAIGN_KINDS.includes(item.kind as CleanupManifest["targets"][number]["kind"])) {
      throw new Error("cleanup target kind is unsafe");
    }
    return Object.freeze({ artifactId: safeId(item.artifactId, "cleanup artifact ID"),
      kind: item.kind as CleanupManifest["targets"][number]["kind"] });
  });
  if (new Set(targets.map(({ artifactId }) => artifactId)).size !== targets.length) {
    throw new Error("cleanup manifest target membership is duplicated");
  }
  return Object.freeze({ campaignRootSha256:
    digest(record.campaignRootSha256, "cleanup campaign root"),
    protectedKinds: PROTECTED_SOURCE_KINDS,
    schemaVersion: "meeting_knowledge.semantic_quality_cleanup_manifest.v3",
    targets: Object.freeze(targets) });
}
