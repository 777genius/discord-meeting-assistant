import { canonicalJson, digest, exactRecord, safeId, sha256 } from "./canonical.js";
import { MAIN_CARDINALITY } from "./admission.js";
import type { ArtifactReceipt } from "./artifacts.js";
import { type SignedValue, verifyExternalSignedValue } from "./execution.js";

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
  readonly attemptId: string;
  readonly questionId: string;
  readonly repetition: 1 | 2 | 3;
  readonly resolverRequired: boolean;
}

export function retainedArtifactFromReceipt(receipt: ArtifactReceipt): RetainedArtifact {
  return Object.freeze({ aadSha256: receipt.aadSha256,
    artifactBindingSha256: receipt.artifactBindingSha256, attemptId: receipt.attemptId,
    envelopeSha256: receipt.envelopeSha256, keyBindingSha256: receipt.keyBindingSha256,
    keyId: receipt.keyId, kind: receipt.artifactKind, plaintextSha256: receipt.plaintextSha256,
    questionId: receipt.questionId, repetition: receipt.repetition,
    storedBytes: receipt.storedBytes });
}

export function verifyExactRetentionInventory(input: { readonly artifacts:
  readonly RetainedArtifact[]; readonly campaignByteCeiling: number;
  readonly expectedOutcomes: readonly ExpectedOutcomeInventory[] }): {
    readonly artifactCount: number; readonly inventorySha256: string;
    readonly totalStoredBytes: number } {
  const expected = buildExpectedMembership(input.expectedOutcomes);
  const seen: RetentionSeen = { aadDigests: new Set(), artifactBindings: new Set(),
    envelopeDigests: new Set(), keyBindings: new Set(), memberships: new Set() };
  let totalStoredBytes = 0;
  for (const artifact of input.artifacts) {
    admitRetainedArtifact(artifact, expected, seen);
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
    new Set(outcomes.map(({ attemptId }) => attemptId)).size !== MAIN_CARDINALITY.total) {
    throw new Error("expected outcome inventory is not exactly 3 x 240");
  }
  const repetitionQuestions = new Map<number, Set<string>>();
  const expected = new Map<string, ExpectedOutcomeInventory>();
  for (const outcome of outcomes) {
    safeId(outcome.attemptId, "expected attempt ID");
    safeId(outcome.questionId, "expected question ID");
    if (![1, 2, 3].includes(outcome.repetition)) {
      throw new Error("expected repetition identity is invalid");
    }
    const questions = repetitionQuestions.get(outcome.repetition) ?? new Set<string>();
    if (questions.has(outcome.questionId)) {
      throw new Error("expected outcome question membership is duplicated");
    }
    questions.add(outcome.questionId);
    repetitionQuestions.set(outcome.repetition, questions);
    const requiredKinds: readonly RetainedArtifactKind[] = outcome.resolverRequired ?
      [...REQUIRED_RETAINED_KINDS, "resolver_result"] : REQUIRED_RETAINED_KINDS;
    if (canonicalJson(Object.keys(outcome.artifactBindingSha256ByKind).toSorted()) !==
      canonicalJson([...requiredKinds].toSorted())) {
      throw new Error("expected artifact binding inventory is not exact");
    }
    for (const kind of requiredKinds) {
      digest(outcome.artifactBindingSha256ByKind[kind], "expected artifact binding");
      expected.set(`${outcome.attemptId}:${kind}`, outcome);
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

function admitRetainedArtifact(artifact: RetainedArtifact,
  expected: ReadonlyMap<string, ExpectedOutcomeInventory>, seen: RetentionSeen): void {
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
  if (outcome === undefined || outcome.questionId !== artifact.questionId ||
    outcome.repetition !== artifact.repetition || !Number.isSafeInteger(artifact.storedBytes) ||
    outcome.artifactBindingSha256ByKind[artifact.kind] !== artifact.artifactBindingSha256 ||
    artifact.storedBytes < 1 || seen.memberships.has(membership) ||
    seen.aadDigests.has(artifact.aadSha256) || seen.envelopeDigests.has(artifact.envelopeSha256) ||
    seen.keyBindings.has(artifact.keyBindingSha256) ||
    seen.artifactBindings.has(artifact.artifactBindingSha256) ||
    artifact.keyBindingSha256 !== keyBindingSha256 ||
    artifact.artifactBindingSha256 !== artifactBindingSha256) {
    throw new Error("retained inventory contains corruption or duplicates");
  }
  seen.memberships.add(membership);
  seen.aadDigests.add(artifact.aadSha256);
  seen.artifactBindings.add(artifact.artifactBindingSha256);
  seen.envelopeDigests.add(artifact.envelopeSha256);
  seen.keyBindings.add(artifact.keyBindingSha256);
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

export interface IndependentRepetitionPass {
  readonly campaignRootSha256: string;
  readonly inventorySha256: string;
  readonly metricsBindingSha256: string;
  readonly metricsSha256: string;
  readonly outcomeCount: number;
  readonly repetition: 1 | 2 | 3;
  readonly repetitionIdentitySha256: string;
  readonly rootBindingSha256: string;
  readonly thresholdsPassed: boolean;
}

export function admitFinalCampaign(input: { readonly campaignRootSha256: string;
  readonly cleanupReceiptSha256: string;
  readonly independentRepetitionPasses: readonly IndependentRepetitionPass[];
  readonly inventorySha256: string; readonly outcomeCount: number;
  readonly rootBindingSha256: string }): { readonly finalAdmissionSha256: string;
    readonly qualified: true } {
  if (input.outcomeCount !== MAIN_CARDINALITY.total ||
    input.independentRepetitionPasses.length !== MAIN_CARDINALITY.repetitions) {
    throw new Error("final admission requires three independent 240-outcome repetitions");
  }
  for (const value of [input.campaignRootSha256, input.cleanupReceiptSha256, input.inventorySha256,
    input.rootBindingSha256, ...input.independentRepetitionPasses.map(({ metricsSha256 }) =>
      metricsSha256)]) {digest(value, "final admission digest");}
  const passes = [...input.independentRepetitionPasses].toSorted((left, right) =>
    left.repetition - right.repetition);
  for (const [index, pass] of passes.entries()) {
    const repetition = index + 1;
    const repetitionIdentitySha256 = sha256({ campaignRootSha256: input.campaignRootSha256,
      repetition, rootBindingSha256: input.rootBindingSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_repetition_identity.v1" });
    const metricsBindingSha256 = sha256({ campaignRootSha256: input.campaignRootSha256,
      inventorySha256: input.inventorySha256, metricsSha256: pass.metricsSha256,
      outcomeCount: MAIN_CARDINALITY.perRepetition, repetition,
      repetitionIdentitySha256, rootBindingSha256: input.rootBindingSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_repetition_pass.v1",
      thresholdsPassed: true });
    if (pass.repetition !== repetition || !pass.thresholdsPassed ||
      pass.outcomeCount !== MAIN_CARDINALITY.perRepetition ||
      pass.campaignRootSha256 !== input.campaignRootSha256 ||
      pass.rootBindingSha256 !== input.rootBindingSha256 ||
      pass.inventorySha256 !== input.inventorySha256 ||
      pass.repetitionIdentitySha256 !== repetitionIdentitySha256 ||
      pass.metricsBindingSha256 !== metricsBindingSha256) {
      throw new Error("final admission repetition binding is invalid");
    }
    digest(pass.metricsSha256, "repetition metrics");
  }
  return Object.freeze({ finalAdmissionSha256: sha256(input), qualified: true });
}
