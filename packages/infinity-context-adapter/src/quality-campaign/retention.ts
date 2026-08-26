import { createDecipheriv } from "node:crypto";

import { MAIN_CARDINALITY } from "./admission.js";
import { verifyRetainedFinalAdjudication } from "./adjudication.js";
import { artifactAttemptIdentity, type ArtifactAad, type ArtifactReceipt,
} from "./artifacts.js";
import { canonicalJson, digest, exactRecord, safeId, sha256 } from "./canonical.js";
import { assertAttemptIdentity, type AttemptIdentity } from "./execution.js";
import { QualityCampaignAuthorityPolicy } from "./release.js";

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
  readonly abstention: { readonly expected: boolean; readonly observed: boolean };
  readonly artifactBindingSha256ByKind: Readonly<Partial<Record<RetainedArtifactKind, string>>>;
  readonly citationChecks: readonly { readonly claimId: string; readonly entailed: boolean }[];
  readonly claimChecks: readonly { readonly claimId: string; readonly factual: boolean;
    readonly supported: boolean }[];
  readonly evidenceTurnIds: readonly string[];
  readonly finalAdjudicationSha256: string;
  readonly identity: AttemptIdentity;
  readonly rankedLocatorIds: readonly string[];
  readonly relevantLocatorIds: readonly string[];
  readonly resolverRequired: boolean;
  readonly retrievalLatencyUs: number;
  readonly scopeViolationLocatorIds: readonly string[];
  readonly speakerTimeChecks: readonly unknown[];
}

export interface ArtifactCustodyPort {
  loadKey(input: { readonly keyId: string }): Promise<{
    readonly authorityKeyId: string;
    readonly authorityPublicKeyFingerprintSha256: string;
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

export async function verifyExactRetentionInventory(policy: QualityCampaignAuthorityPolicy,
  input: { readonly artifacts:
  readonly RetainedArtifact[]; readonly artifactKeyCustodySha256: string;
  readonly campaignByteCeiling: number; readonly custody: ArtifactCustodyPort;
  readonly expectedOutcomes: readonly ExpectedOutcomeInventory[] }): Promise<{
    readonly artifactCount: number; readonly inventorySha256: string;
    readonly totalStoredBytes: number }> {
  digest(input.artifactKeyCustodySha256, "artifact key custody");
  const expected = buildExpectedMembership(input.expectedOutcomes);
  const seen: RetentionSeen = { aadDigests: new Set(), artifactBindings: new Set(),
    envelopeDigests: new Set(), keyBindings: new Set(), memberships: new Set() };
  const context = { artifactKeyCustodySha256: input.artifactKeyCustodySha256,
    custody: input.custody, expected, seen };
  let totalStoredBytes = 0;
  for (const artifact of input.artifacts) {
    await admitRetainedArtifact(policy, artifact, context);
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
  readonly outcome: ExpectedOutcomeInventory;
  readonly resolverRequired: boolean;
}

interface RetentionSeen {
  readonly aadDigests: Set<string>;
  readonly artifactBindings: Set<string>;
  readonly envelopeDigests: Set<string>;
  readonly keyBindings: Set<string>;
  readonly memberships: Set<string>;
}
interface RetentionContext {
  readonly artifactKeyCustodySha256: string; readonly custody: ArtifactCustodyPort;
  readonly expected: ReadonlyMap<string, ExpectedArtifactMembership>; readonly seen: RetentionSeen;
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
        finalAdjudicationSha256: outcome.finalAdjudicationSha256, identity, kind,
        outcome, resolverRequired: outcome.resolverRequired });
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

async function admitRetainedArtifact(policy: QualityCampaignAuthorityPolicy,
  artifact: RetainedArtifact, context: RetentionContext): Promise<void> {
  exactRecord(artifact, ["aadSha256", "artifactBindingSha256", "attemptId", "envelopeSha256",
    "keyBindingSha256", "keyId", "kind", "plaintextSha256", "questionId", "repetition",
    "storedBytes"], "retained artifact");
  const membership = `${artifact.attemptId}:${artifact.kind}`;
  const expectedArtifact = context.expected.get(membership);
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
  assertArtifactUnique(artifact, membership, context.seen);
  const [envelopeBytes, keyMaterial] = await Promise.all([
    context.custody.readEnvelope({ envelopeSha256: artifact.envelopeSha256 }),
    context.custody.loadKey({ keyId: artifact.keyId }),
  ]);
  const custodyAuthority = policy.authority("artifact_custody");
  if (envelopeBytes === null || keyMaterial === null ||
    keyMaterial.authorityKeyId !== custodyAuthority.keyId ||
    keyMaterial.authorityPublicKeyFingerprintSha256 !==
      custodyAuthority.publicKeyFingerprintSha256 ||
    keyMaterial.keyCustodySha256 !== context.artifactKeyCustodySha256 ||
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
  validateAuthenticatedPlaintext(policy, artifact, expectedArtifact, plaintext);
  context.seen.memberships.add(membership); context.seen.aadDigests.add(artifact.aadSha256);
  context.seen.artifactBindings.add(artifact.artifactBindingSha256);
  context.seen.envelopeDigests.add(artifact.envelopeSha256);
  context.seen.keyBindings.add(artifact.keyBindingSha256);
}

function validateAuthenticatedPlaintext(policy: QualityCampaignAuthorityPolicy,
  artifact: RetainedArtifact, expectedArtifact: ExpectedArtifactMembership,
  plaintext: Uint8Array): void {
  if (artifact.kind === "final_adjudication") {
    const value = decodeCanonicalPlaintext(plaintext, "final adjudication");
    const final = verifyRetainedFinalAdjudication(policy, value, expectedArtifact.identity,
      expectedArtifact.resolverRequired);
    const expectedClaims = expectedArtifact.outcome.claimChecks;
    const claims = final.decision.claims.map(({ claimFactual, claimId, claimSupported }) =>
      ({ claimId, factual: claimFactual, supported: claimSupported }));
    const citations = final.decision.claims.filter(({ claimFactual }) => claimFactual)
      .map(({ citationEntailed, claimId }) => ({ claimId, entailed: citationEntailed }));
    const expectedCitations = expectedArtifact.outcome.citationChecks
      .map(({ claimId, entailed }) => ({ claimId, entailed }));
    const abstentionPassed = expectedArtifact.outcome.abstention.expected ===
      expectedArtifact.outcome.abstention.observed;
    if (canonicalJson(claims) !== canonicalJson(expectedClaims) ||
      canonicalJson(citations) !== canonicalJson(expectedCitations) ||
      final.decision.claims.some(({ abstentionCorrect }) =>
        abstentionCorrect !== abstentionPassed)) {
      throw new Error("final adjudication decisions differ from admitted metric evidence");
    }
  } else if (artifact.kind === "retrieval_response") {
    const value = exactRecord(decodeCanonicalPlaintext(plaintext, "retrieval response"),
      ["attempt", "latencyUs", "rankedLocatorIds", "schemaVersion", "scopeViolationLocatorIds"],
      "retained retrieval response");
    if (value.schemaVersion !== "meeting_knowledge.semantic_quality_retrieval_evidence.v1" ||
      canonicalJson(value.attempt) !== canonicalJson(expectedArtifact.identity) ||
      value.latencyUs !== expectedArtifact.outcome.retrievalLatencyUs ||
      canonicalJson(value.rankedLocatorIds) !==
        canonicalJson(expectedArtifact.outcome.rankedLocatorIds) ||
      canonicalJson(value.scopeViolationLocatorIds) !==
        canonicalJson(expectedArtifact.outcome.scopeViolationLocatorIds)) {
      throw new Error("authenticated retrieval evidence differs from admitted ranking");
    }
  } else if (artifact.kind === "evidence") {
    const value = exactRecord(decodeCanonicalPlaintext(plaintext, "canonical evidence"),
      ["attempt", "evidenceTurnIds", "schemaVersion", "speakerTimeChecks"],
      "retained canonical evidence");
    if (value.schemaVersion !== "meeting_knowledge.semantic_quality_canonical_evidence.v1" ||
      canonicalJson(value.attempt) !== canonicalJson(expectedArtifact.identity) ||
      canonicalJson(value.evidenceTurnIds) !==
        canonicalJson(expectedArtifact.outcome.evidenceTurnIds) ||
      canonicalJson(value.speakerTimeChecks) !==
        canonicalJson(expectedArtifact.outcome.speakerTimeChecks)) {
      throw new Error("authenticated canonical evidence differs from admitted turn observations");
    }
  }
}

function decodeCanonicalPlaintext(plaintext: Uint8Array, label: string): unknown {
  let value: unknown;
  try {value = JSON.parse(Buffer.from(plaintext).toString("utf8")) as unknown;} catch {
    throw new Error(`${label} plaintext is not canonical JSON`);
  }
  if (canonicalJson(value) !== Buffer.from(plaintext).toString("utf8")) {
    throw new Error(`${label} plaintext is not canonical JSON`);
  }
  return value;
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
