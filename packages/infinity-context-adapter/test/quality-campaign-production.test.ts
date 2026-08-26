/* oxlint-disable max-lines -- one complete 3x240 authority fixture prevents divergent test builders */
import { createCipheriv, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  admitFinalCampaign, admitIsolatedHoldout, admitMainCampaign, adjudicateOutcome,
  artifactAttemptIdentity, assertObservedRelease, attemptIdentity, bindExactExecutionEvidence,
  canonicalJson, createHoldoutReport, DurableAttemptJournal, executeReservedExchange,
  executeDerivedCleanup, FROZEN_ANSWER_EXECUTION, publicKeyFingerprintSha256, reconstructMetrics,
  QUALITY_AUTHORITY_ROLES, QualityCampaignAuthorityPolicy, sha256,
  verifyReleaseRoot,
  verifyCampaignCreatedTargetInventory, verifyCleanupAbsenceReceipt, verifySpendReservation,
  verifyRetainedFinalAdjudication,
  type AdjudicationRequest, type ArtifactCustodyPort,
  type AdjudicationEffectEvidence,
  type AttemptIdentity, type CampaignQuestion, type CanonicalAdjudicationDecision,
  type EncryptedArtifactKind,
  type PinnedReleaseDocument, type QualificationOutcome, type QualityCampaignRelease,
  type ProtectedCampaignEvidence, type RepetitionQualificationEvidence, type RetainedArtifact,
  type ExactCampaignEvidence, type ScheduledExactOutcome,
  type VerifiedSpendReservation,
} from "../src/index.js";

const d = (character: string) => character.repeat(64);
const CAMPAIGN_ROOT = d("1");
const ARTIFACT_KEY = Buffer.alloc(32, 7);
const PROVIDER = "pinned-provider";
const ACTIVE_SIGNAL = new AbortController().signal;

describe("scheduler-owned exact evidence chain", () => {
  it("rejects missing, reordered, substituted, replayed, and digest-mismatched evidence streams", () => {
    const exactAnswerIdentity = attemptIdentity({ callKind: "answer", callOrdinal: 0,
      campaignRootSha256: d("1"), questionDigestSha256: d("2"), questionId: "q-chain",
      releaseRootSha256: d("3"), repetition: 1, spendReservationSha256: d("4") });
    let predecessor: string | null = null;
    const terminalChain = (["capability", "retrieval", "answer"] as const).map((callKind,
      index) => {
      const identity = attemptIdentity({ callKind, callOrdinal: 0,
        campaignRootSha256: exactAnswerIdentity.campaignRootSha256,
        questionDigestSha256: exactAnswerIdentity.questionDigestSha256,
        questionId: exactAnswerIdentity.questionId, releaseRootSha256:
        exactAnswerIdentity.releaseRootSha256, repetition: exactAnswerIdentity.repetition,
        spendReservationSha256: exactAnswerIdentity.spendReservationSha256 });
      const resultEnvelopeDigestSha256 = sha256(Buffer.from(`result-${index}`));
      const value = { attemptId: identity.attemptId, callKind, callOrdinal: 0,
        predecessorResultDigestSha256: predecessor,
        requestDigestSha256: sha256(Buffer.from(`request-${index}`)),
        resultEnvelopeDigestSha256, signedResult: { index },
        terminalDigestSha256: sha256({ index }) };
      predecessor = resultEnvelopeDigestSha256; return value;
    });
    const execution = { answerAttemptId: exactAnswerIdentity.attemptId,
      answerIdentity: exactAnswerIdentity,
      terminalChain } satisfies ScheduledExactOutcome;
    const evidence = { outcomes: [{ attemptId: exactAnswerIdentity.attemptId,
      identity: exactAnswerIdentity,
      terminalChain }] } as unknown as ExactCampaignEvidence;
    expect(bindExactExecutionEvidence(evidence, [execution]).outcomes[0]!.terminalChain)
      .toEqual(terminalChain);
    const withChain = (chain: unknown, identity = exactAnswerIdentity) => ({ ...evidence,
      outcomes: [{ attemptId: identity.attemptId, identity, terminalChain: chain }] }) as
      unknown as ExactCampaignEvidence;
    expect(() => bindExactExecutionEvidence(withChain(terminalChain.slice(0, 2)), [execution]))
      .toThrow(/scheduler-produced/u);
    expect(() => bindExactExecutionEvidence(withChain(terminalChain.toReversed()), [execution]))
      .toThrow(/scheduler-produced/u);
    expect(() => bindExactExecutionEvidence(withChain(terminalChain.map((value, index) => index === 1 ?
      { ...value, requestDigestSha256: d("f") } : value)), [execution]))
      .toThrow(/scheduler-produced/u);
    expect(() => bindExactExecutionEvidence(withChain(terminalChain.map((value, index) => index === 2 ?
      { ...value, resultEnvelopeDigestSha256: d("e") } : value)), [execution]))
      .toThrow(/scheduler-produced/u);
    const replayIdentity = { ...exactAnswerIdentity, repetition: 2 as const };
    expect(() => bindExactExecutionEvidence(withChain(terminalChain, replayIdentity), [execution]))
      .toThrow(/membership differ|scheduler-produced/u);
    expect(() => bindExactExecutionEvidence(evidence, [])).toThrow(/membership differ/u);
  });
});

function signer(keyId: string) {
  const keys = generateKeyPairSync("ed25519");
  return {
    keyId, publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
    signed<T>(payload: T) {return Object.freeze({ payload,
      signatureBase64: sign(null, Buffer.from(canonicalJson(payload)), keys.privateKey)
        .toString("base64"), signerKeyId: keyId });},
  };
}

type TestSigner = ReturnType<typeof signer>;

function authorityFixture() {
  const signers = { artifact_custody: signer("artifact-custody-authority"),
    cleanup: signer("cleanup-authority"),
    gold_relevance: signer("gold-relevance-authority"),
    holdout_authorization: signer("holdout-authorization-authority"),
    holdout_provider_result: signer("holdout-provider-result-authority"),
    holdout_question: signer("holdout-question-authority"),
    inventory: signer("target-inventory-authority"), locator: signer("locator-authority"),
    main_proof: signer("main-proof-authority"),
    provider_result: signer("provider-result-authority"), release: signer("release-authority"),
    repetition: signer("repetition-authority"), resolver: signer("resolver-authority"),
    reviewer_1: signer("reviewer-1-authority"), reviewer_2: signer("reviewer-2-authority"),
    spend: signer("spend-authority") } as const;
  const policy = new QualityCampaignAuthorityPolicy(Object.fromEntries(Object.entries(signers)
    .map(([role, authority]) => [role, { keyId: authority.keyId,
      publicKeyFingerprintSha256: publicKeyFingerprintSha256(authority.publicKeyPem,
        `${role} authority`), publicKeyPem: authority.publicKeyPem }])) as never);
  return { policy, signers };
}

function sealedQuestions(count: number, source: CampaignQuestion["source"], prefix: string):
CampaignQuestion[] {
  const locales: readonly CampaignQuestion["locale"][] = ["en", "ru", "mixed"];
  return Array.from({ length: count }, (_, index) => ({ locale: locales[index % locales.length]!,
    questionDigestSha256: sha256({ index, prefix }), questionId: `${prefix}-${index}`,
    rubricDigestSha256: sha256({ index, rubric: prefix }), source }));
}

function releaseFixture(authorities: ReturnType<typeof authorityFixture>) {
  const authority = authorities.signers.release;
  const release: QualityCampaignRelease = { answerImageSha256: d("1"),
    answerProcessIdentitySha256: d("2"), answerReleaseSha256: d("3"),
    artifactKeyCustodySha256: authorities.policy.authority("artifact_custody")
      .publicKeyFingerprintSha256, authorityPolicySha256: authorities.policy.bindingSha256,
    discordCommitSha256: d("4"),
    discordImageSha256: d("5"), discordReleaseSha256: d("6"),
    infinityCapabilitySha256: d("7"), infinityCommitSha256: d("8"),
    infinityImageSha256: d("9"), infinityProfileSha256: d("a"),
    infinityReleaseSha256: d("b"), mapperSha256: d("c"), ...FROZEN_ANSWER_EXECUTION,
    policySha256: d("d"), promptSha256: d("e"), sdkArchiveSha256: d("f"),
    targetInventoryAuthorityKeySha256: publicKeyFingerprintSha256(
      authorities.signers.inventory.publicKeyPem, "target inventory authority"),
    tokenizerSha256: d("0") };
  const document = authority.signed(release);
  const pinned: PinnedReleaseDocument = { authorityKeyId: authority.keyId,
    document, releaseRootSha256: sha256(document) };
  return { authority, document, pinned, release, releaseRootSha256: sha256(document) };
}

function spendReceipt(input: { readonly authority: TestSigner; readonly releaseRootSha256: string;
  readonly repetition: 1 | 2 | 3; readonly overrides?: Record<string, unknown> }) {
  return input.authority.signed({ allowedCallKinds: ["answer", "retrieval", "capability",
    "adjudicator_1", "adjudicator_2", "resolver"], campaignRootSha256: CAMPAIGN_ROOT,
  expiresAtEpochMs: 10_000, maxCalls: 2_000, maxCallsByKind: { adjudicator_1: 240,
    adjudicator_2: 240, answer: 240, capability: 240, resolver: 240, retrieval: 240 },
  maxEncryptedBytes: 100_000_000,
  maximumEffectDurationMs: 1_000, maxTokens: 5_000_000, ...FROZEN_ANSWER_EXECUTION,
  provider: PROVIDER,
  releaseRootSha256: input.releaseRootSha256, repetition: input.repetition,
  ...input.overrides });
}

function answerIdentity(input: { readonly question: CampaignQuestion;
  readonly releaseRootSha256: string; readonly repetition: 1 | 2 | 3;
  readonly spendReservationSha256: string; readonly callKind?: AttemptIdentity["callKind"];
  readonly callOrdinal?: number }): AttemptIdentity {
  return attemptIdentity({ callKind: input.callKind ?? "answer", callOrdinal:
    input.callOrdinal ?? 0, campaignRootSha256: CAMPAIGN_ROOT,
  questionDigestSha256: input.question.questionDigestSha256,
  questionId: input.question.questionId, releaseRootSha256: input.releaseRootSha256,
  repetition: input.repetition, spendReservationSha256: input.spendReservationSha256 });
}

function terminalPayload(input: { readonly identity: AttemptIdentity;
  readonly request: Uint8Array; readonly resultDigestSha256: string;
  readonly state: "terminal_failure" | "terminal_success" }) {
  return { ...input.identity, requestDigestSha256: sha256(input.request),
    resultDigestSha256: input.resultDigestSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal_payload.v4",
    state: input.state };
}

const KINDS = ["capability_request", "capability_response", "retrieval_request",
  "retrieval_response", "evidence", "answer_request", "answer_response", "raw_outcome",
  "adjudication_input", "adjudicator_1_result", "adjudicator_2_result",
  "final_adjudication"] as const;

interface StoredEnvelope { readonly envelopeBytes: Uint8Array; readonly plaintext: Uint8Array }

function encryptedArtifact(answerAttempt: AttemptIdentity, kind: EncryptedArtifactKind,
  plaintext: Uint8Array, stored: Map<string, StoredEnvelope>): RetainedArtifact {
  const identity = artifactAttemptIdentity(answerAttempt, kind); const keyId = "campaign-key";
  const plaintextSha256 = sha256(plaintext);
  const aad = { artifactKind: kind, attemptId: identity.attemptId, callKind: identity.callKind,
    callOrdinal: identity.callOrdinal, campaignRootSha256: identity.campaignRootSha256, keyId,
    plaintextSha256, questionDigestSha256: identity.questionDigestSha256,
    questionId: identity.questionId, releaseRootSha256: identity.releaseRootSha256,
    repetition: identity.repetition,
    schemaVersion: "meeting_knowledge.semantic_quality_artifact_aad.v3",
    spendReservationSha256: identity.spendReservationSha256 };
  const nonce = Buffer.from(sha256(`${identity.attemptId}:${kind}:${plaintextSha256}`), "hex")
    .subarray(0, 12);
  const cipher = createCipheriv("aes-256-gcm", ARTIFACT_KEY, nonce);
  cipher.setAAD(Buffer.from(canonicalJson(aad)));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelopeBytes = Buffer.from(canonicalJson({ aad, algorithm: "A256GCM",
    ciphertextBase64: ciphertext.toString("base64"), nonceBase64: nonce.toString("base64"),
    tagBase64: cipher.getAuthTag().toString("base64") }));
  const aadSha256 = sha256(aad); const envelopeSha256 = sha256(envelopeBytes);
  const keyBindingSha256 = sha256({ attemptId: identity.attemptId, keyId, kind,
    questionId: identity.questionId, repetition: identity.repetition,
    schemaVersion: "meeting_knowledge.semantic_quality_retained_key_binding.v1" });
  const storedBytes = envelopeBytes.byteLength;
  const artifactBindingSha256 = sha256({ aadSha256, attemptId: identity.attemptId,
    envelopeSha256, keyBindingSha256, keyId, kind, plaintextSha256,
    questionId: identity.questionId, repetition: identity.repetition, storedBytes,
    schemaVersion: "meeting_knowledge.semantic_quality_retained_artifact_binding.v1" });
  stored.set(envelopeSha256, { envelopeBytes, plaintext });
  return { aadSha256, artifactBindingSha256, attemptId: identity.attemptId, envelopeSha256,
    keyBindingSha256, keyId, kind, plaintextSha256, questionId: identity.questionId,
    repetition: identity.repetition, storedBytes };
}

function custody(policy: QualityCampaignAuthorityPolicy,
  stored: ReadonlyMap<string, StoredEnvelope>, key = ARTIFACT_KEY):
ArtifactCustodyPort {
  const authority = policy.authority("artifact_custody");
  return { loadKey: vi.fn(async () => ({ authorityKeyId: authority.keyId,
    authorityPublicKeyFingerprintSha256: authority.publicKeyFingerprintSha256, key,
    keyCustodySha256: authority.publicKeyFingerprintSha256 })),
    readEnvelope: vi.fn(async ({ envelopeSha256 }: { readonly envelopeSha256: string }) =>
      stored.get(envelopeSha256)?.envelopeBytes ?? null) };
}

function finalAdjudicationValue(attempt: AttemptIdentity, resolverRequired: boolean,
  authorities: ReturnType<typeof authorityFixture>, predecessorPlaintextSha256 = d("9"),
  answerComplete = true) {
  const outcomeDigestSha256 = sha256({ attemptId: attempt.attemptId, kind: "raw-outcome" });
  const encryptedEvidenceSha256 = sha256({ attemptId: attempt.attemptId, kind: "evidence" });
  const decision = { answerComplete, claims: [{ abstentionCorrect: true,
    citationEntailed: true, claimFactual: true, claimId: `final-${attempt.questionId}`,
    claimSupported: true, matchedGoldClaimId: `gold-${attempt.questionId}` }],
  outcomeDigestSha256, questionId: attempt.questionId };
  const secondDecision = resolverRequired ? { ...decision, answerComplete: false } : decision;
  const receiptPayload = (selected: typeof decision, binding: {
    readonly firstDecisionDigestSha256: string | null;
    readonly resolverBindingSha256: string | null;
    readonly secondDecisionDigestSha256: string | null }) => ({ attemptId: attempt.attemptId,
    decision: selected, decisionDigestSha256: sha256(selected), encryptedEvidenceSha256,
    ...binding, outcomeDigestSha256, questionId: attempt.questionId });
  const emptyBinding = { firstDecisionDigestSha256: null, resolverBindingSha256: null,
    secondDecisionDigestSha256: null };
  const firstReceipt = authorities.signers.reviewer_1.signed(receiptPayload(decision,
    emptyBinding));
  const secondReceipt = authorities.signers.reviewer_2.signed(receiptPayload(secondDecision,
    emptyBinding));
  let resolverReceipt = null;
  if (resolverRequired) {
    const resolverBindingSha256 = sha256({ attemptId: attempt.attemptId,
      encryptedEvidenceSha256, firstDecisionReceipt: firstReceipt, outcomeDigestSha256,
      questionId: attempt.questionId,
      schemaVersion: "meeting_knowledge.semantic_quality_resolver_binding.v1",
      secondDecisionReceipt: secondReceipt });
    resolverReceipt = authorities.signers.resolver.signed(receiptPayload(decision, {
      firstDecisionDigestSha256: sha256(decision), resolverBindingSha256,
      secondDecisionDigestSha256: sha256(secondDecision) }));
  }
  return { attempt, decision, decisionDigestSha256: sha256(decision),
    encryptedEvidenceSha256, firstReceipt, outcomeDigestSha256, predecessorPlaintextSha256,
    resolverReceipt,
    schemaVersion: "meeting_knowledge.semantic_quality_final_adjudication.v2" as const,
    secondReceipt };
}

function artifactChain(input: { readonly authorities: ReturnType<typeof authorityFixture>;
  readonly identity: AttemptIdentity; readonly kind: EncryptedArtifactKind;
  readonly predecessorPlaintextSha256: string | null; readonly terminal: boolean;
  readonly requestDigestSha256?: string; readonly resultDigestSha256?: string }) {
  const requestDigestSha256 = input.requestDigestSha256 ?? sha256({
    attemptId: input.identity.attemptId, artifactKind: input.kind, direction: "request" });
  const resultDigestSha256 = input.terminal ? input.resultDigestSha256 ?? sha256({
    attemptId: input.identity.attemptId, artifactKind: input.kind, direction: "result" }) : null;
  const signedProviderTerminal = input.terminal ?
    input.authorities.signers.provider_result.signed({ ...input.identity, requestDigestSha256,
      resultDigestSha256, schemaVersion:
      "meeting_knowledge.semantic_quality_provider_terminal_payload.v4",
    state: "terminal_success" }) : null;
  const durable = input.terminal && ["adjudicator_1_result", "adjudicator_2_result",
    "resolver_result"].includes(input.kind) ? durableExchangeAttestation({ authorities:
      input.authorities, identity: input.identity, requestDigestSha256,
    resultDigestSha256: resultDigestSha256!, signedProviderTerminal }) : null;
  return { artifactKind: input.kind, cancellationBoundary: "not_cancelled",
    deadlineEpochMs: input.terminal ? 1_500 : null, predecessorPlaintextSha256:
    input.predecessorPlaintextSha256, releaseDocumentSha256: sha256(FINAL_RELEASE_DOCUMENT),
    requestDigestSha256, resultDigestSha256, signedDurableExchange: durable,
    signedProviderTerminal,
    spendReservationSha256: input.identity.spendReservationSha256 };
}

let FINAL_RELEASE_DOCUMENT: unknown;

function durableExchangeAttestation(input: { readonly authorities:
  ReturnType<typeof authorityFixture>; readonly identity: AttemptIdentity;
  readonly requestDigestSha256: string; readonly resultDigestSha256: string;
  readonly signedProviderTerminal: unknown }) {
  const budgetClaim = { admissionId: `admission-${input.identity.attemptId}`,
    attemptId: input.identity.attemptId, callKind: input.identity.callKind,
    campaignRootSha256: input.identity.campaignRootSha256, repetition: input.identity.repetition,
    requestedEncryptedBytes: 4_096, requestedTokens: 64,
    requestDigestSha256: input.requestDigestSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_budget_claim.v1" as const,
    spendReservationSha256: input.identity.spendReservationSha256 };
  const reservation = { ...input.identity, requestDigestSha256: input.requestDigestSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_provider_reservation.v3" as const,
    state: "provider_reserved" as const };
  const terminalRecord = { attemptId: input.identity.attemptId,
    binding: (input.signedProviderTerminal as { readonly payload: unknown }).payload,
    reservationSha256: sha256(reservation),
    schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal.v4",
    signedResult: input.signedProviderTerminal, state: "terminal_success" };
  return input.authorities.signers.provider_result.signed({ budgetClaim,
    budgetClaimSha256: sha256(budgetClaim), cancellationBoundary: "not_cancelled",
    deadlineEpochMs: 1_500, effectState: "certain_success",
    journalReconciliationState: "terminal_success",
    releaseDocumentSha256: sha256(FINAL_RELEASE_DOCUMENT), reservation,
    reservationSha256: sha256(reservation), resultDigestSha256: input.resultDigestSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_durable_exchange_attestation.v1",
    signedProviderTerminalSha256: sha256(input.signedProviderTerminal),
    terminalRecordSha256: sha256(terminalRecord) });
}

function adjudicationReceipt(value: TestSigner, selected: CanonicalAdjudicationDecision,
  request: AdjudicationRequest) {
  return value.signed({ attemptId: request.attemptId, decision: selected,
    decisionDigestSha256: sha256(selected),
    encryptedEvidenceSha256: request.encryptedEvidenceSha256,
    firstDecisionDigestSha256: request.firstDecisionDigestSha256,
    outcomeDigestSha256: request.outcomeDigestSha256, questionId: request.questionId,
    resolverBindingSha256: request.resolverBindingSha256,
    secondDecisionDigestSha256: request.secondDecisionDigestSha256 });
}

function adjudicationEffectEvidence(input: { readonly answerAttempt: AttemptIdentity;
  readonly authorities: ReturnType<typeof authorityFixture>;
  readonly kind: "adjudicator_1_result" | "adjudicator_2_result" | "resolver_result";
  readonly requestDigestSha256: string; readonly result: unknown }): AdjudicationEffectEvidence {
  const attempt = artifactAttemptIdentity(input.answerAttempt, input.kind);
  const resultDigestSha256 = sha256(input.result);
  const signedProviderTerminal = input.authorities.signers.provider_result.signed({ ...attempt,
    requestDigestSha256: input.requestDigestSha256, resultDigestSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal_payload.v4",
    state: "terminal_success" });
  return { attempt, cancellationBoundary: "not_cancelled", deadlineEpochMs: 1_500,
    requestDigestSha256: input.requestDigestSha256, resultDigestSha256,
    signedDurableExchange: durableExchangeAttestation({ authorities: input.authorities,
      identity: attempt, requestDigestSha256: input.requestDigestSha256, resultDigestSha256,
      signedProviderTerminal }), signedProviderTerminal };
}

function finalFixture() {
  const authorities = authorityFixture(); const targetInventoryAuthority = authorities.signers.inventory;
  const release = releaseFixture(authorities); const spendAuthority = authorities.signers.spend;
  FINAL_RELEASE_DOCUMENT = release.document;
  const spends = ([1, 2, 3] as const).map((repetition) => spendReceipt({ authority:
    spendAuthority, releaseRootSha256: release.releaseRootSha256, repetition }));
  const spendDigests = spends.map((receipt) => sha256(receipt)) as [string, string, string];
  const questions = [...sealedQuestions(200, "automatic", "a"),
    ...sealedQuestions(40, "independent_review", "r")];
  const authorizedLocatorIds = Array.from({ length: 10 }, (_, index) => `locator-${index}`);
  const locatorAuthority = authorities.signers.locator;
  const authorizedLocatorInventory = locatorAuthority.signed({ campaignRootSha256: CAMPAIGN_ROOT,
    locatorIds: authorizedLocatorIds, releaseRootSha256: release.releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_locator_inventory.v1" });
  const goldRelevanceEntries = questions.map((question) => ({ ...question,
    campaignRootSha256: CAMPAIGN_ROOT, expectedAbstention: false,
    releaseRootSha256: release.releaseRootSha256,
    relevantLocatorIds: authorizedLocatorIds.slice(0, 5) }));
  const goldRelevanceAuthority = authorities.signers.gold_relevance;
  const goldRelevanceReceipt = goldRelevanceAuthority.signed({ campaignRootSha256: CAMPAIGN_ROOT,
    entries: goldRelevanceEntries, releaseRootSha256: release.releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_gold_relevance.v1" });
  const questionReviewPayload = { campaignRootSha256: CAMPAIGN_ROOT,
    goldRelevanceReceiptSha256: sha256(goldRelevanceReceipt), questions,
    releaseRootSha256: release.releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_reviewed_main_questions.v2" };
  const questionReviewReceipts = [authorities.signers.reviewer_1.signed(questionReviewPayload),
    authorities.signers.reviewer_2.signed(questionReviewPayload)] as const;
  const rootBindingSha256 = sha256({ authorizedLocatorSetSha256: sha256(authorizedLocatorIds),
    campaignRootSha256: CAMPAIGN_ROOT, questionSetSha256: sha256(questions),
    relevanceAuthoritySha256: sha256(goldRelevanceEntries),
    releaseRootSha256: release.releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_final_root_binding.v3",
    spendReservationSetSha256: sha256(spendDigests) });
  const stored = new Map<string, StoredEnvelope>(); const artifacts: RetainedArtifact[] = [];
  const schedulerClaims: unknown[] = [];
  const outcomesByRepetition = ([1, 2, 3] as const).map((repetition) =>
    questions.map((question, index): QualificationOutcome => {
      const identity = answerIdentity({ question, releaseRootSha256: release.releaseRootSha256,
        repetition, spendReservationSha256: spendDigests[repetition - 1]! });
      const resolverRequired = index === 0;
      const turnId = `turn-${repetition}-${index}`; const claimId = `final-${question.questionId}`;
      const rankedLocatorIds = authorizedLocatorIds.slice(0, 5);
      const speakerTimeChecks = [{ canonicalTurnId: turnId, expectedSpeakerId: "speaker-1",
        expectedStartMs: 1_000, observedSpeakerId: "speaker-1", observedStartMs: 1_050,
        toleranceMs: 100 }];
      let finalValue = finalAdjudicationValue(identity, resolverRequired, authorities);
      let finalPlaintext = Buffer.from(canonicalJson(finalValue));
      let finalAdjudicationSha256 = sha256(finalPlaintext);
      const artifactBindingSha256ByKind: Record<string, string> = {};
      const terminalChain: QualificationOutcome["terminalChain"][number][] = [];
      let predecessorResultDigestSha256: string | null = null;
      const kinds: readonly EncryptedArtifactKind[] = resolverRequired ?
        [...KINDS.slice(0, -1), "resolver_result", "final_adjudication"] : KINDS;
      let predecessorPlaintextSha256: string | null = null;
      for (const kind of kinds) {
        const artifactIdentity = artifactAttemptIdentity(identity, kind);
        const providerRequestBytes = Buffer.from(canonicalJson({ callKind:
          artifactIdentity.callKind, questionDigestSha256: artifactIdentity.questionDigestSha256,
        schemaVersion: "meeting_knowledge.semantic_quality_test_provider_request.v1" }));
        const providerResultBytes = Buffer.from(canonicalJson({ callKind:
          artifactIdentity.callKind, questionId: artifactIdentity.questionId,
        schemaVersion: "meeting_knowledge.semantic_quality_test_provider_result.v1" }));
        const terminal = ["capability_response", "retrieval_response", "answer_response",
          "raw_outcome", "adjudicator_1_result", "adjudicator_2_result", "resolver_result"]
          .includes(kind);
        const decisionReceipt = kind === "adjudicator_1_result" ? finalValue.firstReceipt :
          kind === "adjudicator_2_result" ? finalValue.secondReceipt :
          kind === "resolver_result" ? finalValue.resolverReceipt : undefined;
        const adjudicationRequest = { attemptId: identity.attemptId,
          encryptedEvidenceSha256: finalValue.encryptedEvidenceSha256,
          firstDecisionDigestSha256: null, firstDecisionReceipt: null,
          outcomeDigestSha256: finalValue.outcomeDigestSha256, questionId: identity.questionId,
          resolverBindingSha256: null, secondDecisionDigestSha256: null,
          secondDecisionReceipt: null };
        const resolverBindingSha256 = sha256({ attemptId: identity.attemptId,
          encryptedEvidenceSha256: finalValue.encryptedEvidenceSha256,
          firstDecisionReceipt: finalValue.firstReceipt,
          outcomeDigestSha256: finalValue.outcomeDigestSha256, questionId: identity.questionId,
          schemaVersion: "meeting_knowledge.semantic_quality_resolver_binding.v1",
          secondDecisionReceipt: finalValue.secondReceipt });
        const resolverRequest = { ...adjudicationRequest,
          firstDecisionDigestSha256: finalValue.firstReceipt.payload.decisionDigestSha256,
          firstDecisionReceipt: finalValue.firstReceipt, resolverBindingSha256,
          secondDecisionDigestSha256: finalValue.secondReceipt.payload.decisionDigestSha256,
          secondDecisionReceipt: finalValue.secondReceipt };
        const requestDigestSha256 = kind === "adjudicator_1_result" ||
          kind === "adjudicator_2_result" ? sha256(adjudicationRequest) :
          kind === "resolver_result" ? sha256(resolverRequest) :
            ["capability_request", "capability_response", "retrieval_request",
              "retrieval_response", "answer_request", "answer_response", "raw_outcome"]
              .includes(kind) ? sha256(providerRequestBytes) : undefined;
        const providerResultDigestSha256 = ["capability_response", "retrieval_response",
          "answer_response", "raw_outcome"].includes(kind) ? sha256(providerResultBytes) :
          decisionReceipt === undefined ? undefined : sha256(decisionReceipt);
        const chain = artifactChain({ authorities, identity: artifactIdentity, kind,
          predecessorPlaintextSha256, ...(requestDigestSha256 === undefined ? {} :
            { requestDigestSha256 }), ...(providerResultDigestSha256 === undefined ? {} :
            { resultDigestSha256: providerResultDigestSha256 }), terminal });
        if (["capability_response", "retrieval_response", "answer_response"].includes(kind)) {
          const callKind = kind.replace("_response", "") as "answer" | "capability" | "retrieval";
          terminalChain.push({ attemptId: artifactIdentity.attemptId, callKind, callOrdinal: 0,
            predecessorResultDigestSha256, requestDigestSha256: chain.requestDigestSha256!,
            resultEnvelopeDigestSha256: chain.resultDigestSha256!,
            signedResult: chain.signedProviderTerminal,
            terminalDigestSha256: sha256(chain.signedProviderTerminal) });
          predecessorResultDigestSha256 = chain.resultDigestSha256!;
          schedulerClaims.push({ admissionId: `scheduler-${artifactIdentity.attemptId}`,
            attemptId: artifactIdentity.attemptId, callKind: artifactIdentity.callKind,
            campaignRootSha256: artifactIdentity.campaignRootSha256,
            repetition: artifactIdentity.repetition, requestedEncryptedBytes: 4_096,
            requestedTokens: 64, requestDigestSha256,
            schemaVersion: "meeting_knowledge.semantic_quality_budget_claim.v1",
            spendReservationSha256: artifactIdentity.spendReservationSha256 });
        }
        const base = { attempt: artifactIdentity, chain,
          schemaVersion: `meeting_knowledge.semantic_quality_${kind}.v1` };
        if (kind === "final_adjudication") {
          finalValue = Object.assign({}, finalValue, { predecessorPlaintextSha256:
            predecessorPlaintextSha256 ?? d("9") });
          finalPlaintext = Buffer.from(canonicalJson(finalValue));
          finalAdjudicationSha256 = sha256(finalPlaintext);
        }
        const plaintext = kind === "final_adjudication" ? finalPlaintext :
          kind === "retrieval_response" ? Buffer.from(canonicalJson({ attempt: artifactIdentity,
            chain, latencyUs: 200_000, rankedLocatorIds,
            responseBytesBase64: providerResultBytes.toString("base64"),
            schemaVersion: "meeting_knowledge.semantic_quality_retrieval_evidence.v1",
            scopeViolationLocatorIds: [] })) : kind === "evidence" ?
            Buffer.from(canonicalJson({ attempt: artifactIdentity, chain,
              evidenceTurnIds: [turnId],
              schemaVersion: "meeting_knowledge.semantic_quality_canonical_evidence.v1",
              speakerTimeChecks })) : kind === "raw_outcome" ? Buffer.from(canonicalJson({ ...base,
                encryptedEvidenceSha256: finalValue.encryptedEvidenceSha256,
                outcomeDigestSha256: finalValue.outcomeDigestSha256,
                responseBytesBase64: providerResultBytes.toString("base64") })) :
            kind === "adjudication_input" ? Buffer.from(canonicalJson({ ...base,
              encryptedEvidenceSha256: finalValue.encryptedEvidenceSha256,
              outcomeDigestSha256: finalValue.outcomeDigestSha256 })) :
            kind === "answer_response" ? Buffer.from(canonicalJson({ ...base,
              answerDigestSha256: chain.resultDigestSha256,
              responseBytesBase64: providerResultBytes.toString("base64") })) :
            ["capability_request", "retrieval_request", "answer_request"].includes(kind) ?
              Buffer.from(canonicalJson({ ...base,
                requestBytesBase64: providerRequestBytes.toString("base64") })) :
            kind === "capability_response" ? Buffer.from(canonicalJson({ ...base,
              responseBytesBase64: providerResultBytes.toString("base64") })) :
            Buffer.from(canonicalJson({ ...base,
              ...(decisionReceipt === undefined ? {} : { decisionReceipt }) }));
        const artifact = encryptedArtifact(identity, kind, plaintext, stored);
        artifacts.push(artifact); artifactBindingSha256ByKind[kind] = artifact.artifactBindingSha256;
        predecessorPlaintextSha256 = artifact.plaintextSha256;
      }
      return { abstention: { expected: false, observed: false }, artifactBindingSha256ByKind,
        campaignRootSha256: CAMPAIGN_ROOT,
        citationChecks: [{ citedTurnId: turnId, claimId, entailed: true }],
        claimChecks: [{ claimId, factual: true, supported: true }], evidenceTurnIds: [turnId],
        finalAdjudicationSha256, identity, locale: question.locale,
        rankedLocatorIds,
        relevantLocatorIds: authorizedLocatorIds.slice(0, 5), repetition, resolverRequired,
        retrievalLatencyUs: 200_000,
        rootBindingSha256, source: question.source,
        scopeViolationLocatorIds: [],
        speakerTimeChecks, terminalChain };
    }));
  const repetitionAuthority = authorities.signers.repetition;
  const evidence = outcomesByRepetition.map((outcomes, index) => {
    const metrics = reconstructMetrics(outcomes);
    const payload: RepetitionQualificationEvidence = { campaignRootSha256: CAMPAIGN_ROOT,
      metrics, metricsSha256: sha256(metrics), outcomes, outcomesSha256: sha256(outcomes),
      releaseRootSha256: release.releaseRootSha256, repetition: (index + 1) as 1 | 2 | 3,
      rootBindingSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_repetition_evidence.v3",
      spendReservationSha256: spendDigests[index]!, thresholdsPassed: true };
    return repetitionAuthority.signed(payload);
  });
  const targetInventoryReceipt = targetInventoryAuthority.signed({
    campaignRootSha256: CAMPAIGN_ROOT,
    protectedOriginals: ["final_transcript", "meeting_database", "original_craig_recording"]
      .map((kind, index) => ({ artifactId: `protected-${index}`,
        artifactSha256: sha256({ kind }), kind })),
    releaseRootSha256: release.releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_campaign_target_inventory.v2",
    targets: [{ artifactId: "derived-1", kind: "derived_index" },
      { artifactId: "prompt-1", kind: "temporary_prompt" }] });
  const manifest = { campaignRootSha256: CAMPAIGN_ROOT,
    inventoryReceiptSha256: sha256(targetInventoryReceipt),
    protectedOriginals: targetInventoryReceipt.payload.protectedOriginals,
    releaseRootSha256: release.releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_cleanup_manifest.v5",
    targets: targetInventoryReceipt.payload.targets };
  const cleanupAuthority = authorities.signers.cleanup;
  const absentArtifactIds = manifest.targets.map(({ artifactId }) => artifactId).toSorted();
  const presentProtectedOriginals = manifest.protectedOriginals.toSorted((left, right) =>
    left.kind.localeCompare(right.kind));
  const cleanupReceipt = cleanupAuthority.signed({ absentArtifactIds,
    absentArtifactIdsSha256: sha256(absentArtifactIds), campaignRootSha256: CAMPAIGN_ROOT,
    cleanupManifestSha256: sha256(manifest), presentProtectedOriginals,
    presentProtectedOriginalsSha256: sha256(presentProtectedOriginals),
    releaseRootSha256: release.releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_cleanup_absence.v5" });
  const input = { artifactCustody: custody(authorities.policy, stored), artifacts,
    authorizedLocatorInventory,
    campaignByteCeiling: artifacts.reduce((total, artifact) => total + artifact.storedBytes, 0),
    campaignRootSha256: CAMPAIGN_ROOT, cleanupAuthorityKeyId: cleanupAuthority.keyId,
    effectVerificationEpochMs: 1_000,
    cleanupReceipt, goldRelevanceAuthorityKeyId: goldRelevanceAuthority.keyId,
    goldRelevanceReceipt, locatorAuthorityKeyId: locatorAuthority.keyId,
    questionReviewReceipts,
    release: release.pinned,
    repetitionAuthorityKeyId: repetitionAuthority.keyId, repetitionEvidence: evidence,
    rootBindingSha256, spendLedger: { loadAdmittedClaims: async (reservation:
      VerifiedSpendReservation) => schedulerClaims.filter((claim) =>
      (claim as { spendReservationSha256: string }).spendReservationSha256 ===
        reservation.spendReservationSha256) }, spendReservationSha256ByRepetition: spendDigests,
    spendReservationsByRepetition: spends as [unknown, unknown, unknown],
    targetInventoryAuthorityKeyId: targetInventoryAuthority.keyId, targetInventoryReceipt } as const;
  return { authorities, cleanupAuthority, evidence, goldRelevanceAuthority, input,
    outcomesByRepetition, questions, release, repetitionAuthority, spendAuthority, spends, stored,
    targetInventoryAuthority };
}

const FINAL = finalFixture();

function expectedAttempt(attempt: AttemptIdentity) {
  return { campaignRootSha256: attempt.campaignRootSha256,
    questionDigestSha256: attempt.questionDigestSha256, questionId: attempt.questionId,
    releaseRootSha256: attempt.releaseRootSha256, repetition: attempt.repetition,
    spendReservationSha256: attempt.spendReservationSha256 };
}

describe("production quality campaign authority", () => {
  it("admits exact sealed main inputs and keeps the 30-question holdout separate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quality-admission-"));
    const custodySigner = FINAL.authorities.signers.artifact_custody;
    const reviewer1 = FINAL.authorities.signers.reviewer_1;
    const reviewer2 = FINAL.authorities.signers.reviewer_2;
    const automatic = sealedQuestions(200, "automatic", "a");
    const reviewed = sealedQuestions(40, "independent_review", "r"); const all = [...automatic, ...reviewed];
    const sourceDigestSha256 = d("6"); const corpusDigestSha256 = d("7");
    const reviewerDigestSha256 = d("8");
    const acceptance = custodySigner.signed({ corpusDigestSha256, purpose: "custody_only",
      reviewerDigestSha256, schemaVersion: "meeting_knowledge.semantic_quality_acceptance.v1",
      sourceDigestSha256 });
    const authorization = custodySigner.signed({ acceptanceReceiptSha256: sha256(acceptance),
      authorizedProviderExecution: true, corpusDigestSha256, expiresAtEpochMs: 4_000_000_000_000,
      releaseRootSha256: FINAL.release.releaseRootSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_execution_authorization.v1" });
    const reviewPayload = { corpusDigestSha256, questionSetSha256: sha256(all),
      reviewerDigestSha256, rubricSetSha256: sha256(all.map(({ questionId,
        rubricDigestSha256 }) => ({ questionId, rubricDigestSha256 }))),
      schemaVersion: "meeting_knowledge.semantic_quality_question_review.v1" };
    const locatorPayload = { entriesSha256: d("9"),
      releaseRootSha256: FINAL.release.releaseRootSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_locator_authority.v1",
      snapshotSha256: d("a") };
    const files: Record<string, unknown> = { "acceptance.json": acceptance,
      "authorization.json": authorization, "automatic.json": automatic,
      "forbidden.json": custodySigner.signed(locatorPayload), "mapping.json":
      custodySigner.signed(locatorPayload), "review-1.json": reviewer1.signed(reviewPayload),
      "review-2.json": reviewer2.signed(reviewPayload), "reviewed.json": reviewed };
    const manifestPath = join(directory, "InputManifest.v4.json");
    const writeManifest = async () => {
      for (const [path, value] of Object.entries(files)) {
        await writeFile(join(directory, path), canonicalJson(value));
      }
      const checksumInventory = await Promise.all(Object.keys(files).map(async (path) =>
        ({ path, sha256: sha256(await readFile(join(directory, path))) })));
      await writeFile(manifestPath, canonicalJson({ acceptanceReceiptPath: "acceptance.json",
        checksumInventory, corpusDigestSha256, executionAuthorizationPath: "authorization.json",
        forbiddenLocatorManifestPath: "forbidden.json", independentReviewQuestionsPath:
        "reviewed.json", questionReviewReceiptPaths: ["review-1.json", "review-2.json"],
        reviewerDigestSha256, schemaVersion: "meeting_knowledge.semantic_quality_input_manifest.v4",
        sealedAutomaticQuestionsPath: "automatic.json", sourceDigestSha256,
        turnToBlockManifestPath: "mapping.json" }));
    };
    await writeManifest();
    expect((await admitMainCampaign(FINAL.authorities.policy, { authorityKeyId:
      custodySigner.keyId, manifestPath, nowEpochMs: 1_000,
      releaseRootSha256: FINAL.release.releaseRootSha256,
      reviewerAuthorityKeyIds: [reviewer1.keyId, reviewer2.keyId] })).questions).toHaveLength(240);
    await expect(admitMainCampaign(FINAL.authorities.policy, { authorityKeyId:
      custodySigner.keyId, manifestPath, nowEpochMs: 1_000,
      releaseRootSha256: FINAL.release.releaseRootSha256,
      reviewerAuthorityKeyIds: [reviewer2.keyId, reviewer1.keyId] })).rejects
      .toThrow(/not trusted/u);
    files["mapping.json"] = custodySigner.signed({ ...locatorPayload,
      schemaVersion: "foreign.locator.authority.schema" });
    await writeManifest();
    await expect(admitMainCampaign(FINAL.authorities.policy, { authorityKeyId:
      custodySigner.keyId, manifestPath, nowEpochMs: 1_000,
      releaseRootSha256: FINAL.release.releaseRootSha256,
      reviewerAuthorityKeyIds: [reviewer1.keyId, reviewer2.keyId] })).rejects
      .toThrow(/schema version/u);
  });

  it("cryptographically pins release and validates one exact spend reservation", () => {
    expect(verifyReleaseRoot(FINAL.authorities.policy, { authorityKeyId: FINAL.release.authority.keyId,
      document: FINAL.release.document }).release).toEqual(FINAL.release.release);
    expect(() => {assertObservedRelease(FINAL.release.release,
      { ...FINAL.release.release, promptSha256: d("0") });}).toThrow(/drifted/u);
    expect(verifySpendReservation(FINAL.authorities.policy, {
      campaignRootSha256: CAMPAIGN_ROOT, expectedRepetition: 1, nowEpochMs: 1_000,
      releaseRootSha256: FINAL.release.releaseRootSha256,
      reservation: FINAL.spends[0] }).spendReservationSha256).toBe(sha256(FINAL.spends[0]));
  });

  it("revalidates signed release, spend, expiry, provider, call, and ceilings before effect/replay", async () => {
    const providerAuthority = FINAL.authorities.signers.provider_result;
    const question = FINAL.questions[0]!;
    const attempt = FINAL.outcomesByRepetition[0]![0]!.identity; const request = Buffer.from("bounded");
    const resultEnvelope = Buffer.from("provider-result");
    const resultEnvelopeSha256 = sha256(resultEnvelope);
    const port = { exchange: vi.fn(async () => ({ effect: "certain_success" as const,
      resultDigestSha256: resultEnvelopeSha256, resultEnvelopeBytes: resultEnvelope,
      signedResult: providerAuthority.signed(terminalPayload({
        identity: attempt, request, resultDigestSha256: resultEnvelopeSha256,
        state: "terminal_success" })) })) };
    const journal = new DurableAttemptJournal(await mkdtemp(join(tmpdir(), "quality-journal-")),
      FINAL.authorities.policy);
    const exact = { campaignRootSha256: CAMPAIGN_ROOT, deadlineEpochMs: 1_500,
      effectReservation: { requestedEncryptedBytes: 100, requestedTokens: 100 },
      identity: attempt, journal, nowEpochMs: 1_000, port, provider: PROVIDER,
      release: FINAL.release.pinned, request, signal: ACTIVE_SIGNAL,
      spendReservation: FINAL.spends[0] };
    expect(await executeReservedExchange(exact)).toBe("terminal_success");
    expect(await executeReservedExchange(exact)).toBe("terminal_success");
    expect(port.exchange).toHaveBeenCalledTimes(1);
    await expect(executeReservedExchange({ ...exact, nowEpochMs: 11_000 })).rejects
      .toThrow(/spend reservation/u);
    expect(port.exchange).toHaveBeenCalledTimes(1);

    const aborted = new AbortController(); aborted.abort();
    const invalidCases = [
      { provider: "foreign-provider" },
      { deadlineEpochMs: 3_000 },
      { signal: aborted.signal },
      { effectReservation: { ...exact.effectReservation, requestedTokens: 5_000_001 } },
      { effectReservation: { ...exact.effectReservation, requestedEncryptedBytes: 100_000_001 } },
      { spendReservation: spendReceipt({ authority: FINAL.spendAuthority,
        releaseRootSha256: FINAL.release.releaseRootSha256, repetition: 1,
        overrides: { allowedCallKinds: ["retrieval"] } }) },
      { spendReservation: spendReceipt({ authority: FINAL.spendAuthority,
        releaseRootSha256: FINAL.release.releaseRootSha256, repetition: 2 }) },
      { spendReservation: spendReceipt({ authority: FINAL.spendAuthority,
        releaseRootSha256: FINAL.release.releaseRootSha256, repetition: 1,
        overrides: { model: "foreign-model" } }) },
      { spendReservation: spendReceipt({ authority: FINAL.spendAuthority,
        releaseRootSha256: FINAL.release.releaseRootSha256, repetition: 1,
        overrides: { reasoning: "foreign-reasoning" } }) },
    ];
    for (const mutation of invalidCases) {
      const blockedPort = { exchange: vi.fn(port.exchange.getMockImplementation()) };
      const blockedJournal = new DurableAttemptJournal(await mkdtemp(join(tmpdir(),
        "quality-blocked-")), FINAL.authorities.policy);
      await expect(executeReservedExchange({ ...exact, ...mutation, journal: blockedJournal,
        port: blockedPort })).rejects.toThrow();
      expect(blockedPort.exchange).not.toHaveBeenCalled();
    }
    const forgedRelease = { ...FINAL.release.pinned, releaseRootSha256: d("f") };
    const releasePort = { exchange: vi.fn(port.exchange.getMockImplementation()) };
    await expect(executeReservedExchange({ ...exact, journal: new DurableAttemptJournal(
      await mkdtemp(join(tmpdir(), "quality-release-")), FINAL.authorities.policy), port: releasePort,
      release: forgedRelease })).rejects.toThrow(/pinned release/u);
    expect(releasePort.exchange).not.toHaveBeenCalled();
    expect(question.questionId).toBe(attempt.questionId);
  });

  it("rejects self-authority and authority-role swaps before any effect", async () => {
    const caller = signer("caller-generated"); const request = Buffer.from("self-authority");
    const trustedSpend = FINAL.spends[0]!; const attempt = FINAL.outcomesByRepetition[0]![0]!.identity;
    const port = { exchange: vi.fn(async () => ({ effect: "unknown" as const })) };
    const journal = () => new DurableAttemptJournal("/tmp/quality-self-authority-" +
      randomUUID(), FINAL.authorities.policy);
    const base = { campaignRootSha256: CAMPAIGN_ROOT, deadlineEpochMs: 1_500,
      effectReservation: { requestedEncryptedBytes: 1, requestedTokens: 1 }, identity: attempt,
      journal: journal(), nowEpochMs: 1_000, port, provider: PROVIDER,
      release: FINAL.release.pinned, request, signal: ACTIVE_SIGNAL,
      spendReservation: trustedSpend };
    const callerDocument = caller.signed(FINAL.release.release);
    await expect(executeReservedExchange({ ...base, journal: journal(), release: {
      authorityKeyId: caller.keyId, document: callerDocument,
      releaseRootSha256: sha256(callerDocument) } })).rejects.toThrow(/not trusted/u);
    await expect(executeReservedExchange({ ...base, journal: journal(), spendReservation:
      FINAL.authorities.signers.release.signed(trustedSpend.payload) })).rejects
      .toThrow(/spend reservation signer/u);
    expect(port.exchange).not.toHaveBeenCalled();

    const pins = Object.fromEntries(QUALITY_AUTHORITY_ROLES.map((role) => {
      const pin = FINAL.authorities.policy.authority(role);
      return [role, { ...pin }];
    })) as Record<string, { readonly keyId: string;
      readonly publicKeyFingerprintSha256: string; readonly publicKeyPem: string }>;
    const swapped = { ...pins, spend: { ...pins.release! } };
    expect(() => new QualityCampaignAuthorityPolicy(swapped as never)).toThrow(/separated/u);
    const sharedGold = { ...pins, gold_relevance: { ...pins.locator! } };
    expect(() => new QualityCampaignAuthorityPolicy(sharedGold as never)).toThrow(/separated/u);
  });

  it("atomically charges distinct and identical attempts and reconciles unknown without refund", async () => {
    const spend = spendReceipt({ authority: FINAL.spendAuthority,
      releaseRootSha256: FINAL.release.releaseRootSha256, repetition: 1,
      overrides: { allowedCallKinds: ["answer"], maxCalls: 1,
        maxCallsByKind: { adjudicator_1: 0, adjudicator_2: 0,
        answer: 1, capability: 0, resolver: 0, retrieval: 0 }, maxEncryptedBytes: 2,
      maxTokens: 2 } });
    const spendReservationSha256 = sha256(spend); const root = await mkdtemp(join(tmpdir(),
      "quality-atomic-budget-"));
    const identities = FINAL.questions.slice(0, 2).map((question) => answerIdentity({ question,
      releaseRootSha256: FINAL.release.releaseRootSha256, repetition: 1,
      spendReservationSha256 }));
    let providerCalls = 0;
    const makeInput = (identity: AttemptIdentity, journal: DurableAttemptJournal) => ({
      campaignRootSha256: CAMPAIGN_ROOT, deadlineEpochMs: 1_500,
      effectReservation: { requestedEncryptedBytes: 1, requestedTokens: 1 }, identity, journal,
      nowEpochMs: 1_000, port: { exchange: async () => {providerCalls += 1;
        return { effect: "unknown" as const };} }, provider: PROVIDER,
      release: FINAL.release.pinned, request: Buffer.from(identity.questionId),
      signal: ACTIVE_SIGNAL,
      spendReservation: spend });
    const sharedA = new DurableAttemptJournal(root, FINAL.authorities.policy);
    const sharedB = new DurableAttemptJournal(root, FINAL.authorities.policy);
    expect(await Promise.all([executeReservedExchange(makeInput(identities[0]!, sharedA)),
      executeReservedExchange(makeInput(identities[1]!, sharedB))])).toEqual([
      "outcome_unknown", "outcome_unknown"]);
    expect(providerCalls).toBe(1);

    const sameRoot = await mkdtemp(join(tmpdir(), "quality-same-attempt-"));
    const sameA = new DurableAttemptJournal(sameRoot, FINAL.authorities.policy);
    const sameB = new DurableAttemptJournal(sameRoot, FINAL.authorities.policy);
    providerCalls = 0;
    await Promise.all([executeReservedExchange(makeInput(identities[0]!, sameA)),
      executeReservedExchange(makeInput(identities[0]!, sameB))]);
    expect(providerCalls).toBe(1);
    const restarted = new DurableAttemptJournal(sameRoot, FINAL.authorities.policy);
    expect(await executeReservedExchange(makeInput(identities[0]!, restarted)))
      .toBe("outcome_unknown");
    expect(providerCalls).toBe(1);
    const request = Buffer.from(identities[0]!.questionId);
    const reconciledResult = Buffer.from("reconciled-result");
    const resultDigestSha256 = sha256(reconciledResult);
    const terminal = FINAL.authorities.signers.provider_result.signed(terminalPayload({ identity:
      identities[0]!, request, resultDigestSha256, state: "terminal_success" }));
    expect(await restarted.reconcileTerminal({ expectedResultDigestSha256: resultDigestSha256,
      identity: identities[0]!, requestDigestSha256: sha256(request), signedResult: terminal,
      requestBytes: request, resultEnvelopeBytes: reconciledResult,
      state: "terminal_success" })).toBe("terminal_success");
    expect(await executeReservedExchange(makeInput(identities[0]!, restarted)))
      .toBe("terminal_success");
    expect(providerCalls).toBe(1);
  });

});

describe("production quality campaign effect evidence", () => {
  it("validates complete adjudication identity before vault or reviewer effects", async () => {
    const attempt = FINAL.outcomesByRepetition[0]![0]!.identity;
    const decision = { answerComplete: true, claims: [{ abstentionCorrect: true,
      citationEntailed: true, claimFactual: true, claimId: "c-1", claimSupported: true,
      matchedGoldClaimId: "g-1" }], outcomeDigestSha256: d("6"),
      questionId: attempt.questionId };
    const secondDecision = { ...decision, answerComplete: false };
    const baseRequest: AdjudicationRequest = { attemptId: attempt.attemptId,
      encryptedEvidenceSha256: d("8"), firstDecisionDigestSha256: null,
      firstDecisionReceipt: null, outcomeDigestSha256: d("6"), questionId: attempt.questionId,
      resolverBindingSha256: null, secondDecisionDigestSha256: null,
      secondDecisionReceipt: null };
    const firstReceipt = adjudicationReceipt(FINAL.authorities.signers.reviewer_1, decision,
      baseRequest);
    const secondReceipt = adjudicationReceipt(FINAL.authorities.signers.reviewer_2,
      secondDecision, baseRequest);
    const resolverBindingSha256 = sha256({ attemptId: attempt.attemptId,
      encryptedEvidenceSha256: d("8"), firstDecisionReceipt: firstReceipt,
      outcomeDigestSha256: d("6"), questionId: attempt.questionId,
      schemaVersion: "meeting_knowledge.semantic_quality_resolver_binding.v1",
      secondDecisionReceipt: secondReceipt });
    const resolverRequest: AdjudicationRequest = { ...baseRequest,
      firstDecisionDigestSha256: sha256(decision), firstDecisionReceipt: firstReceipt,
      resolverBindingSha256, secondDecisionDigestSha256: sha256(secondDecision),
      secondDecisionReceipt: secondReceipt };
    const resolverReceipt = adjudicationReceipt(FINAL.authorities.signers.resolver, decision,
      resolverRequest);
    const firstEffectEvidence = adjudicationEffectEvidence({ answerAttempt: attempt,
      authorities: FINAL.authorities, kind: "adjudicator_1_result",
      requestDigestSha256: sha256(baseRequest),
      result: firstReceipt });
    const secondEffectEvidence = adjudicationEffectEvidence({ answerAttempt: attempt,
      authorities: FINAL.authorities, kind: "adjudicator_2_result",
      requestDigestSha256: sha256(baseRequest),
      result: secondReceipt });
    const resolverEffectEvidence = adjudicationEffectEvidence({ answerAttempt: attempt,
      authorities: FINAL.authorities, kind: "resolver_result",
      requestDigestSha256: sha256(resolverRequest), result: resolverReceipt });
    const vault = { reconstruct: vi.fn(async () =>
      ({ encryptedEvidenceSha256: d("8"), outcomeDigestSha256: d("6") })) };
    expect((await adjudicateOutcome(FINAL.authorities.policy,
      { attempt, expectedAttempt: expectedAttempt(attempt), firstReceipt,
      effectVerificationEpochMs: 1_000, firstEffectEvidence, release: FINAL.release.pinned,
      predecessorPlaintextSha256: d("9"), rawOutcomeEnvelopeSha256: d("7"), resolverReceipt,
      resolverEffectEvidence, secondEffectEvidence, secondReceipt,
      spendReservation: FINAL.spends[0], vault }))
      .decision.answerComplete)
      .toBe(true);
    const durablePayload = (firstEffectEvidence.signedDurableExchange as {
      readonly payload: Record<string, unknown> }).payload;
    const reservation = durablePayload.reservation as Record<string, unknown>;
    const changedReservation = { ...reservation, requestDigestSha256: d("a") };
    const durableMutations = [{ ...durablePayload,
      journalReconciliationState: "outcome_unknown" }, { ...durablePayload,
      releaseDocumentSha256: d("b") }, { ...durablePayload, reservation: changedReservation,
      reservationSha256: sha256(changedReservation) }, { ...durablePayload,
      terminalRecordSha256: d("c") }];
    for (const payload of durableMutations) {
      const changedEvidence = { ...firstEffectEvidence,
        signedDurableExchange: FINAL.authorities.signers.provider_result.signed(payload) };
      await expect(adjudicateOutcome(FINAL.authorities.policy,
        { attempt, expectedAttempt: expectedAttempt(attempt), firstReceipt,
        effectVerificationEpochMs: 1_000, firstEffectEvidence: changedEvidence,
        release: FINAL.release.pinned, predecessorPlaintextSha256: d("9"),
        rawOutcomeEnvelopeSha256: d("7"), resolverReceipt, resolverEffectEvidence,
        secondEffectEvidence, secondReceipt, spendReservation: FINAL.spends[0], vault }))
        .rejects.toThrow(/durable reserved exchange/u);
    }
    const genericRequestEvidence = adjudicationEffectEvidence({ answerAttempt: attempt,
      authorities: FINAL.authorities, kind: "adjudicator_1_result",
      requestDigestSha256: sha256({ answerAttemptId: attempt.attemptId,
        role: "adjudicator_1" }), result: firstReceipt });
    await expect(adjudicateOutcome(FINAL.authorities.policy,
      { attempt, expectedAttempt: expectedAttempt(attempt), firstReceipt,
      effectVerificationEpochMs: 1_000, firstEffectEvidence: genericRequestEvidence,
      release: FINAL.release.pinned, predecessorPlaintextSha256: d("9"),
      rawOutcomeEnvelopeSha256: d("7"), resolverReceipt, resolverEffectEvidence,
      secondEffectEvidence, secondReceipt, spendReservation: FINAL.spends[0], vault }))
      .rejects.toThrow(/bounded terminal authorization/u);
    vault.reconstruct.mockClear();
    await expect(adjudicateOutcome(FINAL.authorities.policy, {
      attempt, effectVerificationEpochMs: 1_000, expectedAttempt: expectedAttempt(attempt),
      firstEffectEvidence: null as never, firstReceipt, predecessorPlaintextSha256: d("9"),
      rawOutcomeEnvelopeSha256: d("7"), release: FINAL.release.pinned,
      resolverEffectEvidence, resolverReceipt, secondEffectEvidence, secondReceipt,
      spendReservation: FINAL.spends[0], vault })).rejects.toThrow(/terminal|record/u);
    expect(vault.reconstruct).not.toHaveBeenCalled();
    vault.reconstruct.mockClear();
    await expect(adjudicateOutcome(FINAL.authorities.policy, { attempt,
      expectedAttempt: expectedAttempt(attempt), firstReceipt: secondReceipt,
      effectVerificationEpochMs: 1_000, firstEffectEvidence, release: FINAL.release.pinned,
      predecessorPlaintextSha256: d("9"), rawOutcomeEnvelopeSha256: d("7"), resolverReceipt,
      resolverEffectEvidence, secondEffectEvidence, secondReceipt: firstReceipt,
      spendReservation: FINAL.spends[0],
      vault })).rejects.toThrow(/signer|signature/u);
    expect(vault.reconstruct).not.toHaveBeenCalled();
    vault.reconstruct.mockClear();
    const mutations: unknown[] = [
      { attemptId: attempt.attemptId, questionId: attempt.questionId },
      { ...attempt, campaignRootSha256: d("f") }, { ...attempt, releaseRootSha256: d("e") },
      { ...attempt, spendReservationSha256: d("d") },
      answerIdentity({ question: FINAL.questions[0]!, callKind: "retrieval",
        releaseRootSha256: attempt.releaseRootSha256, repetition: 1,
        spendReservationSha256: attempt.spendReservationSha256 }),
    ];
    for (const mutation of mutations) {
      await expect(adjudicateOutcome(FINAL.authorities.policy, {
        attempt: mutation as AttemptIdentity,
        effectVerificationEpochMs: 1_000,
        expectedAttempt: expectedAttempt(attempt), firstReceipt,
        firstEffectEvidence, release: FINAL.release.pinned,
        predecessorPlaintextSha256: d("9"), rawOutcomeEnvelopeSha256: d("7"), resolverReceipt,
        resolverEffectEvidence, secondEffectEvidence, secondReceipt,
        spendReservation: FINAL.spends[0], vault })).rejects.toThrow();
      expect(vault.reconstruct).not.toHaveBeenCalled();
    }
  });
});

// The single block shares one immutable full-campaign fixture across all authority mutations.
// oxlint-disable-next-line max-lines-per-function
describe("production quality campaign final evidence", () => {
  // A cold run verifies and decrypts the complete 3 x 240 AES-GCM inventory before reconstruction.
  it("qualifies real AES-GCM evidence and reconstructs all bounded metric groups", async () => {
    const result = await admitFinalCampaign(FINAL.authorities.policy, FINAL.input);
    expect(result.qualified).toBe(true);
    const metrics = FINAL.evidence[0]!.payload.metrics;
    expect(metrics.find(({ group }) => group === "automatic")?.applicableOutcomeCount).toBe(200);
    expect(metrics.find(({ group }) => group === "independent_review")?.applicableOutcomeCount)
      .toBe(40);
    expect(metrics.find(({ group }) => group === "overall")?.ndcgAt10MillionthsTotal)
      .toBe(240_000_000);
    expect(metrics.find(({ group }) => group === "overall")?.retrievalLatencyP95Us).toBe(200_000);
    expect(metrics.find(({ group }) => group === "overall")?.scopeLeakageCount).toBe(0);
    expect(metrics.every(({ thresholdPassed }) => thresholdPassed)).toBe(true);
  }, 60_000);

  it("rejects caller-selected final-evidence authority references", async () => {
    await expect(admitFinalCampaign(FINAL.authorities.policy, { ...FINAL.input,
      repetitionAuthorityKeyId: FINAL.cleanupAuthority.keyId })).rejects.toThrow(/not trusted/u);
    const caller = signer("caller-repetition");
    const callerEvidence = FINAL.evidence.map(({ payload }) => caller.signed(payload));
    await expect(admitFinalCampaign(FINAL.authorities.policy, { ...FINAL.input,
      repetitionEvidence: callerEvidence })).rejects.toThrow(/signer|signature/u);
    const callerLocator = caller.signed(FINAL.input.authorizedLocatorInventory.payload);
    await expect(admitFinalCampaign(FINAL.authorities.policy, { ...FINAL.input,
      authorizedLocatorInventory: callerLocator })).rejects.toThrow(/signer|signature/u);
    await expect(admitFinalCampaign(FINAL.authorities.policy, { ...FINAL.input,
      goldRelevanceAuthorityKeyId: FINAL.input.locatorAuthorityKeyId })).rejects
      .toThrow(/gold_relevance authority reference/u);
    const locatorAuthoredGold = FINAL.authorities.signers.locator.signed(
      FINAL.input.goldRelevanceReceipt.payload);
    const locatorReviewPayload = { ...FINAL.input.questionReviewReceipts[0].payload,
      goldRelevanceReceiptSha256: sha256(locatorAuthoredGold) };
    await expect(admitFinalCampaign(FINAL.authorities.policy, { ...FINAL.input,
      goldRelevanceReceipt: locatorAuthoredGold, questionReviewReceipts: [
        FINAL.authorities.signers.reviewer_1.signed(locatorReviewPayload),
        FINAL.authorities.signers.reviewer_2.signed(locatorReviewPayload)] }))
      .rejects.toThrow(/signer|signature/u);
  });

  it("rejects all-automatic admission, duplicate/foreign/rank-overflow locators, and absent groups", async () => {
    const allAutomatic = sealedQuestions(240, "automatic", "only-auto");
    const payload = { ...FINAL.input.questionReviewReceipts[0].payload,
      questions: allAutomatic };
    await expect(admitFinalCampaign(FINAL.authorities.policy, { ...FINAL.input,
      questionReviewReceipts: [FINAL.authorities.signers.reviewer_1.signed(payload),
        FINAL.authorities.signers.reviewer_2.signed(payload)] }))
      .rejects.toThrow(/200 automatic and 40/u);
    const first = FINAL.evidence[0]!.payload;
    const mutations = [
      { rankedLocatorIds: ["locator-0", "locator-0"] },
      { rankedLocatorIds: ["foreign-locator"] },
      { rankedLocatorIds: Array.from({ length: 11 }, (_, index) => `locator-${index % 10}`) },
      { relevantLocatorIds: ["locator-0", "locator-0"] },
    ];
    for (const mutation of mutations) {
      const outcomes = first.outcomes.map((outcome, index) => index === 0 ?
        { ...outcome, ...mutation } : outcome);
      const receipt = FINAL.repetitionAuthority.signed({ ...first, outcomes,
        outcomesSha256: sha256(outcomes) });
      await expect(admitFinalCampaign(FINAL.authorities.policy, { ...FINAL.input,
        repetitionEvidence: [receipt, FINAL.evidence[1]!, FINAL.evidence[2]!] }))
        .rejects.toThrow();
    }
  }, 30_000);

  it("rejects every per-question gold membership permutation and local relevance selection", async () => {
    const payload = FINAL.input.goldRelevanceReceipt.payload;
    const entries = payload.entries;
    const firstEntry = entries[0]!;
    const without = (key: string) => Object.fromEntries(Object.entries(firstEntry)
      .filter(([name]) => name !== key));
    const replaceFirst = (entry: unknown) => [entry, ...entries.slice(1)];
    const mutations = [entries.toReversed(), [entries[0]!, entries[0]!, ...entries.slice(2)],
      entries.slice(1), [...entries, entries[0]!], entries.map((entry, index) => index === 0 ?
        { ...entry, relevantLocatorIds: ["locator-5"] } : entry),
      replaceFirst(without("campaignRootSha256")),
      replaceFirst({ ...firstEntry, unexpectedRoot: CAMPAIGN_ROOT }),
      replaceFirst({ ...firstEntry, campaignRootSha256: firstEntry.releaseRootSha256,
        releaseRootSha256: firstEntry.campaignRootSha256 }),
      replaceFirst({ ...firstEntry, campaignRootSha256: d("c") }),
      replaceFirst({ ...firstEntry, releaseRootSha256: d("d") })];
    for (const changedEntries of mutations) {
      const goldRelevanceReceipt = FINAL.goldRelevanceAuthority.signed({ ...payload,
        entries: changedEntries });
      const reviewPayload = { ...FINAL.input.questionReviewReceipts[0].payload,
        goldRelevanceReceiptSha256: sha256(goldRelevanceReceipt) };
      const questionReviewReceipts = [FINAL.authorities.signers.reviewer_1.signed(reviewPayload),
        FINAL.authorities.signers.reviewer_2.signed(reviewPayload)] as const;
      await expect(admitFinalCampaign(FINAL.authorities.policy, { ...FINAL.input,
        goldRelevanceReceipt, questionReviewReceipts })).rejects
        .toThrow(/gold|root|question/u);
    }
    const first = FINAL.evidence[0]!.payload;
    const outcomes = first.outcomes.map((outcome, index) => index === 0 ? { ...outcome,
      relevantLocatorIds: ["locator-5"] } : outcome);
    const metrics = reconstructMetrics(outcomes);
    const receipt = FINAL.repetitionAuthority.signed({ ...first, metrics,
      metricsSha256: sha256(metrics), outcomes, outcomesSha256: sha256(outcomes) });
    await expect(admitFinalCampaign(FINAL.authorities.policy, { ...FINAL.input,
      repetitionEvidence: [receipt, FINAL.evidence[1]!, FINAL.evidence[2]!] }))
      .rejects.toThrow(/signed per-question gold/u);
  }, 30_000);

  it("accepts alternative gold with recomputed reviewers before later repetition gates", async () => {
    const goldEntries = FINAL.input.goldRelevanceReceipt.payload.entries.map((entry) => ({
      ...entry, relevantLocatorIds: [...entry.relevantLocatorIds].toReversed() }));
    const goldRelevanceReceipt = FINAL.goldRelevanceAuthority.signed({
      ...FINAL.input.goldRelevanceReceipt.payload, entries: goldEntries });
    const reviewPayload = { ...FINAL.input.questionReviewReceipts[0].payload,
      goldRelevanceReceiptSha256: sha256(goldRelevanceReceipt) };
    const questionReviewReceipts = [FINAL.authorities.signers.reviewer_1.signed(reviewPayload),
      FINAL.authorities.signers.reviewer_2.signed(reviewPayload)] as const;
    const rootBindingSha256 = sha256({ authorizedLocatorSetSha256: sha256(
      FINAL.input.authorizedLocatorInventory.payload.locatorIds), campaignRootSha256: CAMPAIGN_ROOT,
    questionSetSha256: sha256(FINAL.questions), relevanceAuthoritySha256: sha256(goldEntries),
    releaseRootSha256: FINAL.release.releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_final_root_binding.v3",
    spendReservationSetSha256: sha256(FINAL.input.spendReservationSha256ByRepetition) });
    await expect(admitFinalCampaign(FINAL.authorities.policy, { ...FINAL.input,
      goldRelevanceReceipt, questionReviewReceipts, repetitionEvidence: [],
      rootBindingSha256 })).rejects.toThrow(/three authenticated repetitions/u);
  }, 30_000);

  it("excludes isolated and mixed explicit abstentions from every retrieval total", () => {
    const answerable = FINAL.outcomesByRepetition[0]![0]!;
    const abstention = { ...answerable, abstention: { expected: true, observed: true },
      citationChecks: [], claimChecks: [], rankedLocatorIds: [], relevantLocatorIds: [],
      speakerTimeChecks: [] };
    const isolated = reconstructMetrics([abstention]).find(({ group }) => group === "overall")!;
    expect({ complete10: isolated.completeRecallAt10PassedCount,
      complete5: isolated.completeRecallAt5PassedCount,
      mrr: isolated.firstRelevantReciprocalRankMillionthsTotal,
      ndcg: isolated.ndcgAt10MillionthsTotal,
      recall10: isolated.retrievedRelevantLocatorCountAt10,
      recall5: isolated.retrievedRelevantLocatorCountAt5,
      relevant: isolated.relevantLocatorCount,
      retrievalApplicable: isolated.retrievalApplicableOutcomeCount })
      .toEqual({ complete10: 0, complete5: 0, mrr: 0, ndcg: 0, recall10: 0,
        recall5: 0, relevant: 0, retrievalApplicable: 0 });
    const answerableOnly = reconstructMetrics([answerable])
      .find(({ group }) => group === "overall")!;
    const mixed = reconstructMetrics([answerable, abstention])
      .find(({ group }) => group === "overall")!;
    expect({ complete10: mixed.completeRecallAt10PassedCount,
      complete5: mixed.completeRecallAt5PassedCount,
      mrr: mixed.firstRelevantReciprocalRankMillionthsTotal,
      ndcg: mixed.ndcgAt10MillionthsTotal,
      recall10: mixed.retrievedRelevantLocatorCountAt10,
      recall5: mixed.retrievedRelevantLocatorCountAt5,
      relevant: mixed.relevantLocatorCount,
      retrievalApplicable: mixed.retrievalApplicableOutcomeCount })
      .toEqual({ complete10: answerableOnly.completeRecallAt10PassedCount,
        complete5: answerableOnly.completeRecallAt5PassedCount,
        mrr: answerableOnly.firstRelevantReciprocalRankMillionthsTotal,
        ndcg: answerableOnly.ndcgAt10MillionthsTotal,
        recall10: answerableOnly.retrievedRelevantLocatorCountAt10,
        recall5: answerableOnly.retrievedRelevantLocatorCountAt5,
        relevant: answerableOnly.relevantLocatorCount,
        retrievalApplicable: answerableOnly.retrievalApplicableOutcomeCount });
  });

  it("derives impossible top-five recall, MRR, citation, precision, speaker/time, and abstention failures", async () => {
    const first = FINAL.evidence[0]!.payload;
    const outcomes = first.outcomes.map((outcome, index) => index < 25 ? {
      ...outcome, abstention: { expected: true, observed: false },
      citationChecks: outcome.citationChecks.map((check) => ({ ...check, entailed: false })),
      claimChecks: outcome.claimChecks.map((check) => ({ ...check, supported: false })),
      rankedLocatorIds: ["locator-5", "locator-0", "locator-1", "locator-2", "locator-3"],
      relevantLocatorIds: ["locator-0", "locator-1", "locator-2", "locator-3", "locator-4",
        "locator-5"], retrievalLatencyUs: 2_000_000,
      scopeViolationLocatorIds: ["cross-scope-locator"],
      speakerTimeChecks: outcome.speakerTimeChecks.map((check) =>
        ({ ...check, observedSpeakerId: "foreign-speaker" })) } : outcome);
    const metrics = reconstructMetrics(outcomes);
    expect(metrics.find(({ group }) => group === "overall")?.thresholdPassed).toBe(false);
    const receipt = FINAL.repetitionAuthority.signed({ ...first, metrics,
      metricsSha256: sha256(metrics), outcomes, outcomesSha256: sha256(outcomes) });
    await expect(admitFinalCampaign(FINAL.authorities.policy, { ...FINAL.input,
      repetitionEvidence: [receipt, FINAL.evidence[1]!, FINAL.evidence[2]!] }))
      .rejects.toThrow(/relevance|thresholds/u);
  }, 90_000);

  it("binds final adjudication plaintext and authenticates canonical AES-256-GCM itself", async () => {
    const first = FINAL.evidence[0]!.payload;
    const outcomes = first.outcomes.map((outcome, index) => index === 0 ?
      { ...outcome, finalAdjudicationSha256: d("f") } : outcome);
    const digestMutation = FINAL.repetitionAuthority.signed({ ...first, outcomes,
      outcomesSha256: sha256(outcomes) });
    await expect(admitFinalCampaign(FINAL.authorities.policy, { ...FINAL.input,
      repetitionEvidence: [digestMutation, FINAL.evidence[1]!, FINAL.evidence[2]!] }))
      .rejects.toThrow(/final adjudication/u);
    await expect(admitFinalCampaign(FINAL.authorities.policy, { ...FINAL.input,
      artifactCustody: custody(FINAL.authorities.policy, FINAL.stored, Buffer.alloc(32, 9)) }))
      .rejects.toThrow(/AES-256-GCM authentication/u);
    await expect(admitFinalCampaign(FINAL.authorities.policy, { ...FINAL.input,
      artifactCustody: { loadKey: async () => null, readEnvelope: async () => null } }))
      .rejects.toThrow(/does not exist/u);
    await expect(admitFinalCampaign(FINAL.authorities.policy, { ...FINAL.input,
      artifactCustody: { openVerified: async () => ({}) } as never }))
      .rejects.toThrow();
    const wrongAuthority = FINAL.authorities.policy.authority("cleanup");
    await expect(admitFinalCampaign(FINAL.authorities.policy, { ...FINAL.input,
      artifactCustody: { loadKey: async () => ({ authorityKeyId: wrongAuthority.keyId,
        authorityPublicKeyFingerprintSha256: wrongAuthority.publicKeyFingerprintSha256,
        key: ARTIFACT_KEY, keyCustodySha256: FINAL.release.release.artifactKeyCustodySha256 }),
      readEnvelope: async ({ envelopeSha256 }) =>
        FINAL.stored.get(envelopeSha256)?.envelopeBytes ?? null } })).rejects
      .toThrow(/does not exist/u);

    const expected = FINAL.outcomesByRepetition[0]![0]!;
    const finalArtifact = FINAL.input.artifacts.find(({ attemptId, kind }) =>
      kind === "final_adjudication" && attemptId === artifactAttemptIdentity(expected.identity,
        "final_adjudication").attemptId)!;
    const retained = JSON.parse(Buffer.from(FINAL.stored.get(finalArtifact.envelopeSha256)!
      .plaintext).toString("utf8")) as Record<string, unknown>;
    expect(verifyRetainedFinalAdjudication(FINAL.authorities.policy, retained,
      artifactAttemptIdentity(expected.identity, "final_adjudication"), true).decision.answerComplete)
      .toBe(true);
    expect(() => verifyRetainedFinalAdjudication(FINAL.authorities.policy,
      { ...retained, firstReceipt: retained.secondReceipt },
      artifactAttemptIdentity(expected.identity, "final_adjudication"), true))
      .toThrow(/signer|signature/u);
    expect(() => verifyRetainedFinalAdjudication(FINAL.authorities.policy,
      { ...retained, attempt: { attemptId: expected.identity.attemptId,
        questionId: expected.identity.questionId } },
      artifactAttemptIdentity(expected.identity, "final_adjudication"), true)).toThrow();

    const firstEvidence = FINAL.evidence[0]!.payload;
    const authenticatedMutations = [
      { rankedLocatorIds: [...firstEvidence.outcomes[0]!.rankedLocatorIds].toReversed() },
      { speakerTimeChecks: firstEvidence.outcomes[0]!.speakerTimeChecks.map((check) =>
        ({ ...check, observedStartMs: check.observedStartMs + 1 })) },
    ];
    for (const mutation of authenticatedMutations) {
      const changed = firstEvidence.outcomes.map((outcome, index) => index === 0 ?
        { ...outcome, ...mutation } : outcome);
      const changedMetrics = reconstructMetrics(changed);
      const receipt = FINAL.repetitionAuthority.signed({ ...firstEvidence, metrics: changedMetrics,
        metricsSha256: sha256(changedMetrics), outcomes: changed, outcomesSha256: sha256(changed) });
      await expect(admitFinalCampaign(FINAL.authorities.policy, { ...FINAL.input,
        repetitionEvidence: [receipt, FINAL.evidence[1]!, FINAL.evidence[2]!] }))
        .rejects.toThrow(/authenticated/u);
    }
  }, 30_000);

  it("blocks answerComplete false and every retained artifact omission or binding swap", async () => {
    const first = FINAL.evidence[0]!.payload;
    const selected = first.outcomes[1]!;
    const oldFinal = FINAL.input.artifacts.find(({ attemptId, kind }) =>
      kind === "final_adjudication" && attemptId === artifactAttemptIdentity(selected.identity,
        "final_adjudication").attemptId)!;
    const predecessor = FINAL.input.artifacts.find(({ attemptId, kind }) =>
      kind === "adjudicator_2_result" && attemptId === artifactAttemptIdentity(selected.identity,
        "adjudicator_2_result").attemptId)!;
    const incompleteValue = finalAdjudicationValue(selected.identity, false, FINAL.authorities,
      predecessor.plaintextSha256, false);
    const incompleteArtifact = encryptedArtifact(selected.identity, "final_adjudication",
      Buffer.from(canonicalJson(incompleteValue)), FINAL.stored);
    const incompleteOutcomes = first.outcomes.map((outcome, index) => index === 1 ? { ...outcome,
      artifactBindingSha256ByKind: { ...outcome.artifactBindingSha256ByKind,
        final_adjudication: incompleteArtifact.artifactBindingSha256 },
      finalAdjudicationSha256: incompleteArtifact.plaintextSha256 } : outcome);
    const incompleteMetrics = reconstructMetrics(incompleteOutcomes);
    const incompleteReceipt = FINAL.repetitionAuthority.signed({ ...first,
      metrics: incompleteMetrics, metricsSha256: sha256(incompleteMetrics),
      outcomes: incompleteOutcomes, outcomesSha256: sha256(incompleteOutcomes) });
    const incompleteArtifacts = FINAL.input.artifacts.map((artifact) => artifact === oldFinal ?
      incompleteArtifact : artifact);
    await expect(admitFinalCampaign(FINAL.authorities.policy, { ...FINAL.input,
      artifacts: incompleteArtifacts, campaignByteCeiling: incompleteArtifacts.reduce(
        (total, artifact) => total + artifact.storedBytes, 0), repetitionEvidence:
        [incompleteReceipt, FINAL.evidence[1]!, FINAL.evidence[2]!] }))
      .rejects.toThrow(/answerComplete/u);

    const bindingKinds = [...KINDS.slice(0, -1), "resolver_result", "final_adjudication"] as const;
    for (const kind of bindingKinds) {
      const omitted = FINAL.input.artifacts.filter((artifact) => !(artifact.kind === kind &&
        artifact.questionId === first.outcomes[0]!.identity.questionId &&
        artifact.repetition === 1));
      await expect(admitFinalCampaign(FINAL.authorities.policy, { ...FINAL.input,
        artifacts: omitted })).rejects.toThrow(/missing/u);
    }
    for (let index = 0; index < bindingKinds.length; index += 1) {
      const left = bindingKinds[index]!;
      const right = bindingKinds[(index + 1) % bindingKinds.length]!;
      const original = first.outcomes[0]!;
      const bindings = { ...original.artifactBindingSha256ByKind,
        [left]: original.artifactBindingSha256ByKind[right] };
      const outcomes = first.outcomes.map((outcome, outcomeIndex) => outcomeIndex === 0 ?
        { ...outcome, artifactBindingSha256ByKind: bindings } : outcome);
      const receipt = FINAL.repetitionAuthority.signed({ ...first, outcomes,
        outcomesSha256: sha256(outcomes) });
      await expect(admitFinalCampaign(FINAL.authorities.policy, { ...FINAL.input,
        repetitionEvidence: [receipt, FINAL.evidence[1]!, FINAL.evidence[2]!] }))
        .rejects.toThrow(/corruption/u);
    }
  }, 90_000);

  it("rejects AES-valid rewritten requests and conflicting authoritative answer terminals", async () => {
    const first = FINAL.evidence[0]!.payload;
    const selected = first.outcomes[0]!;
    const kinds = [...KINDS.slice(0, -1), "resolver_result", "final_adjudication"] as const;
    const rewriteFrom = (startKind: (typeof kinds)[number], mutate: (value:
      Record<string, unknown>) => Record<string, unknown>) => {
      const bindings = { ...selected.artifactBindingSha256ByKind };
      const replacements = new Map<string, RetainedArtifact>();
      const start = kinds.indexOf(startKind);
      let predecessor = start === 0 ? null : FINAL.input.artifacts.find(({ attemptId, kind }) =>
        kind === kinds[start - 1] && attemptId === artifactAttemptIdentity(selected.identity,
          kinds[start - 1]!).attemptId)!.plaintextSha256;
      let finalAdjudicationSha256 = selected.finalAdjudicationSha256;
      for (const kind of kinds.slice(start)) {
        const identity = artifactAttemptIdentity(selected.identity, kind);
        const oldArtifact = FINAL.input.artifacts.find(({ attemptId, kind: candidateKind }) =>
          candidateKind === kind && attemptId === identity.attemptId)!;
        const oldValue = JSON.parse(Buffer.from(FINAL.stored.get(oldArtifact.envelopeSha256)!
          .plaintext).toString("utf8")) as Record<string, unknown>;
        const chained = kind === "final_adjudication" ? { ...oldValue,
          predecessorPlaintextSha256: predecessor } : { ...oldValue,
          chain: { ...(oldValue.chain as Record<string, unknown>),
            predecessorPlaintextSha256: predecessor } };
        const changed = kind === startKind ? mutate(chained) : chained;
        const replacement = encryptedArtifact(selected.identity, kind,
          Buffer.from(canonicalJson(changed)), FINAL.stored);
        replacements.set(`${replacement.attemptId}:${kind}`, replacement);
        bindings[kind] = replacement.artifactBindingSha256;
        predecessor = replacement.plaintextSha256;
        if (kind === "final_adjudication") {
          finalAdjudicationSha256 = replacement.plaintextSha256;
        }
      }
      const artifacts = FINAL.input.artifacts.map((artifact) => replacements.get(
        `${artifact.attemptId}:${artifact.kind}`) ?? artifact);
      const outcomes = first.outcomes.map((outcome, index) => index === 0 ? { ...outcome,
        artifactBindingSha256ByKind: bindings, finalAdjudicationSha256 } : outcome);
      const receipt = FINAL.repetitionAuthority.signed({ ...first, outcomes,
        outcomesSha256: sha256(outcomes) });
      return { artifacts, campaignByteCeiling: artifacts.reduce((sum, artifact) =>
        sum + artifact.storedBytes, 0), repetitionEvidence:
        [receipt, FINAL.evidence[1]!, FINAL.evidence[2]!] as const };
    };
    const rewrittenRequest = rewriteFrom("capability_request", (value) => {
      const requestBytes = Buffer.from(canonicalJson({ arbitrary: "AES-valid replacement" }));
      return { ...value, chain: { ...(value.chain as Record<string, unknown>),
        requestDigestSha256: sha256(requestBytes) },
      requestBytesBase64: requestBytes.toString("base64") };
    });
    await expect(admitFinalCampaign(FINAL.authorities.policy, { ...FINAL.input,
      ...rewrittenRequest })).rejects.toThrow(/exact provider request|predecessor|follow/u);
    const swappedKind = rewriteFrom("capability_request", (value) => ({ ...value,
      schemaVersion: "meeting_knowledge.semantic_quality_retrieval_request.v1" }));
    await expect(admitFinalCampaign(FINAL.authorities.policy, { ...FINAL.input,
      ...swappedKind })).rejects.toThrow(/foreign structure/u);
    const swappedDirection = rewriteFrom("capability_request", (value) => {
      const { requestBytesBase64: _, ...withoutRequest } = value;
      return { ...withoutRequest, responseBytesBase64: Buffer.from("response").toString("base64"),
        schemaVersion: "meeting_knowledge.semantic_quality_capability_response.v1" };
    });
    await expect(admitFinalCampaign(FINAL.authorities.policy, { ...FINAL.input,
      ...swappedDirection })).rejects.toThrow(/capability_request|record keys/u);

    const conflictingRaw = rewriteFrom("raw_outcome", (value) => {
      const responseBytes = Buffer.from(canonicalJson({ arbitrary: "second valid answer" }));
      const resultDigestSha256 = sha256(responseBytes);
      const chain = value.chain as Record<string, unknown>;
      const signedProviderTerminal = FINAL.authorities.signers.provider_result.signed({
        ...artifactAttemptIdentity(selected.identity, "raw_outcome"),
        requestDigestSha256: chain.requestDigestSha256, resultDigestSha256,
        schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal_payload.v4",
        state: "terminal_success" });
      return { ...value, chain: { ...chain, resultDigestSha256, signedProviderTerminal },
        responseBytesBase64: responseBytes.toString("base64") };
    });
    await expect(admitFinalCampaign(FINAL.authorities.policy, { ...FINAL.input,
      ...conflictingRaw })).rejects.toThrow(/one authoritative terminal/u);
  }, 90_000);

  it("reconstructs cleanup only from a release-pinned signed target inventory", async () => {
    const forged = FINAL.cleanupAuthority.signed(FINAL.input.targetInventoryReceipt.payload);
    await expect(admitFinalCampaign(FINAL.authorities.policy,
      { ...FINAL.input, targetInventoryReceipt: forged }))
      .rejects.toThrow(/signer|signature/u);
    const inventoryPayload = FINAL.input.targetInventoryReceipt.payload;
    const rejectedInventories = [
      { ...inventoryPayload, protectedOriginals: [{ artifactId: "summary-only",
        artifactSha256: d("a"), kind: "summary" }] },
      { ...inventoryPayload, protectedOriginals: inventoryPayload.protectedOriginals.slice(1) },
      { ...inventoryPayload, protectedOriginals: inventoryPayload.protectedOriginals.map(
        (original, index) => index === 1 ? { ...original,
          artifactId: inventoryPayload.protectedOriginals[0]!.artifactId } : original) },
      { ...inventoryPayload, protectedOriginals: inventoryPayload.protectedOriginals.map(
        (original, index) => index === 1 ? { ...original,
          artifactSha256: inventoryPayload.protectedOriginals[0]!.artifactSha256 } : original) },
      { ...inventoryPayload, protectedOriginals: inventoryPayload.protectedOriginals.map(
        (original, index) => index === 1 ? { ...original,
          kind: inventoryPayload.protectedOriginals[0]!.kind } : original) },
      { ...inventoryPayload, protectedOriginals: inventoryPayload.protectedOriginals.map(
        (original, index) => index === 1 ? { ...original, kind: "future_original" } : original) },
    ];
    for (const hostilePayload of rejectedInventories) {
      const hostile = FINAL.targetInventoryAuthority.signed(hostilePayload);
      expect(() => verifyCampaignCreatedTargetInventory(FINAL.authorities.policy, {
        authorityKeyId: FINAL.targetInventoryAuthority.keyId, campaignRootSha256: CAMPAIGN_ROOT,
        receipt: hostile, releaseRootSha256: FINAL.release.releaseRootSha256,
        targetInventoryAuthorityKeySha256:
          FINAL.release.release.targetInventoryAuthorityKeySha256 })).toThrow(/protected|kind/u);
    }
    const payload = FINAL.input.cleanupReceipt.payload;
    const missingProtected = FINAL.cleanupAuthority.signed({ ...payload,
      presentProtectedOriginals: payload.presentProtectedOriginals.slice(1),
      presentProtectedOriginalsSha256: sha256(payload.presentProtectedOriginals.slice(1)) });
    await expect(admitFinalCampaign(FINAL.authorities.policy,
      { ...FINAL.input, cleanupReceipt: missingProtected }))
      .rejects.toThrow(/authoritative/u);
    const unrelated = FINAL.cleanupAuthority.signed({ ...payload,
      absentArtifactIds: ["unrelated"], absentArtifactIdsSha256: sha256(["unrelated"]) });
    await expect(admitFinalCampaign(FINAL.authorities.policy,
      { ...FINAL.input, cleanupReceipt: unrelated }))
      .rejects.toThrow(/authoritative/u);
    const substitutedPresence = payload.presentProtectedOriginals.map((original, index) =>
      index === 0 ? { ...original, artifactSha256: d("f") } : original);
    const substitutedDigest = FINAL.cleanupAuthority.signed({ ...payload,
      presentProtectedOriginals: substitutedPresence,
      presentProtectedOriginalsSha256: sha256(substitutedPresence) });
    expect(() => verifyCleanupAbsenceReceipt(FINAL.authorities.policy, { authorityKeyId:
      FINAL.cleanupAuthority.keyId, cleanupManifest: {
        campaignRootSha256: CAMPAIGN_ROOT,
        inventoryReceiptSha256: sha256(FINAL.input.targetInventoryReceipt),
        protectedOriginals: inventoryPayload.protectedOriginals,
        releaseRootSha256: FINAL.release.releaseRootSha256,
        schemaVersion: "meeting_knowledge.semantic_quality_cleanup_manifest.v5",
        targets: inventoryPayload.targets } as never,
      receipt: substitutedDigest })).toThrow(/authoritative/u);

    const replayInventory = FINAL.targetInventoryAuthority.signed({ ...inventoryPayload,
      protectedOriginals: inventoryPayload.protectedOriginals.map((original, index) => index === 0 ?
        { ...original, artifactId: "replayed-original" } : original) });
    const replayManifest = verifyCampaignCreatedTargetInventory(FINAL.authorities.policy, {
      authorityKeyId: FINAL.targetInventoryAuthority.keyId, campaignRootSha256: CAMPAIGN_ROOT,
      receipt: replayInventory, releaseRootSha256: FINAL.release.releaseRootSha256,
      targetInventoryAuthorityKeySha256:
        FINAL.release.release.targetInventoryAuthorityKeySha256 }).manifest;
    expect(() => verifyCleanupAbsenceReceipt(FINAL.authorities.policy, { authorityKeyId:
      FINAL.cleanupAuthority.keyId, cleanupManifest: replayManifest,
    receipt: FINAL.input.cleanupReceipt })).toThrow(/authoritative/u);

    const sharedArtifactId = "overlap-artifact";
    const overlappingInventory = FINAL.targetInventoryAuthority.signed({
      ...FINAL.input.targetInventoryReceipt.payload,
      protectedOriginals: FINAL.input.targetInventoryReceipt.payload.protectedOriginals.map(
        (original) => original.kind === "original_craig_recording" ? { ...original,
          artifactId: sharedArtifactId } : original),
      targets: [{ artifactId: sharedArtifactId, kind: "derived_index" }] });
    expect(() => verifyCampaignCreatedTargetInventory(FINAL.authorities.policy, {
      authorityKeyId: FINAL.targetInventoryAuthority.keyId, campaignRootSha256: CAMPAIGN_ROOT,
      receipt: overlappingInventory, releaseRootSha256: FINAL.release.releaseRootSha256,
      targetInventoryAuthorityKeySha256:
        FINAL.release.release.targetInventoryAuthorityKeySha256 })).toThrow(/overlap/u);

    const overlappingManifest = { campaignRootSha256: CAMPAIGN_ROOT,
      inventoryReceiptSha256: sha256(overlappingInventory),
      protectedOriginals: overlappingInventory.payload.protectedOriginals,
      releaseRootSha256: FINAL.release.releaseRootSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_cleanup_manifest.v5" as const,
      targets: overlappingInventory.payload.targets };
    const overlapIds = [sharedArtifactId];
    const overlapOriginals = overlappingManifest.protectedOriginals.toSorted((left, right) =>
      left.kind.localeCompare(right.kind));
    const overlappingPresence = FINAL.cleanupAuthority.signed({ absentArtifactIds: overlapIds,
      absentArtifactIdsSha256: sha256(overlapIds), campaignRootSha256: CAMPAIGN_ROOT,
      cleanupManifestSha256: sha256(overlappingManifest),
      presentProtectedOriginals: overlapOriginals,
      presentProtectedOriginalsSha256: sha256(overlapOriginals),
      releaseRootSha256: FINAL.release.releaseRootSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_cleanup_absence.v5" });
    expect(() => verifyCleanupAbsenceReceipt(FINAL.authorities.policy, { authorityKeyId:
      FINAL.cleanupAuthority.keyId, cleanupManifest: overlappingManifest as never,
    receipt: overlappingPresence })).toThrow(/overlap/u);
  }, 90_000);

  it("binds protected originals to canonical custody before derived cleanup", async () => {
    const protectedOriginals = FINAL.input.targetInventoryReceipt.payload.protectedOriginals;
    const protectedEvidence = [...protectedOriginals,
      { artifactId: "frozen-snapshot", artifactSha256: d("a"), kind: "frozen_snapshot" },
      { artifactId: "frozen-root", artifactSha256: d("b"), kind: "frozen_signed_root" },
    ] as readonly ProtectedCampaignEvidence[];
    const deleteDerived = vi.fn(async ({ targets }: { readonly targets: readonly {
      readonly artifactId: string }[] }) => targets.map(({ artifactId }) =>
      ({ artifactId, outcome: "deleted" as const })));
    const observe = vi.fn(async ({ campaignRootSha256, cleanupManifestSha256 }:
      { readonly campaignRootSha256: string; readonly cleanupManifestSha256: string }) => {
      const presentProtectedOriginals = protectedOriginals.toSorted((left, right) =>
        left.kind.localeCompare(right.kind));
      return FINAL.cleanupAuthority.signed({ absentArtifactIds: ["derived-1", "prompt-1"],
        absentArtifactIdsSha256: sha256(["derived-1", "prompt-1"]), campaignRootSha256,
        cleanupManifestSha256, presentProtectedOriginals,
        presentProtectedOriginalsSha256: sha256(presentProtectedOriginals),
        releaseRootSha256: FINAL.release.releaseRootSha256,
        schemaVersion: "meeting_knowledge.semantic_quality_cleanup_absence.v5" });
    });
    const common = { absenceAuthority: FINAL.cleanupAuthority, campaignRootSha256: CAMPAIGN_ROOT,
      context: { deadlineEpochMs: 2_000, signal: ACTIVE_SIGNAL }, deletion: {
        authorityId: FINAL.targetInventoryAuthority.keyId, deleteDerived }, observation: {
        authorityId: FINAL.cleanupAuthority.keyId, observe }, policy: FINAL.authorities.policy,
      protectedEvidence, releaseRootSha256: FINAL.release.releaseRootSha256,
      targetInventoryAuthority: FINAL.targetInventoryAuthority,
      targetInventoryAuthorityKeySha256:
        FINAL.release.release.targetInventoryAuthorityKeySha256 } as const;
    const result = await executeDerivedCleanup({ ...common,
      targetInventoryReceipt: FINAL.input.targetInventoryReceipt });
    expect(result.targetCount).toBe(2);
    expect(deleteDerived).toHaveBeenCalledOnce();
    expect(deleteDerived.mock.calls[0]![0].targets.map(({ artifactId }) => artifactId))
      .toEqual(["derived-1", "prompt-1"]);

    deleteDerived.mockClear();
    const substituted = FINAL.targetInventoryAuthority.signed({
      ...FINAL.input.targetInventoryReceipt.payload,
      protectedOriginals: protectedOriginals.map((original, index) => index === 0 ? {
        ...original, artifactSha256: d("e") } : original) });
    await expect(executeDerivedCleanup({ ...common, targetInventoryReceipt: substituted }))
      .rejects.toThrow(/canonical custody/u);
    expect(deleteDerived).not.toHaveBeenCalled();
  });

  it("derives the signed 30-question holdout without affecting main qualification", () => {
    const questions = sealedQuestions(30, "independent_review", "h");
    const mainSigner = FINAL.authorities.signers.main_proof;
    const holdoutSigner = FINAL.authorities.signers.holdout_authorization;
    const questionSigner = FINAL.authorities.signers.holdout_question;
    const main = { loadedLocatorDigests: [d("a")], loadedQuestionDigests: [d("b")],
      mainInputRootSha256: d("6"), mainReleaseRootSha256: FINAL.release.releaseRootSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_main_input_proof.v1",
      tuningCorpusSha256: d("7") };
    const questionPayload = { mainInputRootSha256: main.mainInputRootSha256,
      mainReleaseRootSha256: main.mainReleaseRootSha256, questionSetSha256: sha256(questions),
      questions, schemaVersion: "meeting_knowledge.semantic_quality_holdout_questions.v1" };
    const questionReceipt = questionSigner.signed(questionPayload);
    const holdoutLocatorDigests = [d("c"), d("d")];
    const holdoutRootSha256 = sha256({ holdoutLocatorSetSha256: sha256(holdoutLocatorDigests),
      holdoutQuestionSetSha256: sha256(questions), mainInputRootSha256: main.mainInputRootSha256,
      mainReleaseRootSha256: main.mainReleaseRootSha256,
      questionReceiptSha256: sha256(questionReceipt),
      schemaVersion: "meeting_knowledge.semantic_quality_holdout_root.v1" });
    const authorization = { holdoutLocatorSetSha256: sha256(holdoutLocatorDigests),
      holdoutQuestionSetSha256: sha256(questions), holdoutRootSha256,
      keyNamespace: `holdout:${holdoutRootSha256}`, mainInputRootSha256: main.mainInputRootSha256,
      mainReleaseRootSha256: main.mainReleaseRootSha256,
      questionReceiptSha256: sha256(questionReceipt),
      schemaVersion: "meeting_knowledge.semantic_quality_holdout_authorization.v2" };
    const input = { authorization: holdoutSigner.signed(authorization),
      authorizationAuthorityKeyId: holdoutSigner.keyId, holdoutLocatorDigests,
      main: mainSigner.signed(main), mainAuthorityKeyId: mainSigner.keyId,
      questionAuthorityKeyId: questionSigner.keyId,
      questionReceipt, questions };
    expect(admitIsolatedHoldout(FINAL.authorities.policy, input).questions).toHaveLength(30);
    expect(() => admitIsolatedHoldout(FINAL.authorities.policy, { ...input,
      authorizationAuthorityKeyId: questionSigner.keyId })).toThrow(/not trusted/u);
    expect(createHoldoutReport({ cleanupReceiptSha256: d("1"), holdoutRootSha256,
      outcomeCount: 90, reportMetricsSha256: d("2") }).affectsMainQualification).toBe(false);
  });

});
