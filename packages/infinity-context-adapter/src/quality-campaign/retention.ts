/* oxlint-disable max-lines -- AES opening and closed artifact-chain validation form one boundary */
import { createDecipheriv } from "node:crypto";

import { MAIN_CARDINALITY } from "./admission.js";
import { verifyDurableReservedExchangeEvidence,
  verifyRetainedFinalAdjudication } from "./adjudication.js";
import { artifactAttemptIdentity, type ArtifactAad, type ArtifactReceipt,
} from "./artifacts.js";
import { canonicalJson, digest, exactRecord, safeId, sha256 } from "./canonical.js";
import type { DurableSpendClaim, ExpectedSpendClaim } from "./cumulative-spend.js";
import { assertAttemptIdentity, type AttemptIdentity, type VerifiedSpendReservation,
  verifyExternalSignedValue } from "./execution.js";
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
  readonly terminalChain: readonly { readonly attemptId: string;
    readonly callKind: "answer" | "capability" | "retrieval"; readonly callOrdinal: number;
    readonly predecessorResultDigestSha256: string | null;
    readonly requestDigestSha256: string; readonly resultEnvelopeDigestSha256: string;
    readonly signedResult: unknown; readonly terminalDigestSha256: string }[];
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
  readonly effectVerificationEpochMs: number;
  readonly expectedOutcomes: readonly ExpectedOutcomeInventory[];
  readonly perRepetitionCardinality: 30 | 240;
  readonly providerResultAuthorityRole?: "holdout_provider_result" | "provider_result";
  readonly releaseDocumentSha256: string;
  readonly spendReservations: readonly VerifiedSpendReservation[] }): Promise<{
    readonly artifactCount: number; readonly expectedSpendClaims: readonly ExpectedSpendClaim[];
    readonly inventorySha256: string; readonly reviewSpendClaims: readonly DurableSpendClaim[];
    readonly totalStoredBytes: number }> {
  digest(input.artifactKeyCustodySha256, "artifact key custody");
  const perRepetitionCardinality = input.perRepetitionCardinality;
  const expected = buildExpectedMembership(input.expectedOutcomes, perRepetitionCardinality);
  if (input.artifacts.length !== expected.size) {
    throw new Error("retained inventory has missing or orphan artifacts");
  }
  const seen: RetentionSeen = { aadDigests: new Set(), artifactBindings: new Set(),
    envelopeDigests: new Set(), keyBindings: new Set(), memberships: new Set() };
  const context = { artifactKeyCustodySha256: input.artifactKeyCustodySha256,
    authenticated: new Map<string, AuthenticatedArtifact>(), custody: input.custody,
    effectVerificationEpochMs: input.effectVerificationEpochMs, expected, releaseDocumentSha256:
    digest(input.releaseDocumentSha256, "retained release document"), reviewSpendClaims: [], seen,
    expectedSpendClaims: [],
    providerResultAuthorityRole: input.providerResultAuthorityRole ?? "provider_result",
    spendReservations: input.spendReservations };
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
  verifyCompleteArtifactChains(policy, input.expectedOutcomes, context.authenticated);
  if (!Number.isSafeInteger(input.campaignByteCeiling) ||
    totalStoredBytes > input.campaignByteCeiling) {
    throw new Error("retained inventory exceeds campaign byte ceiling");
  }
  return Object.freeze({ artifactCount: seen.memberships.size,
    expectedSpendClaims: Object.freeze(context.expectedSpendClaims),
    inventorySha256: sha256([...input.artifacts].toSorted((a, b) =>
      `${a.attemptId}:${a.kind}`.localeCompare(`${b.attemptId}:${b.kind}`))),
    reviewSpendClaims: Object.freeze(context.reviewSpendClaims), totalStoredBytes });
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
  readonly authenticated: Map<string, AuthenticatedArtifact>;
  readonly artifactKeyCustodySha256: string; readonly custody: ArtifactCustodyPort;
  readonly effectVerificationEpochMs: number;
  readonly expected: ReadonlyMap<string, ExpectedArtifactMembership>; readonly seen: RetentionSeen;
  readonly expectedSpendClaims: ExpectedSpendClaim[];
  readonly releaseDocumentSha256: string;
  readonly providerResultAuthorityRole: "holdout_provider_result" | "provider_result";
  readonly reviewSpendClaims: DurableSpendClaim[];
  readonly spendReservations: readonly VerifiedSpendReservation[];
}
interface AuthenticatedArtifact { readonly artifact: RetainedArtifact; readonly value: unknown }

function buildExpectedMembership(outcomes: readonly ExpectedOutcomeInventory[],
  perRepetitionCardinality: number):
Map<string, ExpectedArtifactMembership> {
  const total = perRepetitionCardinality * MAIN_CARDINALITY.repetitions;
  if (outcomes.length !== total ||
    new Set(outcomes.map(({ identity }) => identity.attemptId)).size !== total) {
    throw new Error("expected outcome inventory does not match its exact repetition cardinality");
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
      [...REQUIRED_RETAINED_KINDS.slice(0, -1), "resolver_result", "final_adjudication"] :
      REQUIRED_RETAINED_KINDS;
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
    perRepetitionCardinality) || new Set(questionSets).size !== 1) {
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
  validateAuthenticatedPlaintext(policy, artifact, expectedArtifact, plaintext, context);
  context.authenticated.set(membership, { artifact,
    value: decodeCanonicalPlaintext(plaintext, artifact.kind.replaceAll("_", " ")) });
  context.seen.memberships.add(membership); context.seen.aadDigests.add(artifact.aadSha256);
  context.seen.artifactBindings.add(artifact.artifactBindingSha256);
  context.seen.envelopeDigests.add(artifact.envelopeSha256);
  context.seen.keyBindings.add(artifact.keyBindingSha256);
}

// Closed kind dispatch is deliberately exhaustive rather than extensible.
// oxlint-disable-next-line complexity
function validateAuthenticatedPlaintext(policy: QualityCampaignAuthorityPolicy,
  artifact: RetainedArtifact, expectedArtifact: ExpectedArtifactMembership,
  plaintext: Uint8Array, context: RetentionContext): void {
  const decoded = decodeCanonicalPlaintext(plaintext, artifact.kind.replaceAll("_", " "));
  if (artifact.kind === "final_adjudication") {
    const value = decoded;
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
    if (!final.decision.answerComplete) {
      throw new Error("final adjudication answerComplete must be true");
    }
    if (canonicalJson(claims) !== canonicalJson(expectedClaims) ||
      canonicalJson(citations) !== canonicalJson(expectedCitations) ||
      final.decision.claims.some(({ abstentionCorrect }) =>
        abstentionCorrect !== abstentionPassed)) {
      throw new Error("final adjudication decisions differ from admitted metric evidence");
    }
  } else if (artifact.kind === "retrieval_response") {
    const value = exactRecord(decoded,
      ["attempt", "chain", "latencyUs", "rankedLocatorIds", "responseBytesBase64",
        "schemaVersion", "scopeViolationLocatorIds"],
      "retained retrieval response");
    if (value.schemaVersion !== "meeting_knowledge.semantic_quality_retrieval_evidence.v1") {
      throw new Error("authenticated retrieval evidence schema is invalid");
    }
    if (canonicalJson(value.attempt) !== canonicalJson(expectedArtifact.identity)) {
      throw new Error("authenticated retrieval evidence attempt is foreign");
    }
    if (value.latencyUs !== expectedArtifact.outcome.retrievalLatencyUs ||
      canonicalJson(value.rankedLocatorIds) !== canonicalJson(
        expectedArtifact.outcome.rankedLocatorIds) || canonicalJson(value.scopeViolationLocatorIds) !==
        canonicalJson(expectedArtifact.outcome.scopeViolationLocatorIds)) {
      throw new Error("authenticated retrieval evidence differs from admitted ranking");
    }
    verifyArtifactChain(policy, artifact, expectedArtifact.identity, value.chain, context, true);
    assertProviderResultDigest(value.responseBytesBase64, value.chain, "retrieval response");
  } else if (artifact.kind === "evidence") {
    const value = exactRecord(decoded,
      ["attempt", "chain", "evidenceTurnIds", "schemaVersion", "speakerTimeChecks"],
      "retained canonical evidence");
    if (value.schemaVersion !== "meeting_knowledge.semantic_quality_canonical_evidence.v1" ||
      canonicalJson(value.attempt) !== canonicalJson(expectedArtifact.identity) ||
      canonicalJson(value.evidenceTurnIds) !==
        canonicalJson(expectedArtifact.outcome.evidenceTurnIds) ||
      canonicalJson(value.speakerTimeChecks) !==
        canonicalJson(expectedArtifact.outcome.speakerTimeChecks)) {
      throw new Error("authenticated canonical evidence differs from admitted turn observations");
    }
    verifyArtifactChain(policy, artifact, expectedArtifact.identity, value.chain, context, false);
  } else if (["capability_request", "retrieval_request", "answer_request"]
    .includes(artifact.kind)) {
    const value = exactRecord(decoded, ["attempt", "chain", "requestBytesBase64",
      "schemaVersion"], `retained ${artifact.kind}`);
    assertArtifactHeader(value, artifact.kind, expectedArtifact.identity);
    verifyArtifactChain(policy, artifact, expectedArtifact.identity, value.chain, context, false);
    assertProviderRequestDigest(value.requestBytesBase64, value.chain,
      artifact.kind.replaceAll("_", " "));
  } else if (artifact.kind === "capability_response") {
    const value = exactRecord(decoded, ["attempt", "chain", "responseBytesBase64",
      "schemaVersion"], "retained capability response");
    assertArtifactHeader(value, artifact.kind, expectedArtifact.identity);
    verifyArtifactChain(policy, artifact, expectedArtifact.identity, value.chain, context, true);
    assertProviderResultDigest(value.responseBytesBase64, value.chain, "capability response");
  } else if (artifact.kind === "answer_response") {
    const value = exactRecord(decoded, ["answerDigestSha256", "attempt", "chain",
      "responseBytesBase64", "schemaVersion"], "retained answer response");
    assertArtifactHeader(value, artifact.kind, expectedArtifact.identity);
    verifyArtifactChain(policy, artifact, expectedArtifact.identity, value.chain, context, true);
    const resultDigestSha256 = assertProviderResultDigest(value.responseBytesBase64, value.chain,
      "answer response");
    if (value.answerDigestSha256 !== resultDigestSha256) {
      throw new Error("authenticated answer response digest is not authoritative");
    }
  } else if (artifact.kind === "raw_outcome") {
    const value = exactRecord(decoded, ["attempt", "chain", "encryptedEvidenceSha256",
      "outcomeDigestSha256", "responseBytesBase64", "schemaVersion"],
    "retained raw outcome");
    assertArtifactHeader(value, artifact.kind, expectedArtifact.identity);
    verifyArtifactChain(policy, artifact, expectedArtifact.identity, value.chain, context, true);
    assertProviderResultDigest(value.responseBytesBase64, value.chain, "raw outcome");
  } else {
    const keys = artifact.kind.includes("result") ?
      ["attempt", "chain", "decisionReceipt", "schemaVersion"] :
      artifact.kind === "adjudication_input" ?
        ["attempt", "chain", "encryptedEvidenceSha256", "outcomeDigestSha256", "schemaVersion"] :
        ["attempt", "chain", "schemaVersion"];
    const value = exactRecord(decoded, keys, `retained ${artifact.kind}`);
    assertArtifactHeader(value, artifact.kind, expectedArtifact.identity);
    verifyArtifactChain(policy, artifact, expectedArtifact.identity, value.chain, context,
      isProviderResultKind(artifact.kind));
  }
}

function assertArtifactHeader(value: Record<string, unknown>, kind: RetainedArtifactKind,
  identity: AttemptIdentity): void {
  if (value.schemaVersion !== `meeting_knowledge.semantic_quality_${kind}.v1` ||
    canonicalJson(value.attempt) !== canonicalJson(identity)) {
    throw new Error(`authenticated ${kind} has foreign structure`);
  }
}

function assertProviderRequestDigest(value: unknown, chainValue: unknown, label: string): string {
  const bytes = decodeCanonicalBase64Value(value, `${label} request bytes`);
  const chain = chainValue as Record<string, unknown>;
  const requestDigestSha256 = sha256(bytes);
  if (chain.requestDigestSha256 !== requestDigestSha256) {
    throw new Error(`authenticated ${label} does not bind the exact provider request`);
  }
  return requestDigestSha256;
}

function assertProviderResultDigest(value: unknown, chainValue: unknown, label: string): string {
  const bytes = decodeCanonicalBase64Value(value, `${label} result bytes`);
  const chain = chainValue as Record<string, unknown>;
  const resultDigestSha256 = sha256(bytes);
  if (chain.resultDigestSha256 !== resultDigestSha256) {
    throw new Error(`authenticated ${label} does not bind the exact provider result`);
  }
  return resultDigestSha256;
}

// This reconstructs every conditional resolver/result link in one pass.
// oxlint-disable-next-line complexity
function verifyCompleteArtifactChains(policy: QualityCampaignAuthorityPolicy,
  outcomes: readonly ExpectedOutcomeInventory[],
  authenticated: ReadonlyMap<string, AuthenticatedArtifact>): void {
  for (const outcome of outcomes) {
    const kinds: readonly RetainedArtifactKind[] = outcome.resolverRequired ?
      [...REQUIRED_RETAINED_KINDS.slice(0, -1), "resolver_result", "final_adjudication"] :
      REQUIRED_RETAINED_KINDS;
    let predecessorPlaintextSha256: string | null = null;
    const values = new Map<RetainedArtifactKind, Record<string, unknown>>();
    for (const kind of kinds) {
      const identity = artifactAttemptIdentity(outcome.identity, kind);
      const retained = authenticated.get(`${identity.attemptId}:${kind}`);
      if (retained === undefined) {throw new Error("authenticated artifact chain is incomplete");}
      const value = retained.value as Record<string, unknown>;
      values.set(kind, value);
      if (kind !== "final_adjudication") {
        const chain = value.chain as Record<string, unknown>;
        if (chain.predecessorPlaintextSha256 !== predecessorPlaintextSha256) {
          throw new Error("authenticated artifact predecessor chain is broken");
        }
      } else if (value.predecessorPlaintextSha256 !== predecessorPlaintextSha256) {
        throw new Error("final adjudication is not the terminal artifact in its predecessor chain");
      }
      predecessorPlaintextSha256 = retained.artifact.plaintextSha256;
    }
    const final = verifyRetainedFinalAdjudication(policy, values.get("final_adjudication"),
      artifactAttemptIdentity(outcome.identity, "final_adjudication"), outcome.resolverRequired);
    const raw = values.get("raw_outcome")!;
    const adjudicationInput = values.get("adjudication_input")!;
    if ([raw, adjudicationInput].some((value) => value.outcomeDigestSha256 !==
      final.outcomeDigestSha256 || value.encryptedEvidenceSha256 !==
      final.encryptedEvidenceSha256)) {
      throw new Error("authenticated raw outcome/adjudication input chain is unrelated");
    }
    assertExactProviderExchange(values, "capability_request", "capability_response");
    assertExactProviderExchange(values, "retrieval_request", "retrieval_response");
    assertExactProviderExchange(values, "answer_request", "answer_response");
    assertSchedulerProducedProviderExchanges(values, outcome.identity, outcome.terminalChain);
    const answerResponse = values.get("answer_response")!;
    const answerChain = answerResponse.chain as Record<string, unknown>;
    const rawChain = raw.chain as Record<string, unknown>;
    if (rawChain.requestDigestSha256 !== answerChain.requestDigestSha256 ||
      rawChain.resultDigestSha256 !== answerChain.resultDigestSha256 ||
      canonicalJson(rawChain.signedProviderTerminal) !==
        canonicalJson(answerChain.signedProviderTerminal) ||
      raw.responseBytesBase64 !== answerResponse.responseBytesBase64) {
      throw new Error("answer response and raw outcome do not bind one authoritative terminal");
    }
    const first = values.get("adjudicator_1_result")!;
    const second = values.get("adjudicator_2_result")!;
    if (canonicalJson(first.decisionReceipt) !== canonicalJson(final.firstReceipt) ||
      canonicalJson(second.decisionReceipt) !== canonicalJson(final.secondReceipt)) {
      throw new Error("authenticated adjudicator result differs from final decision receipt");
    }
    const adjudicationRequest = { attemptId: outcome.identity.attemptId,
      encryptedEvidenceSha256: adjudicationInput.encryptedEvidenceSha256,
      firstDecisionDigestSha256: null, firstDecisionReceipt: null,
      outcomeDigestSha256: adjudicationInput.outcomeDigestSha256,
      questionId: outcome.identity.questionId, resolverBindingSha256: null,
      secondDecisionDigestSha256: null, secondDecisionReceipt: null };
    const adjudicationRequestSha256 = sha256(adjudicationRequest);
    for (const reviewerResult of [first, second]) {
      const chain = reviewerResult.chain as Record<string, unknown>;
      if (chain.requestDigestSha256 !== adjudicationRequestSha256 ||
        chain.resultDigestSha256 !== sha256(reviewerResult.decisionReceipt)) {
        throw new Error("adjudicator terminal does not bind its exact input and signed result");
      }
    }
    const resolver = values.get("resolver_result");
    if (outcome.resolverRequired && (resolver === undefined ||
      canonicalJson(resolver.decisionReceipt) !== canonicalJson(final.resolverReceipt)) ||
      !outcome.resolverRequired && resolver !== undefined) {
      throw new Error("authenticated resolver result chain is not exact");
    }
    if (resolver !== undefined) {
      const resolverChain = resolver.chain as Record<string, unknown>;
      const resolverBindingSha256 = sha256({ attemptId: adjudicationRequest.attemptId,
        encryptedEvidenceSha256: adjudicationRequest.encryptedEvidenceSha256,
        firstDecisionReceipt: final.firstReceipt,
        outcomeDigestSha256: adjudicationRequest.outcomeDigestSha256,
        questionId: adjudicationRequest.questionId,
        schemaVersion: "meeting_knowledge.semantic_quality_resolver_binding.v1",
        secondDecisionReceipt: final.secondReceipt });
      const resolverRequest = { ...adjudicationRequest,
        firstDecisionDigestSha256: final.firstReceipt.payload.decisionDigestSha256,
        firstDecisionReceipt: final.firstReceipt, resolverBindingSha256,
        secondDecisionDigestSha256: final.secondReceipt.payload.decisionDigestSha256,
        secondDecisionReceipt: final.secondReceipt };
      if (resolverChain.requestDigestSha256 !== sha256(resolverRequest) ||
        resolverChain.resultDigestSha256 !==
        sha256(resolver.decisionReceipt)) {
        throw new Error("resolver terminal does not bind both conflicting decisions and result");
      }
    }
  }
}

function assertSchedulerProducedProviderExchanges(values: ReadonlyMap<RetainedArtifactKind,
  Record<string, unknown>>, answerIdentity: AttemptIdentity,
  terminals: ExpectedOutcomeInventory["terminalChain"]): void {
  if (terminals.length !== 3) {
    throw new Error("scheduler terminal inventory is incomplete");
  }
  let predecessor: string | null = null;
  for (const [callKind, requestKind, responseKind] of [
    ["capability", "capability_request", "capability_response"],
    ["retrieval", "retrieval_request", "retrieval_response"],
    ["answer", "answer_request", "answer_response"],
  ] as const) {
    const terminal = terminals.find((value) => value.callKind === callKind);
    const expectedIdentity = artifactAttemptIdentity(answerIdentity, requestKind);
    const requestChain = values.get(requestKind)?.chain as Record<string, unknown> | undefined;
    const responseChain = values.get(responseKind)?.chain as Record<string, unknown> | undefined;
    if (terminal === undefined || requestChain === undefined || responseChain === undefined ||
      terminal.attemptId !== expectedIdentity.attemptId || terminal.callOrdinal !== 0 ||
      terminal.predecessorResultDigestSha256 !== predecessor ||
      terminal.terminalDigestSha256 !== sha256(terminal.signedResult) ||
      requestChain.requestDigestSha256 !== terminal.requestDigestSha256 ||
      responseChain.requestDigestSha256 !== terminal.requestDigestSha256 ||
      responseChain.resultDigestSha256 !== terminal.resultEnvelopeDigestSha256 ||
      canonicalJson(responseChain.signedProviderTerminal) !== canonicalJson(terminal.signedResult)) {
      throw new Error("retained request/result bytes are not the scheduler-produced exact exchange");
    }
    predecessor = terminal.resultEnvelopeDigestSha256;
  }
}

function assertExactProviderExchange(values: ReadonlyMap<RetainedArtifactKind,
  Record<string, unknown>>, requestKind: RetainedArtifactKind,
  responseKind: RetainedArtifactKind): void {
  const request = values.get(requestKind)!;
  const response = values.get(responseKind)!;
  const requestChain = request.chain as Record<string, unknown>;
  const responseChain = response.chain as Record<string, unknown>;
  if (requestChain.requestDigestSha256 !== responseChain.requestDigestSha256) {
    throw new Error(`${responseKind} does not follow its exact provider request`);
  }
}

function isProviderResultKind(kind: RetainedArtifactKind): boolean {
  return ["capability_response", "retrieval_response", "answer_response", "raw_outcome",
    "adjudicator_1_result", "adjudicator_2_result", "resolver_result"].includes(kind);
}

// Terminal and derived artifacts intentionally share one exact chain verifier.
// oxlint-disable-next-line complexity, max-params
function verifyArtifactChain(policy: QualityCampaignAuthorityPolicy, artifact: RetainedArtifact,
  identity: AttemptIdentity, value: unknown, context: RetentionContext,
  terminalRequired: boolean): void {
  const chain = exactRecord(value, ["artifactKind", "cancellationBoundary", "deadlineEpochMs",
    "predecessorPlaintextSha256", "releaseDocumentSha256", "requestDigestSha256",
    "resultDigestSha256", "signedDurableExchange", "signedProviderTerminal",
    "spendReservationSha256"],
  "retained artifact chain");
  if (chain.artifactKind !== artifact.kind || chain.releaseDocumentSha256 !==
    context.releaseDocumentSha256 || chain.spendReservationSha256 !==
    identity.spendReservationSha256 || chain.cancellationBoundary !== "not_cancelled" ||
    chain.predecessorPlaintextSha256 !== null &&
      typeof chain.predecessorPlaintextSha256 !== "string") {
    throw new Error("retained artifact chain binding is foreign");
  }
  digest(chain.requestDigestSha256, "artifact request");
  if (!terminalRequired) {
    if (chain.deadlineEpochMs !== null || chain.resultDigestSha256 !== null ||
      chain.signedDurableExchange !== null || chain.signedProviderTerminal !== null) {
      throw new Error("derived artifact contains orphan provider terminal evidence");
    }
    return;
  }
  const spend = context.spendReservations[identity.repetition - 1];
  if (spend === undefined || !Number.isSafeInteger(chain.deadlineEpochMs) ||
    Number(chain.deadlineEpochMs) <= context.effectVerificationEpochMs ||
    Number(chain.deadlineEpochMs) >
      spend.payload.expiresAtEpochMs || Number(chain.deadlineEpochMs) -
      context.effectVerificationEpochMs > spend.payload.maximumEffectDurationMs ||
      chain.resultDigestSha256 === null) {
    throw new Error("provider terminal deadline is outside signed spend authority");
  }
  const durableRequired = ["adjudicator_1_result", "adjudicator_2_result", "resolver_result"]
    .includes(artifact.kind);
  const authority = policy.authority(durableRequired ? "provider_result" :
    context.providerResultAuthorityRole);
  const receipt = verifyExternalSignedValue<Record<string, unknown>>(chain.signedProviderTerminal,
    authority.keyId, authority.publicKeyPem, "retained provider terminal");
  const payload = exactRecord(receipt.payload, ["attemptId", "callKind", "callOrdinal",
    "campaignRootSha256", "questionDigestSha256", "questionId", "releaseRootSha256",
    "repetition", "requestDigestSha256", "resultDigestSha256", "schemaVersion",
    "spendReservationSha256", "state"], "retained provider terminal payload");
  if (payload.schemaVersion !== "meeting_knowledge.semantic_quality_provider_terminal_payload.v4" ||
    payload.state !== "terminal_success" || payload.requestDigestSha256 !==
      chain.requestDigestSha256 || payload.resultDigestSha256 !== chain.resultDigestSha256 ||
    canonicalJson({ attemptId: payload.attemptId, callKind: payload.callKind,
      callOrdinal: payload.callOrdinal, campaignRootSha256: payload.campaignRootSha256,
      questionDigestSha256: payload.questionDigestSha256, questionId: payload.questionId,
      releaseRootSha256: payload.releaseRootSha256, repetition: payload.repetition,
      spendReservationSha256: payload.spendReservationSha256 }) !== canonicalJson(identity)) {
    throw new Error("provider terminal does not bind the exact retained artifact effect");
  }
  if (durableRequired) {
    const durable = verifyDurableReservedExchangeEvidence(policy, chain.signedDurableExchange, {
      attempt: identity, cancellationBoundary: "not_cancelled",
      deadlineEpochMs: Number(chain.deadlineEpochMs), releaseDocumentSha256:
        context.releaseDocumentSha256, requestDigestSha256: String(chain.requestDigestSha256),
      resultDigestSha256: String(chain.resultDigestSha256),
      signedProviderTerminal: chain.signedProviderTerminal });
    context.expectedSpendClaims.push(Object.freeze({ identity,
      requestDigestSha256: String(chain.requestDigestSha256) }));
    context.reviewSpendClaims.push(durable.budgetClaim as DurableSpendClaim);
  } else if (chain.signedDurableExchange !== null) {
    throw new Error("non-adjudication artifact contains orphan durable exchange evidence");
  }
  if (["capability_response", "retrieval_response", "answer_response"].includes(artifact.kind)) {
    context.expectedSpendClaims.push(Object.freeze({ identity,
      requestDigestSha256: String(chain.requestDigestSha256) }));
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

function decodeCanonicalBase64Value(value: unknown, label: string): Uint8Array {
  if (typeof value !== "string") {throw new Error(`${label} is not canonical base64`);}
  return decodeCanonicalBase64(value, label);
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
