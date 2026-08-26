import { createCipheriv, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  admitFinalCampaign, admitIsolatedHoldout, admitMainCampaign, adjudicateOutcome,
  artifactAttemptIdentity, assertObservedRelease, attemptIdentity,
  canonicalJson, createHoldoutReport, DurableAttemptJournal, executeReservedExchange,
  FROZEN_ANSWER_EXECUTION, publicKeyFingerprintSha256, reconstructMetrics,
  QUALITY_AUTHORITY_ROLES, QualityCampaignAuthorityPolicy, sha256,
  verifyReleaseRoot,
  verifyCampaignCreatedTargetInventory, verifyCleanupAbsenceReceipt, verifySpendReservation,
  verifyRetainedFinalAdjudication,
  type AdjudicationRequest, type ArtifactCustodyPort,
  type AttemptIdentity, type CampaignQuestion, type CanonicalAdjudicationDecision,
  type EncryptedArtifactKind,
  type PinnedReleaseDocument, type QualificationOutcome, type QualityCampaignRelease,
  type RepetitionQualificationEvidence, type RetainedArtifact,
} from "../src/index.js";

const d = (character: string) => character.repeat(64);
const CAMPAIGN_ROOT = d("1");
const ARTIFACT_KEY = Buffer.alloc(32, 7);
const PROVIDER = "pinned-provider";
const ACTIVE_SIGNAL = new AbortController().signal;

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
  const nonce = Buffer.from(sha256(`${identity.attemptId}:${kind}`), "hex").subarray(0, 12);
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

function finalAdjudicationPlaintext(attempt: AttemptIdentity, resolverRequired: boolean,
  authorities: ReturnType<typeof authorityFixture>): Uint8Array {
  const outcomeDigestSha256 = sha256({ attemptId: attempt.attemptId, kind: "raw-outcome" });
  const encryptedEvidenceSha256 = sha256({ attemptId: attempt.attemptId, kind: "evidence" });
  const decision = { answerComplete: true, claims: [{ abstentionCorrect: true,
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
  return Buffer.from(canonicalJson({ attempt, decision, decisionDigestSha256: sha256(decision),
    encryptedEvidenceSha256, firstReceipt, outcomeDigestSha256, resolverReceipt,
    schemaVersion: "meeting_knowledge.semantic_quality_final_adjudication.v2", secondReceipt }));
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

function finalFixture() {
  const authorities = authorityFixture(); const targetInventoryAuthority = authorities.signers.inventory;
  const release = releaseFixture(authorities); const spendAuthority = authorities.signers.spend;
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
  const questionReviewPayload = { campaignRootSha256: CAMPAIGN_ROOT, questions,
    releaseRootSha256: release.releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_reviewed_main_questions.v1" };
  const questionReviewReceipts = [authorities.signers.reviewer_1.signed(questionReviewPayload),
    authorities.signers.reviewer_2.signed(questionReviewPayload)] as const;
  const rootBindingSha256 = sha256({ authorizedLocatorSetSha256: sha256(authorizedLocatorIds),
    campaignRootSha256: CAMPAIGN_ROOT, questionSetSha256: sha256(questions),
    releaseRootSha256: release.releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_final_root_binding.v2",
    spendReservationSetSha256: sha256(spendDigests) });
  const stored = new Map<string, StoredEnvelope>(); const artifacts: RetainedArtifact[] = [];
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
      const finalPlaintext = finalAdjudicationPlaintext(identity, resolverRequired, authorities);
      const finalAdjudicationSha256 = sha256(finalPlaintext);
      const artifactBindingSha256ByKind: Record<string, string> = {};
      const kinds: readonly EncryptedArtifactKind[] = resolverRequired ?
        [...KINDS, "resolver_result"] : KINDS;
      for (const kind of kinds) {
        const artifactIdentity = artifactAttemptIdentity(identity, kind);
        const plaintext = kind === "final_adjudication" ? finalPlaintext :
          kind === "retrieval_response" ? Buffer.from(canonicalJson({ attempt: artifactIdentity,
            latencyUs: 200_000, rankedLocatorIds,
            schemaVersion: "meeting_knowledge.semantic_quality_retrieval_evidence.v1",
            scopeViolationLocatorIds: [] })) : kind === "evidence" ?
            Buffer.from(canonicalJson({ attempt: artifactIdentity, evidenceTurnIds: [turnId],
              schemaVersion: "meeting_knowledge.semantic_quality_canonical_evidence.v1",
              speakerTimeChecks })) : Buffer.from(`${identity.attemptId}:${kind}`);
        const artifact = encryptedArtifact(identity, kind, plaintext, stored);
        artifacts.push(artifact); artifactBindingSha256ByKind[kind] = artifact.artifactBindingSha256;
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
        speakerTimeChecks };
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
    protectedOriginals: ["authoritative_transcript", "final_transcript", "meeting_database",
      "original_craig_recording", "summary"].map((kind, index) =>
      ({ artifactId: `protected-${index}`, kind })),
    releaseRootSha256: release.releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_campaign_target_inventory.v1",
    targets: [{ artifactId: "derived-1", kind: "derived_index" },
      { artifactId: "prompt-1", kind: "temporary_prompt" }] });
  const manifest = { campaignRootSha256: CAMPAIGN_ROOT,
    inventoryReceiptSha256: sha256(targetInventoryReceipt),
    protectedOriginals: targetInventoryReceipt.payload.protectedOriginals,
    releaseRootSha256: release.releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_cleanup_manifest.v4",
    targets: targetInventoryReceipt.payload.targets };
  const cleanupAuthority = authorities.signers.cleanup;
  const absentArtifactIds = manifest.targets.map(({ artifactId }) => artifactId).toSorted();
  const presentProtectedArtifactIds = manifest.protectedOriginals.map(({ artifactId }) =>
    artifactId).toSorted();
  const cleanupReceipt = cleanupAuthority.signed({ absentArtifactIds,
    absentArtifactIdsSha256: sha256(absentArtifactIds), campaignRootSha256: CAMPAIGN_ROOT,
    cleanupManifestSha256: sha256(manifest), presentProtectedArtifactIds,
    presentProtectedArtifactIdsSha256: sha256(presentProtectedArtifactIds),
    releaseRootSha256: release.releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_cleanup_absence.v4" });
  const input = { artifactCustody: custody(authorities.policy, stored), artifacts,
    authorizedLocatorInventory,
    campaignByteCeiling: artifacts.reduce((total, artifact) => total + artifact.storedBytes, 0),
    campaignRootSha256: CAMPAIGN_ROOT, cleanupAuthorityKeyId: cleanupAuthority.keyId,
    cleanupReceipt, locatorAuthorityKeyId: locatorAuthority.keyId, questionReviewReceipts,
    release: release.pinned,
    repetitionAuthorityKeyId: repetitionAuthority.keyId, repetitionEvidence: evidence,
    rootBindingSha256, spendReservationSha256ByRepetition: spendDigests,
    targetInventoryAuthorityKeyId: targetInventoryAuthority.keyId, targetInventoryReceipt } as const;
  return { authorities, cleanupAuthority, evidence, input, outcomesByRepetition, questions, release,
    repetitionAuthority, spendAuthority, spends, stored, targetInventoryAuthority };
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
    const port = { exchange: vi.fn(async () => ({ effect: "certain_success" as const,
      resultDigestSha256: d("6"), signedResult: providerAuthority.signed(terminalPayload({
        identity: attempt, request, resultDigestSha256: d("6"), state: "terminal_success" })) })) };
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
    const request = Buffer.from(identities[0]!.questionId); const resultDigestSha256 = d("6");
    const terminal = FINAL.authorities.signers.provider_result.signed(terminalPayload({ identity:
      identities[0]!, request, resultDigestSha256, state: "terminal_success" }));
    expect(await restarted.reconcileTerminal({ expectedResultDigestSha256: resultDigestSha256,
      identity: identities[0]!, requestDigestSha256: sha256(request), signedResult: terminal,
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
    const vault = { reconstruct: vi.fn(async () =>
      ({ encryptedEvidenceSha256: d("8"), outcomeDigestSha256: d("6") })) };
    expect((await adjudicateOutcome(FINAL.authorities.policy,
      { attempt, expectedAttempt: expectedAttempt(attempt), firstReceipt,
      rawOutcomeEnvelopeSha256: d("7"), resolverReceipt, secondReceipt, vault }))
      .decision.answerComplete)
      .toBe(true);
    vault.reconstruct.mockClear();
    await expect(adjudicateOutcome(FINAL.authorities.policy, { attempt,
      expectedAttempt: expectedAttempt(attempt), firstReceipt: secondReceipt,
      rawOutcomeEnvelopeSha256: d("7"), resolverReceipt, secondReceipt: firstReceipt,
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
        expectedAttempt: expectedAttempt(attempt), firstReceipt,
        rawOutcomeEnvelopeSha256: d("7"), resolverReceipt, secondReceipt, vault })).rejects.toThrow();
      expect(vault.reconstruct).not.toHaveBeenCalled();
    }
  });
});

describe("production quality campaign final evidence", () => {
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
  }, 30_000);

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
      .rejects.toThrow(/thresholds/u);
  }, 30_000);

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

  it("reconstructs cleanup only from a release-pinned signed target inventory", async () => {
    const forged = FINAL.cleanupAuthority.signed(FINAL.input.targetInventoryReceipt.payload);
    await expect(admitFinalCampaign(FINAL.authorities.policy,
      { ...FINAL.input, targetInventoryReceipt: forged }))
      .rejects.toThrow(/signer|signature/u);
    const payload = FINAL.input.cleanupReceipt.payload;
    const missingProtected = FINAL.cleanupAuthority.signed({ ...payload,
      presentProtectedArtifactIds: payload.presentProtectedArtifactIds.slice(1),
      presentProtectedArtifactIdsSha256: sha256(payload.presentProtectedArtifactIds.slice(1)) });
    await expect(admitFinalCampaign(FINAL.authorities.policy,
      { ...FINAL.input, cleanupReceipt: missingProtected }))
      .rejects.toThrow(/authoritative/u);
    const unrelated = FINAL.cleanupAuthority.signed({ ...payload,
      absentArtifactIds: ["unrelated"], absentArtifactIdsSha256: sha256(["unrelated"]) });
    await expect(admitFinalCampaign(FINAL.authorities.policy,
      { ...FINAL.input, cleanupReceipt: unrelated }))
      .rejects.toThrow(/authoritative/u);

    const sharedArtifactId = "overlap-artifact";
    const overlappingInventory = FINAL.targetInventoryAuthority.signed({
      ...FINAL.input.targetInventoryReceipt.payload,
      protectedOriginals: [{ artifactId: sharedArtifactId, kind: "original_craig_recording" }],
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
      schemaVersion: "meeting_knowledge.semantic_quality_cleanup_manifest.v4" as const,
      targets: overlappingInventory.payload.targets };
    const overlapIds = [sharedArtifactId];
    const overlappingPresence = FINAL.cleanupAuthority.signed({ absentArtifactIds: overlapIds,
      absentArtifactIdsSha256: sha256(overlapIds), campaignRootSha256: CAMPAIGN_ROOT,
      cleanupManifestSha256: sha256(overlappingManifest), presentProtectedArtifactIds: overlapIds,
      presentProtectedArtifactIdsSha256: sha256(overlapIds),
      releaseRootSha256: FINAL.release.releaseRootSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_cleanup_absence.v4" });
    expect(() => verifyCleanupAbsenceReceipt(FINAL.authorities.policy, { authorityKeyId:
      FINAL.cleanupAuthority.keyId, cleanupManifest: overlappingManifest as never,
    receipt: overlappingPresence })).toThrow(/overlap/u);
  }, 30_000);

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
      outcomeCount: 30, reportMetricsSha256: d("2") }).affectsMainQualification).toBe(false);
  });

});
