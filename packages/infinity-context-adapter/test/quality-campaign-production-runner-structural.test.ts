/* oxlint-disable max-lines, max-lines-per-function -- one production-scale fixture proves the closed 3x240 graph */
import { createCipheriv, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FROZEN_ANSWER_EXECUTION,
  QUALITY_AUTHORITY_ROLES,
  REQUIRED_RETAINED_KINDS,
  QualityCampaignAuthorityPolicy,
  admitMainCampaign,
  artifactAttemptIdentity,
  attemptIdentity,
  canonicalJson,
  publicKeyFingerprintSha256,
  holdoutReleaseExecutionBindingSha256,
  QUALIFICATION_PROVIDER_INPUT_CONTRACT,
  qualificationExecutionBinding,
  qualificationProviderAccountingFixture,
  reconstructMetrics,
  runQualityCampaignProductionCli,
  sha256,
  verifyReleaseRoot,
  type AttemptIdentity,
  type CampaignQuestion,
  type CanonicalAdjudicationDecision,
  type ExactAdjudicationEvidence,
  type ExactOutcomeEvidence,
  type QualityCampaignProductionPorts,
  type QualificationOutcome,
  type QualityCampaignRelease,
  type RetainedArtifact,
} from "@discord-meeting/infinity-context-adapter/quality-campaign";

const digest = (value: string) => sha256({ value });

function signer(keyId: string) {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
  return { keyId, publicKeyPem, signed<T>(payload: T) {return Object.freeze({ payload,
    signatureBase64: sign(null, Buffer.from(canonicalJson(payload)), keys.privateKey)
      .toString("base64"), signerKeyId: keyId });} };
}

function questions(count: number, source: CampaignQuestion["source"], prefix: string) {
  return Array.from({ length: count }, (_, index) => Object.freeze({ locale: index % 2 === 0 ?
    "en" as const : "ru" as const, questionDigestSha256: digest(`${prefix}:question:${index}`),
  questionId: `${prefix}-${index}`, rubricDigestSha256: digest(`${prefix}:rubric:${index}`), source }));
}

function decisionFor(questionId: string, outcomeDigestSha256: string,
  answerComplete: boolean): CanonicalAdjudicationDecision {
  return { answerComplete, claims: [{ abstentionCorrect: true,
    citationEntailed: true, claimFactual: true, claimId: `${questionId}-claim`,
    claimSupported: true, matchedGoldClaimId: `${questionId}-gold` }],
  outcomeDigestSha256, questionId };
}

describe("installed production quality-campaign CLI", () => {
  it("runs 3x240 with bounded restart, review, cleanup and isolated 30 holdout", async () => {
    const fixture = await createFixture();
    expect(await fixture.cli("preflight", "preflight-status.json")).toBe(20);
    expect(fixture.mainCalls).toHaveLength(0);
    fixture.clock.crashAfter = 30;
    expect(await fixture.cli("execute", "crash-status.json")).toBe(1);
    const callsBeforeRestart = fixture.mainCalls.length;
    expect(callsBeforeRestart).toBeGreaterThan(0);

    fixture.clock.crashAfter = null;
    expect(await fixture.cli("execute", "execute-status.json")).toBe(20);
    expect(fixture.mainCalls).toHaveLength(3 * 240 * 3);
    expect(new Set(fixture.mainCalls.map(({ attemptId }) => attemptId))).toHaveLength(
      fixture.mainCalls.length);
    expect(fixture.maximumProviderConcurrency).toBeGreaterThan(1);
    expect(fixture.maximumProviderConcurrency).toBeLessThanOrEqual(8);
    for (const call of fixture.mainCalls) {
      expect(call.request.release).toEqual(fixture.release);
      expect(call.request.providerInputContract).toEqual(QUALIFICATION_PROVIDER_INPUT_CONTRACT);
      expect(call.request.qualificationExecutionBinding).toEqual(
        qualificationExecutionBinding(fixture.release));
      expect(call.request.callDeadlineEpochMs).toBeLessThanOrEqual(
        call.request.campaignDeadlineEpochMs as number);
      expect((call.request.campaignDeadlineEpochMs as number) - fixture.startedAt)
        .toBe(72 * 60 * 60 * 1_000);
      expect(call.request.spendReservationSha256).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(fixture.mainCalls.length - callsBeforeRestart).toBeLessThan(3 * 240 * 3);

    expect(await fixture.cli("adjudicate", "adjudicate-status.json")).toBe(20);
    expect(fixture.reviewCalls.first).toBe(720);
    expect(fixture.reviewCalls.second).toBe(720);
    expect(fixture.reviewCalls.resolver).toBe(3);
    expect(await fixture.cli("retention", "retention-status.json")).toBe(20);
    expect(await fixture.cli("cleanup-absence", "cleanup-status.json")).toBe(20);
    expect(fixture.deletedIds.toSorted()).toEqual(["derived-index", "projection", "prompt"]);
    expect(fixture.observedIds.toSorted()).toEqual(fixture.deletedIds.toSorted());
    expect(await fixture.cli("final-admission", "final-admission-status.json")).toBe(0);
    expect(fixture.deletedIds).toHaveLength(3);

    expect(fixture.holdoutCalls).toHaveLength(0);
    expect(await fixture.cli("holdout-execute", "holdout-execute-status.json")).toBe(20);
    expect(fixture.holdoutCalls).toHaveLength(30 * 3 * 3);
    expect(new Set(fixture.holdoutCalls.map(({ questionId }) => questionId)).size).toBe(30);
    expect(fixture.mainCalls.some(({ questionId }) => questionId.startsWith("h-"))).toBe(false);
    expect(await fixture.cli("holdout-adjudicate", "holdout-adjudicate-status.json")).toBe(20);
    expect(await fixture.cli("holdout-cleanup", "holdout-cleanup-status.json")).toBe(0);
    expect(await fixture.cli("holdout-status", "holdout-status.json")).toBe(0);

    for (const statusName of ["execute-status.json", "adjudicate-status.json",
      "retention-status.json", "cleanup-status.json", "final-admission-status.json",
      "holdout-execute-status.json",
      "holdout-adjudicate-status.json", "holdout-cleanup-status.json", "holdout-status.json"]) {
      const status = await readFile(join(fixture.root, statusName), "utf8");
      expect(status).not.toMatch(/question|rubric|transcript|credential|secret|answer text/iu);
    }
    fixture.releaseEvidence();
  }, 600_000);

  it("durably blocks an ambiguous outcome without repeating it or leaking status", async () => {
    const fixture = await createFixture();
    fixture.ambiguousNext = true;
    expect(await fixture.cli("execute", "unknown-1.json")).toBe(21);
    const calls = fixture.mainCalls.length;
    expect(await fixture.cli("execute", "unknown-2.json")).toBe(21);
    expect(fixture.mainCalls).toHaveLength(calls);
    const status = await readFile(join(fixture.root, "unknown-2.json"), "utf8");
    expect(status).toContain("outcome_unknown");
    expect(status).not.toMatch(/question|rubric|transcript|credential|secret/iu);
  }, 30_000);

  it("rejects substituted custody and a reused holdout root", async () => {
    const emptyCustody = await createFixture();
    await emptyCustody.writeCustody([]);
    expect(await emptyCustody.cli("preflight", "empty-custody.json")).toBe(1);

    const sameRoot = await createFixture();
    await sameRoot.writeHoldoutRoot(sameRoot.mainRootSha256);
    expect(await sameRoot.cli("holdout-execute", "same-root.json")).toBe(1);

  }, 180_000);

  it("rejects a signed protected-original substitution before composition deletes derived data",
    async () => {
      const fixture = await createFixture();
      expect(await fixture.cli("execute", "execute-before-substitution.json")).toBe(20);
      expect(await fixture.cli("adjudicate", "adjudicate-before-substitution.json")).toBe(20);
      expect(await fixture.cli("retention", "retention-before-substitution.json")).toBe(20);
      await fixture.writeCleanupProtectedOriginals(fixture.protectedOriginals.map(
        (original, index) => index === 0 ? { ...original,
          artifactSha256: digest("hostile-substitution") } : original));
      expect(await fixture.cli("cleanup-absence", "substituted-cleanup.json")).toBe(1);
      expect(fixture.deletedIds).toHaveLength(0);
    }, 180_000);
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "quality-production-runner-"));
  const startedAt = 10_000;
  const clock = { calls: 0, crashAfter: null as number | null, nowEpochMs() {
    this.calls += 1;
    if (this.crashAfter !== null && this.calls >= this.crashAfter) {
      throw new Error("simulated process crash");
    }
    return startedAt;
  } };
  const custody = signer("custody"); const absence = signer("absence");
  const deletion = signer("deletion"); const goldRelevance = signer("gold-relevance");
  const locator = signer("locator");
  const mainProofAuthority = signer("main-proof"); const holdoutQuestion = signer("holdout-question");
  const reviewer1 = signer("reviewer-1"); const reviewer2 = signer("reviewer-2");
  const judge1 = signer("judge-1"); const judge2 = signer("judge-2");
  const resolver = signer("resolver"); const provider = signer("provider-results");
  const holdoutProvider = signer("holdout-provider-results");
  const releaseAuthority = signer("release"); const spend = signer("spend");
  const repetitionAuthority = signer("repetition-evidence");
  const holdoutAuthority = signer("holdout-custody");
  const policyAuthorities = { artifact_custody: custody, cleanup: absence,
    gold_relevance: goldRelevance,
    holdout_authorization: holdoutAuthority, holdout_provider_result: holdoutProvider,
    holdout_question: holdoutQuestion,
    inventory: deletion, locator, main_proof: mainProofAuthority, provider_result: provider,
    release: releaseAuthority, repetition: repetitionAuthority, resolver,
    reviewer_1: reviewer1, reviewer_2: reviewer2, spend } as const;
  const policy = new QualityCampaignAuthorityPolicy(Object.fromEntries(
    QUALITY_AUTHORITY_ROLES.map((role) => [role, { keyId: policyAuthorities[role].keyId,
      publicKeyFingerprintSha256: publicKeyFingerprintSha256(
        policyAuthorities[role].publicKeyPem, `${role} authority`),
      publicKeyPem: policyAuthorities[role].publicKeyPem }])) as never);
  const release: QualityCampaignRelease = {
    answerImageSha256: digest("answer-image"), answerProcessIdentitySha256: digest("answer-process"),
    answerReleaseSha256: digest("answer-release"), artifactKeyCustodySha256:
    policy.authority("artifact_custody").publicKeyFingerprintSha256,
    authorityPolicySha256: policy.bindingSha256, discordCommitSha256: digest("discord-commit"),
    discordImageSha256: digest("discord-image"), discordReleaseSha256: digest("discord-release"),
    infinityCapabilitySha256: digest("capability"), infinityCommitSha256: digest("infinity-commit"),
    infinityImageSha256: digest("infinity-image"), infinityProfileSha256: digest("profile"),
    infinityReleaseSha256: digest("infinity-release"), mapperSha256: digest("mapper"),
    ...FROZEN_ANSWER_EXECUTION, policySha256: digest("policy"), promptSha256: digest("prompt"),
    sdkArchiveSha256: digest("sdk-archive"), targetInventoryAuthorityKeySha256:
    publicKeyFingerprintSha256(deletion.publicKeyPem, "target inventory authority"),
    tokenizerSha256: digest("tokenizer"),
  };
  const releaseDocument = releaseAuthority.signed(release);
  const releaseRootSha256 = verifyReleaseRoot(policy, { authorityKeyId: releaseAuthority.keyId,
    document: releaseDocument }).releaseRootSha256;
  const authorities = { absence, custody, deletion, goldRelevance, holdoutAuthority, holdoutProvider, judge1,
    judge2, resolver, holdoutQuestion, locator, mainProofAuthority, provider, releaseAuthority,
    repetitionAuthority, reviewer1, reviewer2, spend };
  const authorityPaths = Object.fromEntries(await Promise.all(Object.entries(authorities).map(
    async ([name, authority]) => [name, await writeAuthority(root, name, authority)] as const)));
  const releasePublicKeyPath = join(root, "release.pem");
  await writeFile(releasePublicKeyPath, releaseAuthority.publicKeyPem);
  const releaseRootPath = join(root, "release.json");
  await writeFile(releaseRootPath, canonicalJson(releaseDocument));
  const authorityPolicyPath = join(root, "authority-policy.json");
  await writeFile(authorityPolicyPath, canonicalJson(Object.fromEntries(
    QUALITY_AUTHORITY_ROLES.map((role) => [role, authorityPaths[role === "artifact_custody" ?
      "custody" : role === "cleanup" ? "absence" : role === "holdout_authorization" ?
      "holdoutAuthority" : role === "holdout_provider_result" ? "holdoutProvider" :
      role === "gold_relevance" ? "goldRelevance" :
      role === "holdout_question" ? "holdoutQuestion" :
      role === "inventory" ? "deletion" : role === "main_proof" ? "mainProofAuthority" :
      role === "provider_result" ? "provider" : role === "release" ? "releaseAuthority" :
      role === "repetition" ? "repetitionAuthority" : role === "reviewer_1" ? "reviewer1" :
      role === "reviewer_2" ? "reviewer2" : role]]))));

  const automatic = questions(200, "automatic", "a");
  const reviewed = questions(40, "independent_review", "r");
  const allQuestions = [...automatic, ...reviewed];
  const sourceDigestSha256 = digest("source"); const corpusDigestSha256 = digest("corpus");
  const reviewerDigestSha256 = digest("reviewer-registry");
  const acceptance = custody.signed({ corpusDigestSha256, purpose: "custody_only",
    reviewerDigestSha256, schemaVersion: "meeting_knowledge.semantic_quality_acceptance.v1",
    sourceDigestSha256 });
  const authorization = custody.signed({ acceptanceReceiptSha256: sha256(acceptance),
    authorizedProviderExecution: true, corpusDigestSha256, expiresAtEpochMs: 4_000_000_000_000,
    releaseRootSha256, schemaVersion:
    "meeting_knowledge.semantic_quality_execution_authorization.v1" });
  const reviewPayload = { corpusDigestSha256, questionSetSha256: sha256(allQuestions),
    reviewerDigestSha256, rubricSetSha256: sha256(allQuestions.map(({ questionId,
      rubricDigestSha256 }) => ({ questionId, rubricDigestSha256 }))), schemaVersion:
    "meeting_knowledge.semantic_quality_question_review.v1" };
  const locatorPayload = { entriesSha256: digest("locators"), releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_locator_authority.v1",
    snapshotSha256: digest("snapshot") };
  const sealedFiles: Record<string, unknown> = {
    "acceptance.json": acceptance, "authorization.json": authorization,
    "automatic.json": automatic, "forbidden.json": custody.signed(locatorPayload),
    "mapping.json": custody.signed(locatorPayload), "review-1.json": reviewer1.signed(reviewPayload),
    "review-2.json": reviewer2.signed(reviewPayload), "reviewed.json": reviewed,
  };
  for (const [name, value] of Object.entries(sealedFiles)) {
    await writeFile(join(root, name), canonicalJson(value));
  }
  const checksumInventory = await Promise.all(Object.keys(sealedFiles).map(async (path) => ({ path,
    sha256: sha256(await readFile(join(root, path))) })));
  const manifestPath = join(root, "InputManifest.v4.json");
  await writeFile(manifestPath, canonicalJson({ acceptanceReceiptPath: "acceptance.json",
    checksumInventory, corpusDigestSha256, executionAuthorizationPath: "authorization.json",
    forbiddenLocatorManifestPath: "forbidden.json", independentReviewQuestionsPath:
    "reviewed.json", questionReviewReceiptPaths: ["review-1.json", "review-2.json"],
    reviewerDigestSha256, schemaVersion: "meeting_knowledge.semantic_quality_input_manifest.v4",
    sealedAutomaticQuestionsPath: "automatic.json", sourceDigestSha256,
    turnToBlockManifestPath: "mapping.json" }));
  const admitted = await admitMainCampaign(policy, { authorityKeyId: custody.keyId, manifestPath,
    nowEpochMs: startedAt, releaseRootSha256,
    reviewerAuthorityKeyIds: [reviewer1.keyId, reviewer2.keyId] });

  const spendReservationsPath = join(root, "spend.json");
  await writeSpendReservations(spendReservationsPath, spend, admitted.rootBindingSha256,
    releaseRootSha256);
  const protectedEvidence = ["original_craig_recording", "final_transcript", "meeting_database",
    "frozen_snapshot", "frozen_signed_root"].map((kind) => ({ artifactId: `custody-${kind}`,
      artifactSha256: digest(kind), kind }));
  const targets = [{ artifactId: "derived-index", kind: "derived_index" },
    { artifactId: "prompt", kind: "temporary_prompt" },
    { artifactId: "projection", kind: "temporary_projection" }] as const;
  const cleanupPlanPath = join(root, "cleanup-plan.json");
  const protectedOriginals = protectedEvidence.filter(({ kind }) =>
    !kind.startsWith("frozen_")).map(({ artifactId, artifactSha256, kind }) =>
    ({ artifactId, artifactSha256, kind }));
  await writeFile(cleanupPlanPath, canonicalJson(deletion.signed({ campaignRootSha256:
    admitted.rootBindingSha256, protectedOriginals, releaseRootSha256,
  schemaVersion: "meeting_knowledge.semantic_quality_campaign_target_inventory.v2", targets })));

  const custodyInventoryPath = join(root, "authoritative-custody.json");
  const mainLocators = [digest("main-locator")];
  const mainTuningEvidence = [digest("main-tuning")];
  await writeFile(custodyInventoryPath, canonicalJson(custody.signed({ loadedLocatorDigests:
    mainLocators, loadedQuestionDigests: allQuestions.map(({ questionDigestSha256 }) =>
      questionDigestSha256), mainInputRootSha256: admitted.rootBindingSha256,
  mainKeyNamespace: "main:structural", protectedEvidence, releaseRootSha256,
  schemaVersion: "meeting_knowledge.semantic_quality_authoritative_custody.v2",
  tuningEvidenceDigests: mainTuningEvidence })));

  const holdoutQuestions = questions(30, "independent_review", "h");
  const holdoutTuningEvidence = [digest("holdout-tuning")];
  const holdoutLocatorDigests = [digest("holdout-locator")];
  const mainProof = mainProofAuthority.signed({ loadedLocatorDigests: mainLocators,
    loadedQuestionDigests: allQuestions.map(({ questionDigestSha256 }) => questionDigestSha256),
    mainInputRootSha256: admitted.rootBindingSha256, mainReleaseRootSha256: releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_main_input_proof.v1",
    tuningCorpusSha256: sha256(mainTuningEvidence) });
  const questionReceipt = holdoutQuestion.signed({ mainInputRootSha256: admitted.rootBindingSha256,
    mainReleaseRootSha256: releaseRootSha256, questionSetSha256: sha256(holdoutQuestions),
    questions: holdoutQuestions,
    schemaVersion: "meeting_knowledge.semantic_quality_holdout_questions.v1" });
  const holdoutRootSha256 = sha256({ holdoutLocatorSetSha256: sha256(holdoutLocatorDigests),
    holdoutQuestionSetSha256: sha256(holdoutQuestions), mainInputRootSha256:
    admitted.rootBindingSha256, mainReleaseRootSha256: releaseRootSha256,
    questionReceiptSha256: sha256(questionReceipt),
    schemaVersion: "meeting_knowledge.semantic_quality_holdout_root.v1" });
  const holdoutAuthorizedLocatorIds = holdoutQuestions.map(({ questionId }) =>
    digest(`locator:${questionId}`));
  const holdoutGoldEntries = holdoutQuestions.map((question) => ({ ...question,
    campaignRootSha256: holdoutRootSha256, expectedAbstention:
    Number(question.questionId.split("-").at(-1)) % 10 === 9,
    releaseRootSha256, relevantLocatorIds:
    Number(question.questionId.split("-").at(-1)) % 10 === 9 ? [] :
      [digest(`locator:${question.questionId}`)] }));
  const holdoutForbiddenEntries = holdoutQuestions.map((question) => ({
    campaignRootSha256: holdoutRootSha256,
    forbiddenLocatorIds: [digest(`forbidden:${question.questionId}`)],
    questionDigestSha256: question.questionDigestSha256, questionId: question.questionId,
    releaseRootSha256 }));
  const holdoutGoldRelevanceReceipt = goldRelevance.signed({ campaignRootSha256:
    holdoutRootSha256, entries: holdoutGoldEntries, releaseRootSha256,
  schemaVersion: "meeting_knowledge.semantic_quality_gold_relevance.v1" });
  const holdoutForbiddenLocatorReceipt = locator.signed({ campaignRootSha256:
    holdoutRootSha256, entries: holdoutForbiddenEntries, releaseRootSha256,
  schemaVersion: "meeting_knowledge.semantic_quality_forbidden_locators.v1" });
  const holdoutLocatorInventoryReceipt = locator.signed({ campaignRootSha256:
    holdoutRootSha256, locatorIds: holdoutAuthorizedLocatorIds, releaseRootSha256,
  schemaVersion: "meeting_knowledge.semantic_quality_locator_inventory.v1" });
  const holdoutSpendDocuments = ([1, 2, 3] as const).map((repetition) => spend.signed({
    allowedCallKinds: ["answer", "capability", "retrieval"], campaignRootSha256:
    holdoutRootSha256, expiresAtEpochMs: 4_000_000_000_000, maxCalls: 270,
    maxEncryptedBytes: 100_000_000, maxCallsByKind: { adjudicator_1: 0, adjudicator_2: 0,
      answer: 90, capability: 90, resolver: 0, retrieval: 90 }, maximumEffectDurationMs: 120_000,
    maxTokens: 1_000_000, ...FROZEN_ANSWER_EXECUTION, provider: "structural-provider",
    releaseRootSha256, repetition }));
  const holdoutTargets = [{ artifactId: "holdout-index", kind: "derived_index" },
    { artifactId: "holdout-prompt", kind: "temporary_prompt" }] as const;
  const holdoutTargetInventoryReceipt = deletion.signed({ campaignRootSha256: holdoutRootSha256,
    protectedOriginals, releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_campaign_target_inventory.v1",
    targets: holdoutTargets });
  const holdoutSpendDigests = holdoutSpendDocuments.map(sha256);
  const holdoutAuthorization = { derivedArtifactInventorySha256:
    sha256(holdoutTargetInventoryReceipt), forbiddenLocatorReceiptSha256:
    sha256(holdoutForbiddenLocatorReceipt), goldRelevanceReceiptSha256:
    sha256(holdoutGoldRelevanceReceipt), holdoutLocatorSetSha256: sha256(holdoutLocatorDigests),
    holdoutQuestionSetSha256: sha256(holdoutQuestions), holdoutRootSha256,
    keyNamespace: `holdout:${holdoutRootSha256}`,
    locatorInventoryReceiptSha256: sha256(holdoutLocatorInventoryReceipt),
    mainInputRootSha256: admitted.rootBindingSha256, mainReleaseRootSha256: releaseRootSha256,
    providerInputMaximumBytes: 16_000,
    questionReceiptSha256: sha256(questionReceipt),
    releaseExecutionBindingSha256: holdoutReleaseExecutionBindingSha256(release),
    schemaVersion: "meeting_knowledge.semantic_quality_holdout_authorization.v3",
    spendReservationSetSha256: sha256(holdoutSpendDigests) };
  const holdoutAuthorizationPath = join(root, "holdout-authorization.json");
  const holdoutQuestionsPath = join(root, "holdout-questions.json");
  const holdoutLocatorsPath = join(root, "holdout-locators.json");
  const holdoutTuningPath = join(root, "holdout-tuning.json");
  const mainProofPath = join(root, "holdout-main-proof.json");
  const questionReceiptPath = join(root, "holdout-question-receipt.json");
  const holdoutSpendPath = join(root, "holdout-spend.json");
  const holdoutForbiddenPath = join(root, "holdout-forbidden.json");
  const holdoutGoldPath = join(root, "holdout-gold.json");
  const holdoutLocatorInventoryPath = join(root, "holdout-locator-inventory.json");
  await writeFile(holdoutAuthorizationPath,
    canonicalJson(holdoutAuthority.signed(holdoutAuthorization)));
  await writeFile(holdoutQuestionsPath, canonicalJson(holdoutQuestions));
  await writeFile(holdoutLocatorsPath, canonicalJson(holdoutLocatorDigests));
  await writeFile(holdoutTuningPath, canonicalJson(holdoutTuningEvidence));
  await writeFile(mainProofPath, canonicalJson(mainProof));
  await writeFile(questionReceiptPath, canonicalJson(questionReceipt));
  await writeFile(holdoutSpendPath, canonicalJson(holdoutSpendDocuments));
  await writeFile(holdoutForbiddenPath, canonicalJson(holdoutForbiddenLocatorReceipt));
  await writeFile(holdoutGoldPath, canonicalJson(holdoutGoldRelevanceReceipt));
  await writeFile(holdoutLocatorInventoryPath, canonicalJson(holdoutLocatorInventoryReceipt));
  const holdoutCleanupPlanPath = join(root, "holdout-cleanup-plan.json");
  await writeFile(holdoutCleanupPlanPath, canonicalJson(holdoutTargetInventoryReceipt));
  const holdoutInputPath = join(root, "holdout-input.json");
  await writeFile(holdoutInputPath, canonicalJson({ authorizationReceiptPath:
    holdoutAuthorizationPath, derivedArtifactInventoryPath: holdoutCleanupPlanPath,
    forbiddenLocatorReceiptPath: holdoutForbiddenPath,
    goldRelevanceReceiptPath: holdoutGoldPath, locatorDigestsPath: holdoutLocatorsPath,
    locatorInventoryReceiptPath: holdoutLocatorInventoryPath,
    mainProofAuthorityPath: authorityPaths.mainProofAuthority, mainProofReceiptPath: mainProofPath,
    questionAuthorityPath: authorityPaths.holdoutQuestion, questionReceiptPath,
    questionsPath: holdoutQuestionsPath, schemaVersion:
    "meeting_knowledge.semantic_quality_holdout_input.v4",
    spendAuthorityPath: authorityPaths.spend, spendReservationPath: holdoutSpendPath,
    tuningEvidenceDigestsPath: holdoutTuningPath }));
  const configPath = join(root, "operator.json");
  await writeFile(configPath, canonicalJson({ absenceAuthorityPath: authorityPaths.absence,
    adjudicationAuthorityPaths: [authorityPaths.judge1, authorityPaths.judge2,
      authorityPaths.resolver], admissionAuthorityPath: authorityPaths.custody,
    authoritativeEvidenceInventoryPath: custodyInventoryPath, authorityPolicyPath,
    checkpointRoot: join(root, "checkpoints"), cleanupPlanPath, concurrency: 8,
    deletionAuthorityPath: authorityPaths.deletion,
    holdoutAuthorityPath: authorityPaths.holdoutAuthority, holdoutCleanupPlanPath, holdoutInputPath,
    holdoutJournalRoot: join(root, "holdout-journal"), journalRoot: join(root, "journal"),
    mainManifestPath: manifestPath, releaseAuthorityPublicKeyPath: releasePublicKeyPath,
    releaseRootPath, repetitionAuthorityPath: authorityPaths.repetitionAuthority,
    reviewerAuthorityPaths: [authorityPaths.reviewer1,
      authorityPaths.reviewer2], schemaVersion:
    "meeting_knowledge.semantic_quality_production_operator.v4",
    spendAuthorityPath: authorityPaths.spend, spendReservationsPath }));
  const connectionsPath = join(root, "unused-connections.json");
  await writeFile(connectionsPath, "{}");
  const phasePath = join(root, "phase.json");
  await writeFile(phasePath, canonicalJson({ payload: { configurationPath: configPath,
    connectionsPath }, schemaVersion: "meeting_knowledge.semantic_quality_production_phase.v1" }));

  const runtime = createRuntimeFixture({ absence, artifactCustody: custody, clock, deletion, holdoutProvider,
    goldRelevance, judge1: reviewer1, judge2: reviewer2, locator, protectedEvidence, protectedOriginals,
    holdoutForbiddenLocatorReceipt, holdoutGoldRelevanceReceipt,
    holdoutLocatorInventoryReceipt, holdoutQuestions, provider, questions: allQuestions,
    release, releaseDocument, releaseRootSha256,
    repetitionAuthority, resolver, reviewer1, reviewer2, spend });
  const { ports } = runtime;
  const cli = async (command: string, statusName: string) =>
    await runQualityCampaignProductionCli({ argv: [command, phasePath, join(root, statusName)],
      ports });
  const writeCustody = async (evidence: readonly unknown[]) => {
    await writeFile(custodyInventoryPath, canonicalJson(custody.signed({ loadedLocatorDigests:
      mainLocators, loadedQuestionDigests: allQuestions.map(({ questionDigestSha256 }) =>
        questionDigestSha256), mainInputRootSha256: admitted.rootBindingSha256,
    mainKeyNamespace: "main:structural", protectedEvidence: evidence, releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_authoritative_custody.v2",
    tuningEvidenceDigests: mainTuningEvidence })));
  };
  const writeHoldoutRoot = async (replacementHoldoutRootSha256: string) => {
    await writeFile(holdoutAuthorizationPath, canonicalJson(holdoutAuthority.signed({
      ...holdoutAuthorization, holdoutRootSha256: replacementHoldoutRootSha256 })));
  };
  const writeCleanupProtectedOriginals = async (replacement: readonly unknown[]) => {
    await writeFile(cleanupPlanPath, canonicalJson(deletion.signed({ campaignRootSha256:
      admitted.rootBindingSha256, protectedOriginals: replacement, releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_campaign_target_inventory.v2", targets })));
  };
  return { cli, clock, deletedIds: runtime.deletedIds,
    get ambiguousNext() {return runtime.ambiguousNext;},
    set ambiguousNext(value: boolean) {runtime.ambiguousNext = value;},
    holdoutCalls: runtime.holdoutCalls, mainCalls: runtime.mainCalls,
    mainRootSha256: admitted.rootBindingSha256,
    get maximumProviderConcurrency() {return runtime.maximumProviderConcurrency;},
    observedIds: runtime.observedIds, protectedOriginals, release, reviewCalls: runtime.reviewCalls,
    root, startedAt, releaseEvidence: runtime.releaseEvidence, writeCleanupProtectedOriginals,
    writeCustody, writeHoldoutRoot };
}

async function writeSpendReservations(path: string, spend: ReturnType<typeof signer>,
  campaignRootSha256: string, releaseRootSha256: string): Promise<void> {
  await writeFile(path, canonicalJson(([1, 2, 3] as const).map((repetition) =>
    spendDocument(spend, campaignRootSha256, releaseRootSha256, repetition))));
}

function spendDocument(spend: ReturnType<typeof signer>, campaignRootSha256: string,
  releaseRootSha256: string, repetition: 1 | 2 | 3) {
  return spend.signed({
    allowedCallKinds: ["answer", "capability", "retrieval", "adjudicator_1", "adjudicator_2",
      "resolver"], campaignRootSha256, expiresAtEpochMs: 4_000_000_000_000, maxCalls: 1_440,
    maxEncryptedBytes: 100_000_000, maxCallsByKind: { adjudicator_1: 240, adjudicator_2: 240,
      answer: 240, capability: 240, resolver: 240, retrieval: 240 }, maximumEffectDurationMs: 120_000,
    maxTokens: 10_000_000, ...FROZEN_ANSWER_EXECUTION, provider: "structural-provider",
    releaseRootSha256, repetition });
}

interface ProviderCall {
  readonly attemptId: string;
  readonly questionId: string;
  readonly request: Record<string, unknown>;
}

interface RuntimeFixtureInput { readonly absence: ReturnType<typeof signer>;
  readonly artifactCustody: ReturnType<typeof signer>;
  readonly clock: QualityCampaignProductionPorts["clock"];
  readonly deletion: ReturnType<typeof signer>; readonly holdoutProvider: ReturnType<typeof signer>;
  readonly judge1: ReturnType<typeof signer>; readonly judge2: ReturnType<typeof signer>;
  readonly locator: ReturnType<typeof signer>;
  readonly goldRelevance: ReturnType<typeof signer>;
  readonly holdoutForbiddenLocatorReceipt: unknown;
  readonly holdoutGoldRelevanceReceipt: unknown;
  readonly holdoutLocatorInventoryReceipt: unknown;
  readonly protectedEvidence: readonly unknown[]; readonly provider: ReturnType<typeof signer>;
  readonly holdoutQuestions: readonly CampaignQuestion[];
  readonly protectedOriginals: readonly { readonly artifactId: string; readonly kind: string }[];
  readonly questions: readonly CampaignQuestion[];
  readonly release: QualityCampaignRelease; readonly releaseDocument: unknown;
  readonly releaseRootSha256: string;
  readonly repetitionAuthority: ReturnType<typeof signer>;
  readonly resolver: ReturnType<typeof signer>; readonly reviewer1: ReturnType<typeof signer>;
  readonly reviewer2: ReturnType<typeof signer>; readonly spend: ReturnType<typeof signer> }

function createRuntimeFixture(input: RuntimeFixtureInput) {
  const mainCalls: ProviderCall[] = []; const holdoutCalls: ProviderCall[] = [];
  const attemptQuestions = new Map<string, string>();
  const attemptRequests = new Map<string, Record<string, unknown>>();
  const requestBytesByAttempt = new Map<string, Uint8Array>();
  const resultBytesByAttempt = new Map<string, Uint8Array>();
  const signedResultByAttempt = new Map<string, unknown>();
  let activeProviderCalls = 0; let maximumProviderConcurrency = 0;
  let ambiguousNext = false;
  const exchange = (collection: ProviderCall[], resultSigner: ReturnType<typeof signer>) =>
    ({ exchange: async (call: { readonly attempt: AttemptIdentity;
      readonly deadlineEpochMs: number; readonly request: Uint8Array;
      readonly requestDigestSha256: string; readonly signal: AbortSignal }) => {
    activeProviderCalls += 1; maximumProviderConcurrency = Math.max(maximumProviderConcurrency,
      activeProviderCalls);
    try {
      await new Promise<void>((resolve) => {setImmediate(resolve);});
      const request = JSON.parse(Buffer.from(call.request).toString("utf8")) as
        Record<string, unknown>;
      const questionId = String(request.questionId);
      collection.push({ attemptId: call.attempt.attemptId, questionId, request });
      attemptQuestions.set(call.attempt.attemptId, questionId);
      attemptRequests.set(call.attempt.attemptId, request);
      requestBytesByAttempt.set(call.attempt.attemptId, call.request);
      if (ambiguousNext) {ambiguousNext = false; return { effect: "unknown" as const };}
      const resultEnvelopeBytes = Buffer.from(canonicalJson({ attemptId: call.attempt.attemptId,
        callKind: call.attempt.callKind, questionId,
        schemaVersion: "meeting_knowledge.semantic_quality_test_provider_result.v2" }));
      const resultDigestSha256 = sha256(resultEnvelopeBytes);
      const signedResult = resultSigner.signed({ ...call.attempt,
        providerAccounting: qualificationProviderAccountingFixture(input.release,
          call.attempt.callKind),
        requestDigestSha256: call.requestDigestSha256, resultDigestSha256,
        schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal_payload.v4",
        state: "terminal_success" });
      resultBytesByAttempt.set(call.attempt.attemptId, resultEnvelopeBytes);
      signedResultByAttempt.set(call.attempt.attemptId, signedResult);
      return { effect: "certain_success" as const, resultDigestSha256,
        resultEnvelopeBytes,
        signedResult };
    } finally {activeProviderCalls -= 1;}
  } });
  const reviewCalls = { first: 0, resolver: 0, second: 0 };
  const adjudicationFor = (attemptId: string): ExactAdjudicationEvidence => {
    const request = attemptRequests.get(attemptId);
    if (request === undefined) {throw new Error("missing exact attempt request");}
    const questionId = String(request.questionId);
    const encryptedEvidenceSha256 = digest(`evidence:${attemptId}`);
    const outcomeDigestSha256 = digest(`outcome:${attemptId}`);
    const base = { attemptId, encryptedEvidenceSha256, firstDecisionDigestSha256: null,
      outcomeDigestSha256, questionId, resolverBindingSha256: null,
      secondDecisionDigestSha256: null };
    const firstDecision = decisionFor(questionId, outcomeDigestSha256, true);
    const secondDecision = decisionFor(questionId, outcomeDigestSha256, questionId !== "a-0");
    const first = input.judge1.signed({ ...base, decision: firstDecision,
      decisionDigestSha256: sha256(firstDecision) });
    const second = input.judge2.signed({ ...base, decision: secondDecision,
      decisionDigestSha256: sha256(secondDecision) });
    const resolverBindingSha256 = sha256({ attemptId, encryptedEvidenceSha256,
      firstDecisionReceipt: first, outcomeDigestSha256, questionId,
      schemaVersion: "meeting_knowledge.semantic_quality_resolver_binding.v1",
      secondDecisionReceipt: second });
    const resolverReceipt = questionId === "a-0" ? input.resolver.signed({ ...base,
      decision: firstDecision, decisionDigestSha256: sha256(firstDecision),
      firstDecisionDigestSha256: sha256(firstDecision), resolverBindingSha256,
      secondDecisionDigestSha256: sha256(secondDecision) }) : null;
    const attempt = attemptIdentity({ callKind: "answer", callOrdinal: 0,
      campaignRootSha256: String(request.campaignRootSha256), questionDigestSha256:
      String(request.questionDigestSha256), questionId, releaseRootSha256:
      String(request.releaseRootSha256), repetition: Number(request.repetition) as 1 | 2 | 3,
      spendReservationSha256: String(request.spendReservationSha256) });
    return { attempt, attemptId, campaignRootSha256: String(request.campaignRootSha256),
      decision: firstDecision, decisionDigestSha256: sha256(firstDecision),
      encryptedEvidenceSha256, firstReceipt: first, outcomeDigestSha256, questionId,
      predecessorPlaintextSha256: digest(`predecessor:${attemptId}`),
      repetition: Number(request.repetition) as 1 | 2 | 3,
      resolverReceipt, schemaVersion:
      "meeting_knowledge.semantic_quality_final_adjudication.v2", secondReceipt: second };
  };
  const outcomesFor = (attemptIds: readonly string[], resultSigner = input.provider): ExactOutcomeEvidence[] =>
    attemptIds.map((attemptId) => exactOutcome(attemptId, { artifactBindingsByAttempt,
      finalAdjudicationByAttempt, requestBytesByAttempt, requests: attemptRequests,
      resultBytesByAttempt, signedResultByAttempt }, resultSigner));
  const artifactKey = Buffer.alloc(32, 7);
  const envelopeByDigest = new Map<string, Uint8Array>();
  const artifactsByAttempt = new Map<string, readonly RetainedArtifact[]>();
  const artifactBindingsByAttempt = new Map<string, Record<string, string>>();
  const finalAdjudicationByAttempt = new Map<string, string>();
  const encodeArtifact = (answer: AttemptIdentity,
    kind: typeof REQUIRED_RETAINED_KINDS[number] | "resolver_result", plaintext: Buffer) => {
    const identity = artifactAttemptIdentity(answer, kind); const keyId =
      answer.questionId.startsWith("h-") ?
        `holdout:${answer.campaignRootSha256}:retention-key` : "retention-key";
    const plaintextSha256 = sha256(plaintext);
    const aad = { artifactKind: kind, attemptId: identity.attemptId,
      callKind: identity.callKind, callOrdinal: identity.callOrdinal,
      campaignRootSha256: identity.campaignRootSha256, keyId, plaintextSha256,
      questionDigestSha256: identity.questionDigestSha256, questionId: identity.questionId,
      releaseRootSha256: identity.releaseRootSha256, repetition: identity.repetition,
      schemaVersion: "meeting_knowledge.semantic_quality_artifact_aad.v3",
      spendReservationSha256: identity.spendReservationSha256 };
    const nonce = Buffer.from(sha256(`${identity.attemptId}:${kind}`), "hex").subarray(0, 12);
    const cipher = createCipheriv("aes-256-gcm", artifactKey, nonce);
    cipher.setAAD(Buffer.from(canonicalJson(aad)));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope = Buffer.from(canonicalJson({ aad, algorithm: "A256GCM",
      ciphertextBase64: ciphertext.toString("base64"), nonceBase64: nonce.toString("base64"),
      tagBase64: cipher.getAuthTag().toString("base64") }));
    return { aad, envelope, identity, keyId, plaintextSha256 };
  };
  const artifactsFor = (attemptIds: readonly string[], resultSigner = input.provider):
  RetainedArtifact[] =>
    attemptIds.flatMap((attemptId) => {
    const cached = artifactsByAttempt.get(attemptId);
    if (cached !== undefined) {return cached;}
    const request = attemptRequests.get(attemptId)!; const adjudication = adjudicationFor(attemptId);
    const answerIdentity = attemptIdentity({ callKind: "answer", callOrdinal: 0,
      campaignRootSha256: String(request.campaignRootSha256),
      questionDigestSha256: String(request.questionDigestSha256),
      questionId: String(request.questionId), releaseRootSha256:
      String(request.releaseRootSha256), repetition: Number(request.repetition) as 1 | 2 | 3,
      spendReservationSha256: String(request.spendReservationSha256) });
    const bindings: Record<string, string> = {};
    const resultSigner = answerIdentity.questionId.startsWith("h-") ? input.holdoutProvider :
      input.provider;
    let predecessorPlaintextSha256: string | null = null;
    const kinds = adjudication.resolverReceipt === null ? REQUIRED_RETAINED_KINDS :
      [...REQUIRED_RETAINED_KINDS.slice(0, -1), "resolver_result" as const,
        "final_adjudication" as const];
    const artifacts = kinds
      .map((kind) => {
        const identity = artifactAttemptIdentity(answerIdentity, kind);
        const providerRequestBytes = Buffer.from(requestBytesByAttempt.get(identity.attemptId) ??
          Buffer.from(canonicalJson(attemptRequests.get(identity.attemptId) ?? {
            callKind: identity.callKind, questionDigestSha256: identity.questionDigestSha256,
            schemaVersion: "meeting_knowledge.semantic_quality_test_provider_request.v1" })));
        const providerResultBytes = Buffer.from(resultBytesByAttempt.get(identity.attemptId) ??
          Buffer.from(canonicalJson({ callKind: identity.callKind,
          questionId: identity.questionId,
          schemaVersion: "meeting_knowledge.semantic_quality_test_provider_result.v1" })));
        const decisionReceipt = kind === "adjudicator_1_result" ? adjudication.firstReceipt :
          kind === "adjudicator_2_result" ? adjudication.secondReceipt :
          kind === "resolver_result" ? adjudication.resolverReceipt : undefined;
        const adjudicationRequest = { attemptId: answerIdentity.attemptId,
          encryptedEvidenceSha256: adjudication.encryptedEvidenceSha256,
          firstDecisionDigestSha256: null, firstDecisionReceipt: null,
          outcomeDigestSha256: adjudication.outcomeDigestSha256,
          questionId: answerIdentity.questionId, resolverBindingSha256: null,
          secondDecisionDigestSha256: null, secondDecisionReceipt: null };
        const resolverRequest = { ...adjudicationRequest,
          firstDecisionDigestSha256: adjudication.firstReceipt.payload.decisionDigestSha256,
          firstDecisionReceipt: adjudication.firstReceipt, resolverBindingSha256:
          adjudication.resolverReceipt?.payload.resolverBindingSha256 ?? null,
          secondDecisionDigestSha256: adjudication.secondReceipt.payload.decisionDigestSha256,
          secondDecisionReceipt: adjudication.secondReceipt };
        const requestDigestSha256 = kind === "adjudicator_1_result" ||
          kind === "adjudicator_2_result" ? sha256(adjudicationRequest) :
          kind === "resolver_result" ? sha256(resolverRequest) :
          ["capability_request", "capability_response", "retrieval_request",
            "retrieval_response", "answer_request", "answer_response", "raw_outcome"]
            .includes(kind) ? sha256(providerRequestBytes) : digest(`request:${identity.attemptId}`);
        const resultDigestSha256 = ["capability_response", "retrieval_response",
          "answer_response", "raw_outcome"].includes(kind) ? sha256(providerResultBytes) :
          decisionReceipt === undefined ? null : sha256(decisionReceipt);
        const terminal = resultDigestSha256 !== null;
        let signedProviderTerminal: unknown = null;
        let signedDurableExchange: unknown = null;
        if (terminal) {
          if (["adjudicator_1_result", "adjudicator_2_result", "resolver_result"].includes(kind)) {
            const effect = reviewerEffect(answerIdentity, kind as "adjudicator_1_result" |
              "adjudicator_2_result" | "resolver_result", requestDigestSha256,
            decisionReceipt, input);
            signedProviderTerminal = effect.signedProviderTerminal;
            signedDurableExchange = effect.signedDurableExchange;
          } else {
            signedProviderTerminal = signedResultByAttempt.get(identity.attemptId) ??
              resultSigner.signed({ ...identity, requestDigestSha256,
                providerAccounting: qualificationProviderAccountingFixture(input.release,
                  identity.callKind),
                resultDigestSha256, schemaVersion:
                "meeting_knowledge.semantic_quality_provider_terminal_payload.v4",
              state: "terminal_success" });
          }
        }
        const chain = { artifactKind: kind, cancellationBoundary: "not_cancelled",
          deadlineEpochMs: terminal ? 11_000 : null, predecessorPlaintextSha256,
          releaseDocumentSha256: sha256(input.releaseDocument), requestDigestSha256,
          resultDigestSha256, signedDurableExchange, signedProviderTerminal,
          spendReservationSha256: identity.spendReservationSha256 };
        const base = { attempt: identity, chain,
          schemaVersion: `meeting_knowledge.semantic_quality_${kind}.v1` };
        const finalValue = { ...retainedFinalAdjudication(adjudication) as Record<string, unknown>,
          predecessorPlaintextSha256 };
        const turnId = `turn-${answerIdentity.repetition}-${answerIdentity.questionId}`;
        const plaintext = kind === "final_adjudication" ? Buffer.from(canonicalJson(finalValue)) :
          kind === "retrieval_response" ? Buffer.from(canonicalJson({ ...base,
            latencyUs: 200_000, rankedLocatorIds: [digest(`locator:${answerIdentity.questionId}`)],
            responseBytesBase64: providerResultBytes.toString("base64"),
            schemaVersion: "meeting_knowledge.semantic_quality_retrieval_evidence.v1",
            scopeViolationLocatorIds: [] })) : kind === "evidence" ? Buffer.from(canonicalJson({
              ...base, evidenceTurnIds: [turnId], schemaVersion:
              "meeting_knowledge.semantic_quality_canonical_evidence.v1",
              speakerTimeChecks: [{ canonicalTurnId: turnId,
                expectedSpeakerId: "speaker-1", expectedStartMs: 1_000,
                observedSpeakerId: "speaker-1", observedStartMs: 1_000, toleranceMs: 0 }] })) :
            kind === "raw_outcome" ? Buffer.from(canonicalJson({ ...base,
              encryptedEvidenceSha256: adjudication.encryptedEvidenceSha256,
              outcomeDigestSha256: adjudication.outcomeDigestSha256,
              responseBytesBase64: providerResultBytes.toString("base64") })) :
            kind === "adjudication_input" ? Buffer.from(canonicalJson({ ...base,
              encryptedEvidenceSha256: adjudication.encryptedEvidenceSha256,
              outcomeDigestSha256: adjudication.outcomeDigestSha256 })) :
            kind === "answer_response" ? Buffer.from(canonicalJson({ ...base,
              answerDigestSha256: resultDigestSha256,
              responseBytesBase64: providerResultBytes.toString("base64") })) :
            ["capability_request", "retrieval_request", "answer_request"].includes(kind) ?
              Buffer.from(canonicalJson({ ...base,
                requestBytesBase64: providerRequestBytes.toString("base64") })) :
            kind === "capability_response" ? Buffer.from(canonicalJson({ ...base,
              responseBytesBase64: providerResultBytes.toString("base64") })) :
            Buffer.from(canonicalJson({ ...base,
              ...(decisionReceipt === undefined ? {} : { decisionReceipt }) }));
        const { aad, envelope, identity: storedIdentity, keyId, plaintextSha256 } =
          encodeArtifact(answerIdentity, kind, plaintext);
        const aadSha256 = sha256(aad); const envelopeSha256 = sha256(envelope);
        const keyBindingSha256 = sha256({ attemptId: storedIdentity.attemptId, keyId, kind,
          questionId: storedIdentity.questionId, repetition: storedIdentity.repetition,
          schemaVersion: "meeting_knowledge.semantic_quality_retained_key_binding.v1" });
        const storedBytes = envelope.byteLength;
        const artifactBindingSha256 = sha256({ aadSha256, attemptId: storedIdentity.attemptId,
          envelopeSha256, keyBindingSha256, keyId, kind, plaintextSha256,
          questionId: storedIdentity.questionId, repetition: storedIdentity.repetition, storedBytes,
          schemaVersion: "meeting_knowledge.semantic_quality_retained_artifact_binding.v1" });
        envelopeByDigest.set(envelopeSha256, envelope);
        bindings[kind] = artifactBindingSha256;
        predecessorPlaintextSha256 = plaintextSha256;
        if (kind === "final_adjudication") {
          finalAdjudicationByAttempt.set(attemptId, plaintextSha256);
        }
        return { aadSha256, artifactBindingSha256, attemptId: storedIdentity.attemptId,
          envelopeSha256, keyBindingSha256, keyId, kind, plaintextSha256,
          questionId: storedIdentity.questionId, repetition: storedIdentity.repetition, storedBytes };
      });
    artifactBindingsByAttempt.set(attemptId, bindings);
    artifactsByAttempt.set(attemptId, artifacts);
    return artifacts;
  });
  const deletedIds: string[] = []; const observedIds: string[] = [];
  const mainExchange = exchange(mainCalls, input.provider);
  const holdoutExchange = exchange(holdoutCalls, input.holdoutProvider);
  const mainEvidence = (attemptIds: readonly string[], evidenceQuestions = input.questions,
    resultSigner = input.provider) => {
    const adjudications = attemptIds.map(adjudicationFor);
    const artifacts = artifactsFor(attemptIds, resultSigner);
    const outcomes = outcomesFor(attemptIds, resultSigner);
    const authorizedLocatorIds = [...new Set(outcomes.flatMap(({ rankedLocatorDigests,
      relevantLocatorDigests }) => [...rankedLocatorDigests, ...relevantLocatorDigests]))].toSorted();
    const spendDigests = ([1, 2, 3] as const).map((repetition) => outcomes.find((outcome) =>
      outcome.repetition === repetition)!.identity.spendReservationSha256) as
      [string, string, string];
    const goldRelevanceEntries = evidenceQuestions.map((question) => {
      const outcome = outcomes.find((candidate) => candidate.questionId === question.questionId)!;
      return { ...question, campaignRootSha256: outcomes[0]!.campaignRootSha256,
        expectedAbstention: outcome.expectedAnswer === "abstain",
        releaseRootSha256: input.releaseRootSha256,
        relevantLocatorIds: outcome.expectedAnswer === "abstain" ? [] :
          outcome.relevantLocatorDigests };
    });
    const goldRelevanceReceipt = input.goldRelevance.signed({ campaignRootSha256:
      outcomes[0]!.campaignRootSha256, entries: goldRelevanceEntries,
      releaseRootSha256: input.releaseRootSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_gold_relevance.v1" });
    const forbiddenLocatorReceipt = input.locator.signed({ campaignRootSha256:
      outcomes[0]!.campaignRootSha256, entries: input.questions.map((question) => ({
        campaignRootSha256: outcomes[0]!.campaignRootSha256,
        forbiddenLocatorIds: [digest(`forbidden:${question.questionId}`)],
        questionDigestSha256: question.questionDigestSha256, questionId: question.questionId,
        releaseRootSha256: input.releaseRootSha256 })), releaseRootSha256:
      input.releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_forbidden_locators.v1" });
    const rootBindingSha256 = sha256({ authorizedLocatorSetSha256: sha256(authorizedLocatorIds),
      campaignRootSha256: outcomes[0]!.campaignRootSha256,
      questionSetSha256: sha256(evidenceQuestions), relevanceAuthoritySha256:
      sha256(goldRelevanceEntries), releaseRootSha256: input.releaseRootSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_final_root_binding.v3",
      spendReservationSetSha256: sha256(spendDigests) });
    const qualification = outcomes.map((outcome): QualificationOutcome => {
      const adjudication = adjudications.find(({ attemptId }) => attemptId === outcome.attemptId)!;
      const question = evidenceQuestions.find(({ questionId }) =>
        questionId === outcome.questionId)!;
      const turnId = `turn-${outcome.repetition}-${outcome.questionId}`;
      return { abstention: { expected: outcome.expectedAnswer === "abstain",
        observed: outcome.answerAbstained }, artifactBindingSha256ByKind:
        outcome.artifactBindingSha256ByKind, campaignRootSha256: outcome.campaignRootSha256,
      citationChecks: adjudication.decision.claims.map(({ citationEntailed, claimId }) =>
        ({ citedTurnId: turnId, claimId, entailed: citationEntailed })),
      claimChecks: adjudication.decision.claims.map(({ claimFactual, claimId, claimSupported }) =>
        ({ claimId, factual: claimFactual, supported: claimSupported })),
      evidenceTurnIds: [turnId],
      finalAdjudicationSha256: outcome.finalAdjudicationSha256, identity: outcome.identity,
      locale: question.locale, rankedLocatorIds: outcome.rankedLocatorDigests,
      relevantLocatorIds: outcome.expectedAnswer === "abstain" ? [] :
        outcome.relevantLocatorDigests, repetition: outcome.repetition,
      resolverRequired: adjudication.resolverReceipt !== null, retrievalLatencyUs:
      outcome.retrievalLatencyUs, rootBindingSha256,
      scopeViolationLocatorIds: outcome.scopeViolationLocatorIds,
      source: question.source, speakerTimeChecks:
        [{ canonicalTurnId: turnId, expectedSpeakerId: "speaker-1", expectedStartMs: 1_000,
          observedSpeakerId: "speaker-1", observedStartMs: 1_000, toleranceMs: 0 }],
      terminalChain: outcome.terminalChain,
      };
    });
    const repetitionEvidence = ([1, 2, 3] as const).map((repetition) => {
      const selected = qualification.filter((outcome) => outcome.repetition === repetition);
      const metrics = reconstructMetrics(selected);
      return input.repetitionAuthority.signed({ campaignRootSha256:
        outcomes[0]!.campaignRootSha256, metrics, metricsSha256: sha256(metrics),
      outcomes: selected, outcomesSha256: sha256(selected), releaseRootSha256:
        input.releaseRootSha256, repetition, rootBindingSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_repetition_evidence.v3",
      spendReservationSha256: spendDigests[repetition - 1], thresholdsPassed: true });
    });
    const authorizedLocatorInventory = input.locator.signed({ campaignRootSha256:
      outcomes[0]!.campaignRootSha256, locatorIds: authorizedLocatorIds,
      releaseRootSha256: input.releaseRootSha256, schemaVersion:
      "meeting_knowledge.semantic_quality_locator_inventory.v1" });
    const reviewedQuestions = { campaignRootSha256: outcomes[0]!.campaignRootSha256,
      goldRelevanceReceiptSha256: sha256(goldRelevanceReceipt), questions: evidenceQuestions,
      releaseRootSha256: input.releaseRootSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_reviewed_main_questions.v2" } as const;
    return { adjudications, artifacts, authorizedLocatorIds, authorizedLocatorInventory,
      campaignByteCeiling: 100_000_000, finalRootBindingSha256: rootBindingSha256,
      forbiddenLocatorReceipt, goldRelevanceReceipt, outcomes, questionReviewReceipts:
      [input.reviewer1.signed(reviewedQuestions), input.reviewer2.signed(reviewedQuestions)] as const,
      repetitionEvidence };
  };
  const ports: QualityCampaignProductionPorts = {
    absence: { authorityId: input.absence.keyId,
      observe: async ({ campaignRootSha256, cleanupManifestSha256, targetArtifactIds }) => {
      observedIds.push(...targetArtifactIds);
      return input.absence.signed({ absentArtifactIds: [...targetArtifactIds].toSorted(),
        absentArtifactIdsSha256: sha256([...targetArtifactIds].toSorted()),
        campaignRootSha256, cleanupManifestSha256, presentProtectedOriginals:
          input.protectedOriginals.toSorted((left, right) => left.kind.localeCompare(right.kind)),
        presentProtectedOriginalsSha256: sha256(input.protectedOriginals
          .toSorted((left, right) => left.kind.localeCompare(right.kind))), releaseRootSha256:
          input.releaseRootSha256,
        schemaVersion: "meeting_knowledge.semantic_quality_cleanup_absence.v5" });
    } }, artifactCustody: { loadKey: async ({ keyId }) => keyId.endsWith("retention-key") ? {
      authorityKeyId: input.artifactCustody.keyId,
      authorityPublicKeyFingerprintSha256: input.release.artifactKeyCustodySha256,
      key: artifactKey, keyCustodySha256: input.release.artifactKeyCustodySha256 } : null,
    readEnvelope: async ({ envelopeSha256 }) => envelopeByDigest.get(envelopeSha256) ?? null },
    clock: input.clock,
    deletion: { authorityId: input.deletion.keyId, deleteDerived: async ({ targets }) => {
      deletedIds.push(...targets.map(({ artifactId }) => artifactId));
      return targets.map(({ artifactId }) => ({ artifactId, outcome: "deleted" as const }));
    } }, evidence: { holdout: async () => ({ envelopeBytes: Buffer.from("holdout"),
      signedReceipt: {} }), main: async () => ({ envelopeBytes: Buffer.from("main"),
      signedReceipt: {} }) }, evidenceCustody: { open: async ({ attemptIds, kind }) => kind ===
      "main" ? mainEvidence(attemptIds) : (() => {const artifacts = artifactsFor(attemptIds);
        const outcomes = outcomesFor(attemptIds, input.holdoutProvider); return {
        adjudications: attemptIds.map(adjudicationFor), artifacts, authorizedLocatorIds:
        (input.holdoutLocatorInventoryReceipt as { payload: { locatorIds: string[] } }).payload.locatorIds,
        authorizedLocatorInventory: input.holdoutLocatorInventoryReceipt,
        campaignByteCeiling: 100_000_000, finalRootBindingSha256: digest("holdout-final-root"),
        forbiddenLocatorReceipt: input.holdoutForbiddenLocatorReceipt,
        goldRelevanceReceipt: input.holdoutGoldRelevanceReceipt, outcomes,
        questionReviewReceipts: [{}, {}], repetitionEvidence: [] };})() },
    holdoutProvider: { answer: holdoutExchange, capability: holdoutExchange,
      resultAuthority: input.holdoutProvider, retrieval: holdoutExchange },
    mainProvider: { answer: mainExchange, capability: mainExchange,
      resultAuthority: input.provider, retrieval: mainExchange },
    release: { observe: async () => input.release }, review: {
      receipts: async (attemptId) => {const evidence = adjudicationFor(attemptId);
        reviewCalls.first += 1; reviewCalls.second += 1;
        if (evidence.resolverReceipt !== null) {reviewCalls.resolver += 1;}
        const baseRequest = { attemptId: evidence.attemptId,
          encryptedEvidenceSha256: evidence.encryptedEvidenceSha256,
          firstDecisionDigestSha256: null, firstDecisionReceipt: null,
          outcomeDigestSha256: evidence.outcomeDigestSha256, questionId: evidence.questionId,
          resolverBindingSha256: null, secondDecisionDigestSha256: null,
          secondDecisionReceipt: null };
        const firstEffectEvidence = reviewerEffect(evidence.attempt, "adjudicator_1_result",
          sha256(baseRequest), evidence.firstReceipt, input);
        const secondEffectEvidence = reviewerEffect(evidence.attempt, "adjudicator_2_result",
          sha256(baseRequest), evidence.secondReceipt, input);
        const resolverRequest = evidence.resolverReceipt === null ? null : { ...baseRequest,
          firstDecisionDigestSha256: evidence.firstReceipt.payload.decisionDigestSha256,
          firstDecisionReceipt: evidence.firstReceipt, resolverBindingSha256:
          evidence.resolverReceipt.payload.resolverBindingSha256,
          secondDecisionDigestSha256: evidence.secondReceipt.payload.decisionDigestSha256,
          secondDecisionReceipt: evidence.secondReceipt };
        return { firstEffectEvidence, firstReceipt: evidence.firstReceipt,
          predecessorPlaintextSha256: evidence.predecessorPlaintextSha256,
          rawOutcomeEnvelopeSha256: digest(`envelope:${attemptId}`),
          resolverEffectEvidence: resolverRequest === null ? null : reviewerEffect(evidence.attempt,
            "resolver_result", sha256(resolverRequest), evidence.resolverReceipt, input),
          resolverReceipt: evidence.resolverReceipt, secondEffectEvidence,
          secondReceipt: evidence.secondReceipt };},
      vault: { reconstruct: async ({ attempt }) => ({ encryptedEvidenceSha256:
        digest(`evidence:${attempt.attemptId}`), outcomeDigestSha256:
        digest(`outcome:${attempt.attemptId}`) }) } },
  };
  return { get ambiguousNext() {return ambiguousNext;},
    set ambiguousNext(value: boolean) {ambiguousNext = value;}, deletedIds,
    holdoutCalls, mainCalls,
    get maximumProviderConcurrency() {return maximumProviderConcurrency;}, observedIds, ports,
    releaseEvidence() {artifactsByAttempt.clear(); artifactBindingsByAttempt.clear();
      envelopeByDigest.clear(); finalAdjudicationByAttempt.clear();}, reviewCalls };
}

function reviewerEffect(answer: AttemptIdentity,
  kind: "adjudicator_1_result" | "adjudicator_2_result" | "resolver_result",
  requestDigestSha256: string, result: unknown, input: RuntimeFixtureInput) {
  const attempt = artifactAttemptIdentity(answer, kind);
  const resultDigestSha256 = sha256(result);
  const signedProviderTerminal = input.provider.signed({ ...attempt, requestDigestSha256,
    providerAccounting: qualificationProviderAccountingFixture(input.release, attempt.callKind),
    resultDigestSha256, schemaVersion:
    "meeting_knowledge.semantic_quality_provider_terminal_payload.v4",
  state: "terminal_success" });
  const budgetClaim = { admissionId: `admission-${attempt.attemptId}`,
    attemptId: attempt.attemptId, callKind: attempt.callKind,
    campaignRootSha256: attempt.campaignRootSha256, repetition: attempt.repetition,
    requestedEncryptedBytes: 4_096, requestedTokens: 64, requestDigestSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_budget_claim.v1",
    spendReservationSha256: attempt.spendReservationSha256 };
  const reservation = { ...attempt, requestDigestSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_provider_reservation.v3",
    state: "provider_reserved" };
  const terminalRecord = { attemptId: attempt.attemptId,
    binding: signedProviderTerminal.payload, reservationSha256: sha256(reservation),
    schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal.v4",
    signedResult: signedProviderTerminal, state: "terminal_success" };
  const signedDurableExchange = input.provider.signed({ budgetClaim,
    budgetClaimSha256: sha256(budgetClaim), cancellationBoundary: "not_cancelled",
    deadlineEpochMs: 11_000, effectState: "certain_success",
    journalReconciliationState: "terminal_success",
    releaseDocumentSha256: sha256(input.releaseDocument), reservation,
    reservationSha256: sha256(reservation), resultDigestSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_durable_exchange_attestation.v1",
    signedProviderTerminalSha256: sha256(signedProviderTerminal),
    terminalRecordSha256: sha256(terminalRecord) });
  return { attempt, cancellationBoundary: "not_cancelled" as const, deadlineEpochMs: 11_000,
    requestDigestSha256, resultDigestSha256, signedDurableExchange, signedProviderTerminal };
}

function retainedFinalAdjudication(value: unknown): unknown {
  const record = value as Record<string, unknown>;
  return Object.fromEntries(["attempt", "decision", "decisionDigestSha256",
    "encryptedEvidenceSha256", "firstReceipt", "outcomeDigestSha256", "resolverReceipt",
    "schemaVersion", "secondReceipt"].map((key) => [key, record[key]]));
}

function exactOutcome(attemptId: string, source: {
  readonly artifactBindingsByAttempt: ReadonlyMap<string, Record<string, string>>;
  readonly finalAdjudicationByAttempt: ReadonlyMap<string, string>;
  readonly requestBytesByAttempt: ReadonlyMap<string, Uint8Array>;
  readonly requests: ReadonlyMap<string, Record<string, unknown>>;
  readonly resultBytesByAttempt: ReadonlyMap<string, Uint8Array>;
  readonly signedResultByAttempt: ReadonlyMap<string, unknown> },
  provider: ReturnType<typeof signer>): ExactOutcomeEvidence {
  const request = source.requests.get(attemptId);
  if (request === undefined) {throw new Error("missing exact outcome request");}
  const questionId = String(request.questionId);
  const isAbstention = Number(questionId.split("-").at(-1)) % 10 === 9;
  const locator = digest(`locator:${questionId}`);
  const repetition = Number(request.repetition) as 1 | 2 | 3;
  const identity = attemptIdentity({ callKind: "answer", callOrdinal: 0,
    campaignRootSha256: String(request.campaignRootSha256),
    questionDigestSha256: String(request.questionDigestSha256), questionId,
    releaseRootSha256: String(request.releaseRootSha256), repetition,
    spendReservationSha256: String(request.spendReservationSha256) });
  const artifactBindingSha256ByKind = source.artifactBindingsByAttempt.get(attemptId) ?? {};
  let predecessorResultDigestSha256: string | null = null;
  const terminalChain = (["capability", "retrieval", "answer"] as const).map((callKind) => {
    const callIdentity = attemptIdentity({ callKind, callOrdinal: 0,
      campaignRootSha256: identity.campaignRootSha256, questionDigestSha256:
      identity.questionDigestSha256, questionId, releaseRootSha256: identity.releaseRootSha256,
      repetition, spendReservationSha256: identity.spendReservationSha256 });
    const requestBytes = source.requestBytesByAttempt.get(callIdentity.attemptId);
    const resultBytes = source.resultBytesByAttempt.get(callIdentity.attemptId);
    if (requestBytes === undefined || resultBytes === undefined) {
      throw new Error("missing scheduler-produced exact bytes");
    }
    const requestDigestSha256 = sha256(requestBytes);
    const resultEnvelopeDigestSha256 = sha256(resultBytes);
    const signedResult = source.signedResultByAttempt.get(callIdentity.attemptId) ??
      provider.signed({ ...callIdentity,
        providerAccounting: qualificationProviderAccountingFixture(
          request.release as QualityCampaignRelease, callIdentity.callKind), requestDigestSha256,
        resultDigestSha256: resultEnvelopeDigestSha256, schemaVersion:
        "meeting_knowledge.semantic_quality_provider_terminal_payload.v4",
        state: "terminal_success" as const });
    const terminal = { attemptId: callIdentity.attemptId, callKind, callOrdinal: 0,
      predecessorResultDigestSha256, requestDigestSha256, resultEnvelopeDigestSha256,
      signedResult, terminalDigestSha256: sha256(signedResult) };
    predecessorResultDigestSha256 = resultEnvelopeDigestSha256;
    return terminal;
  });
  return { answerAbstained: isAbstention, artifactBindingSha256ByKind, attemptId,
    campaignRootSha256: String(request.campaignRootSha256),
    citationLocatorDigests: isAbstention ? [] : [locator],
    evidenceLocatorDigests: isAbstention ? [] : [locator],
    evidenceTurnIds: [`turn-${repetition}-${questionId}`],
    expectedAnswer: isAbstention ? "abstain" : "answerable",
    finalAdjudicationSha256: source.finalAdjudicationByAttempt.get(attemptId) ??
      digest(`${attemptId}:final-adjudication`), identity,
    forbiddenLocatorDigests: [digest(`forbidden:${questionId}`)],
    questionDigestSha256: String(request.questionDigestSha256), questionId,
    rankedLocatorDigests: [locator],
    relevantLocatorDigests: isAbstention ? [] : [locator],
    repetition, retrievalLatencyUs: 200_000, scopeViolationLocatorIds: [],
    speakerTimeChecks: [{ canonicalTurnId: `turn-${repetition}-${questionId}`,
      expectedSpeakerId: "speaker-1", expectedStartMs: 1_000, observedSpeakerId: "speaker-1",
      observedStartMs: 1_000, toleranceMs: 0 }], terminalChain };
}

async function writeAuthority(root: string, name: string, authority: {
  readonly keyId: string; readonly publicKeyPem: string }): Promise<string> {
  const publicKeyPath = join(root, `${name}.pem`);
  await writeFile(publicKeyPath, authority.publicKeyPem);
  const path = join(root, `${name}-authority.json`);
  await writeFile(path, canonicalJson({ keyId: authority.keyId, publicKeyPath }));
  return path;
}
