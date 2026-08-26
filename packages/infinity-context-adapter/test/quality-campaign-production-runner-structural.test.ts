import { createCipheriv, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FROZEN_ANSWER_EXECUTION,
  REQUIRED_RETAINED_KINDS,
  admitMainCampaign,
  artifactAttemptIdentity,
  attemptIdentity,
  canonicalJson,
  publicKeyFingerprintSha256,
  reconstructMetrics,
  runQualityCampaignProductionCli,
  sha256,
  verifyReleaseRoot,
  type AdjudicationRequest,
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
    expect(await fixture.cli("cleanup-absence", "cleanup-status.json")).toBe(0);
    expect(fixture.deletedIds.toSorted()).toEqual(["derived-index", "projection", "prompt"]);
    expect(fixture.observedIds.toSorted()).toEqual(fixture.deletedIds.toSorted());

    expect(fixture.holdoutCalls).toHaveLength(0);
    expect(await fixture.cli("holdout-execute", "holdout-execute-status.json")).toBe(20);
    expect(fixture.holdoutCalls).toHaveLength(30 * 3);
    expect(new Set(fixture.holdoutCalls.map(({ questionId }) => questionId)).size).toBe(30);
    expect(fixture.mainCalls.some(({ questionId }) => questionId.startsWith("h-"))).toBe(false);
    expect(await fixture.cli("holdout-adjudicate", "holdout-adjudicate-status.json")).toBe(20);
    expect(await fixture.cli("holdout-cleanup", "holdout-cleanup-status.json")).toBe(0);
    expect(await fixture.cli("holdout-status", "holdout-status.json")).toBe(0);

    for (const statusName of ["execute-status.json", "adjudicate-status.json",
      "retention-status.json", "cleanup-status.json", "holdout-execute-status.json",
      "holdout-adjudicate-status.json", "holdout-cleanup-status.json", "holdout-status.json"]) {
      const status = await readFile(join(fixture.root, statusName), "utf8");
      expect(status).not.toMatch(/question|rubric|transcript|credential|secret|answer text/iu);
    }
    fixture.releaseEvidence();
  }, 180_000);

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
  const deletion = signer("deletion");
  const reviewer1 = signer("reviewer-1"); const reviewer2 = signer("reviewer-2");
  const judge1 = signer("judge-1"); const judge2 = signer("judge-2");
  const resolver = signer("resolver"); const provider = signer("provider-results");
  const holdoutProvider = signer("holdout-provider-results");
  const releaseAuthority = signer("release"); const spend = signer("spend");
  const repetitionAuthority = signer("repetition-evidence");
  const holdoutAuthority = signer("holdout-custody");
  const release: QualityCampaignRelease = {
    answerImageSha256: digest("answer-image"), answerProcessIdentitySha256: digest("answer-process"),
    answerReleaseSha256: digest("answer-release"), artifactKeyCustodySha256:
    digest("artifact-key-custody"), discordCommitSha256: digest("discord-commit"),
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
  const releaseRootSha256 = verifyReleaseRoot({ authorityKeyId: releaseAuthority.keyId,
    authorityPublicKeyPem:
    releaseAuthority.publicKeyPem, document: releaseDocument }).releaseRootSha256;
  const authorities = { absence, custody, deletion, holdoutAuthority, judge1, judge2, resolver,
    repetitionAuthority, reviewer1, reviewer2, spend };
  const authorityPaths = Object.fromEntries(await Promise.all(Object.entries(authorities).map(
    async ([name, authority]) => [name, await writeAuthority(root, name, authority)] as const)));
  const releasePublicKeyPath = join(root, "release.pem");
  await writeFile(releasePublicKeyPath, releaseAuthority.publicKeyPem);
  const releaseRootPath = join(root, "release.json");
  await writeFile(releaseRootPath, canonicalJson(releaseDocument));

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
  const admitted = await admitMainCampaign({ authority: custody, manifestPath, releaseRootSha256,
    reviewerAuthorities: [reviewer1, reviewer2] });

  const spendReservationsPath = join(root, "spend.json");
  await writeFile(spendReservationsPath, canonicalJson(([1, 2, 3] as const).map((repetition) =>
    spend.signed({ campaignRootSha256: admitted.rootBindingSha256,
      allowedCallKinds: ["answer", "capability", "retrieval", "adjudicator_1",
        "adjudicator_2", "resolver"],
      expiresAtEpochMs: 4_000_000_000_000, maxCalls: 720, maxEncryptedBytes: 100_000_000,
      maxTokens: 10_000_000, ...FROZEN_ANSWER_EXECUTION, provider: "structural-provider",
      releaseRootSha256, repetition }))));
  const protectedEvidence = ["original_craig_recording", "final_transcript", "meeting_database",
    "frozen_snapshot", "frozen_signed_root"].map((kind) => ({ artifactSha256: digest(kind), kind }));
  const targets = [{ artifactId: "derived-index", kind: "derived_index" },
    { artifactId: "prompt", kind: "temporary_prompt" },
    { artifactId: "projection", kind: "temporary_projection" }] as const;
  const cleanupPlanPath = join(root, "cleanup-plan.json");
  const protectedOriginals = ["authoritative_transcript", "final_transcript", "meeting_database",
    "original_craig_recording", "summary"].map((kind) => ({ artifactId: `protected-${kind}`, kind }));
  await writeFile(cleanupPlanPath, canonicalJson(deletion.signed({ campaignRootSha256:
    admitted.rootBindingSha256, protectedOriginals, releaseRootSha256,
  schemaVersion: "meeting_knowledge.semantic_quality_campaign_target_inventory.v1", targets })));

  const custodyInventoryPath = join(root, "authoritative-custody.json");
  const mainLocators = [digest("main-locator")];
  const mainTuningEvidence = [digest("main-tuning")];
  await writeFile(custodyInventoryPath, canonicalJson(custody.signed({ loadedLocatorDigests:
    mainLocators, loadedQuestionDigests: allQuestions.map(({ questionDigestSha256 }) =>
      questionDigestSha256), mainInputRootSha256: admitted.rootBindingSha256,
  mainKeyNamespace: "main:structural", protectedEvidence, releaseRootSha256,
  schemaVersion: "meeting_knowledge.semantic_quality_authoritative_custody.v1",
  tuningEvidenceDigests: mainTuningEvidence })));

  const holdoutQuestions = questions(30, "independent_review", "h");
  const holdoutTuningEvidence = [digest("holdout-tuning")];
  const holdoutLocatorDigests = [digest("holdout-locator")];
  const mainProof = reviewer1.signed({ loadedLocatorDigests: mainLocators,
    loadedQuestionDigests: allQuestions.map(({ questionDigestSha256 }) => questionDigestSha256),
    mainInputRootSha256: admitted.rootBindingSha256, mainReleaseRootSha256: releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_main_input_proof.v1",
    tuningCorpusSha256: sha256(mainTuningEvidence) });
  const questionReceipt = reviewer2.signed({ mainInputRootSha256: admitted.rootBindingSha256,
    mainReleaseRootSha256: releaseRootSha256, questionSetSha256: sha256(holdoutQuestions),
    questions: holdoutQuestions,
    schemaVersion: "meeting_knowledge.semantic_quality_holdout_questions.v1" });
  const holdoutRootSha256 = sha256({ holdoutLocatorSetSha256: sha256(holdoutLocatorDigests),
    holdoutQuestionSetSha256: sha256(holdoutQuestions), mainInputRootSha256:
    admitted.rootBindingSha256, mainReleaseRootSha256: releaseRootSha256,
    questionReceiptSha256: sha256(questionReceipt),
    schemaVersion: "meeting_knowledge.semantic_quality_holdout_root.v1" });
  const holdoutAuthorization = { holdoutLocatorSetSha256: sha256(holdoutLocatorDigests),
    holdoutQuestionSetSha256: sha256(holdoutQuestions), holdoutRootSha256,
    keyNamespace: `holdout:${holdoutRootSha256}`,
    mainInputRootSha256: admitted.rootBindingSha256, mainReleaseRootSha256: releaseRootSha256,
    questionReceiptSha256: sha256(questionReceipt),
    schemaVersion: "meeting_knowledge.semantic_quality_holdout_authorization.v2" };
  const holdoutAuthorizationPath = join(root, "holdout-authorization.json");
  const holdoutQuestionsPath = join(root, "holdout-questions.json");
  const holdoutLocatorsPath = join(root, "holdout-locators.json");
  const holdoutTuningPath = join(root, "holdout-tuning.json");
  const mainProofPath = join(root, "holdout-main-proof.json");
  const questionReceiptPath = join(root, "holdout-question-receipt.json");
  const holdoutSpendPath = join(root, "holdout-spend.json");
  await writeFile(holdoutAuthorizationPath,
    canonicalJson(holdoutAuthority.signed(holdoutAuthorization)));
  await writeFile(holdoutQuestionsPath, canonicalJson(holdoutQuestions));
  await writeFile(holdoutLocatorsPath, canonicalJson(holdoutLocatorDigests));
  await writeFile(holdoutTuningPath, canonicalJson(holdoutTuningEvidence));
  await writeFile(mainProofPath, canonicalJson(mainProof));
  await writeFile(questionReceiptPath, canonicalJson(questionReceipt));
  await writeFile(holdoutSpendPath, canonicalJson(spend.signed({ allowedCallKinds:
    ["answer", "capability", "retrieval"], campaignRootSha256: holdoutRootSha256,
  expiresAtEpochMs: 4_000_000_000_000, maxCalls: 90, maxEncryptedBytes: 100_000_000,
  maxTokens: 1_000_000, ...FROZEN_ANSWER_EXECUTION, provider: "structural-provider",
  releaseRootSha256, repetition: 1 })));
  const holdoutInputPath = join(root, "holdout-input.json");
  await writeFile(holdoutInputPath, canonicalJson({ authorizationReceiptPath:
    holdoutAuthorizationPath, locatorDigestsPath: holdoutLocatorsPath,
    mainProofAuthorityPath: authorityPaths.reviewer1, mainProofReceiptPath: mainProofPath,
    questionAuthorityPath: authorityPaths.reviewer2, questionReceiptPath,
    questionsPath: holdoutQuestionsPath, schemaVersion:
    "meeting_knowledge.semantic_quality_holdout_input.v3",
    spendAuthorityPath: authorityPaths.spend, spendReservationPath: holdoutSpendPath,
    tuningEvidenceDigestsPath: holdoutTuningPath }));
  const holdoutTargets = [{ artifactId: "holdout-index", kind: "derived_index" },
    { artifactId: "holdout-prompt", kind: "temporary_prompt" }] as const;
  const holdoutCleanupPlanPath = join(root, "holdout-cleanup-plan.json");
  await writeFile(holdoutCleanupPlanPath, canonicalJson(deletion.signed({ campaignRootSha256:
    holdoutAuthorization.holdoutRootSha256, protectedOriginals, releaseRootSha256,
  schemaVersion: "meeting_knowledge.semantic_quality_campaign_target_inventory.v1",
  targets: holdoutTargets })));

  const configPath = join(root, "operator.json");
  await writeFile(configPath, canonicalJson({ absenceAuthorityPath: authorityPaths.absence,
    adjudicationAuthorityPaths: [authorityPaths.judge1, authorityPaths.judge2,
      authorityPaths.resolver], admissionAuthorityPath: authorityPaths.custody,
    authoritativeEvidenceInventoryPath: custodyInventoryPath,
    checkpointRoot: join(root, "checkpoints"), cleanupPlanPath, concurrency: 8,
    deletionAuthorityPath: authorityPaths.deletion,
    holdoutAuthorityPath: authorityPaths.holdoutAuthority, holdoutCleanupPlanPath, holdoutInputPath,
    holdoutJournalRoot: join(root, "holdout-journal"), journalRoot: join(root, "journal"),
    mainManifestPath: manifestPath, releaseAuthorityPublicKeyPath: releasePublicKeyPath,
    releaseRootPath, repetitionAuthorityPath: authorityPaths.repetitionAuthority,
    reviewerAuthorityPaths: [authorityPaths.reviewer1,
      authorityPaths.reviewer2], schemaVersion:
    "meeting_knowledge.semantic_quality_production_operator.v2",
    spendAuthorityPath: authorityPaths.spend, spendReservationsPath }));
  const connectionsPath = join(root, "unused-connections.json");
  await writeFile(connectionsPath, "{}");
  const phasePath = join(root, "phase.json");
  await writeFile(phasePath, canonicalJson({ payload: { configurationPath: configPath,
    connectionsPath }, schemaVersion: "meeting_knowledge.semantic_quality_production_phase.v1" }));

  const runtime = createRuntimeFixture({ absence, clock, deletion, holdoutProvider,
    judge1, judge2, protectedEvidence, protectedOriginals, provider, questions: allQuestions, release,
    releaseRootSha256, repetitionAuthority, resolver });
  const { ports } = runtime;
  const cli = async (command: string, statusName: string) =>
    await runQualityCampaignProductionCli({ argv: [command, phasePath, join(root, statusName)],
      ports });
  const writeCustody = async (evidence: readonly unknown[]) => {
    await writeFile(custodyInventoryPath, canonicalJson(custody.signed({ loadedLocatorDigests:
      mainLocators, loadedQuestionDigests: allQuestions.map(({ questionDigestSha256 }) =>
        questionDigestSha256), mainInputRootSha256: admitted.rootBindingSha256,
    mainKeyNamespace: "main:structural", protectedEvidence: evidence, releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_authoritative_custody.v1",
    tuningEvidenceDigests: mainTuningEvidence })));
  };
  const writeHoldoutRoot = async (replacementHoldoutRootSha256: string) => {
    await writeFile(holdoutAuthorizationPath, canonicalJson(holdoutAuthority.signed({
      ...holdoutAuthorization, holdoutRootSha256: replacementHoldoutRootSha256 })));
  };
  return { cli, clock, deletedIds: runtime.deletedIds,
    get ambiguousNext() {return runtime.ambiguousNext;},
    set ambiguousNext(value: boolean) {runtime.ambiguousNext = value;},
    holdoutCalls: runtime.holdoutCalls, mainCalls: runtime.mainCalls,
    mainRootSha256: admitted.rootBindingSha256,
    get maximumProviderConcurrency() {return runtime.maximumProviderConcurrency;},
    observedIds: runtime.observedIds, release, reviewCalls: runtime.reviewCalls, root, startedAt,
    releaseEvidence: runtime.releaseEvidence, writeCustody, writeHoldoutRoot };
}

interface ProviderCall {
  readonly attemptId: string;
  readonly questionId: string;
  readonly request: Record<string, unknown>;
}

function createRuntimeFixture(input: { readonly absence: ReturnType<typeof signer>;
  readonly clock: QualityCampaignProductionPorts["clock"];
  readonly deletion: ReturnType<typeof signer>; readonly holdoutProvider: ReturnType<typeof signer>;
  readonly judge1: ReturnType<typeof signer>; readonly judge2: ReturnType<typeof signer>;
  readonly protectedEvidence: readonly unknown[]; readonly provider: ReturnType<typeof signer>;
  readonly protectedOriginals: readonly { readonly artifactId: string; readonly kind: string }[];
  readonly questions: readonly CampaignQuestion[];
  readonly release: QualityCampaignRelease; readonly releaseRootSha256: string;
  readonly repetitionAuthority: ReturnType<typeof signer>;
  readonly resolver: ReturnType<typeof signer> }) {
  const mainCalls: ProviderCall[] = []; const holdoutCalls: ProviderCall[] = [];
  const attemptQuestions = new Map<string, string>();
  const attemptRequests = new Map<string, Record<string, unknown>>();
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
      if (ambiguousNext) {ambiguousNext = false; return { effect: "unknown" as const };}
      const resultDigestSha256 = digest(call.attempt.attemptId);
      return { effect: "certain_success" as const, resultDigestSha256,
        signedResult: resultSigner.signed({ ...call.attempt,
          requestDigestSha256: call.requestDigestSha256, resultDigestSha256,
          schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal_payload.v4",
          state: "terminal_success" }) };
    } finally {activeProviderCalls -= 1;}
  } });
  const reviewCalls = { first: 0, resolver: 0, second: 0 };
  const reviewerPort = (authority: ReturnType<typeof signer>, role: keyof typeof reviewCalls,
    disagree = false) => ({ authorityId: authority.keyId, publicKeyPem: authority.publicKeyPem,
      signerKeyId: authority.keyId,
      adjudicate: async (request: AdjudicationRequest) => {
        reviewCalls[role] += 1;
        const questionId = attemptQuestions.get(request.attemptId);
        if (questionId === undefined) {throw new Error("missing raw outcome identity");}
        const decision = decisionFor(questionId, request.outcomeDigestSha256,
          !(disagree && questionId === "a-0"));
        return authority.signed({ attemptId: request.attemptId, decision,
          decisionDigestSha256: sha256(decision), encryptedEvidenceSha256:
          request.encryptedEvidenceSha256, firstDecisionDigestSha256:
          request.firstDecisionDigestSha256, outcomeDigestSha256: request.outcomeDigestSha256,
          questionId: request.questionId, resolverBindingSha256: request.resolverBindingSha256,
          secondDecisionDigestSha256: request.secondDecisionDigestSha256 });
      } });
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
    return { attemptId, campaignRootSha256: String(request.campaignRootSha256),
      decision: firstDecision, decisionDigestSha256: sha256(firstDecision),
      firstReceiptSha256: sha256(first), outcomeDigestSha256, questionId,
      repetition: Number(request.repetition) as 1 | 2 | 3,
      resolverReceiptSha256: resolverReceipt === null ? null : sha256(resolverReceipt),
      secondReceiptSha256: sha256(second) };
  };
  const outcomesFor = (attemptIds: readonly string[]): ExactOutcomeEvidence[] =>
    attemptIds.map((attemptId) => exactOutcome(attemptId, attemptRequests,
      artifactBindingsByAttempt, finalAdjudicationByAttempt));
  const artifactKey = Buffer.alloc(32, 7);
  const envelopeByDigest = new Map<string, Uint8Array>();
  const artifactsByAttempt = new Map<string, readonly RetainedArtifact[]>();
  const artifactBindingsByAttempt = new Map<string, Record<string, string>>();
  const finalAdjudicationByAttempt = new Map<string, string>();
  const encodeArtifact = (answer: AttemptIdentity,
    kind: typeof REQUIRED_RETAINED_KINDS[number] | "resolver_result") => {
    const identity = artifactAttemptIdentity(answer, kind); const keyId = "retention-key";
    const plaintext = kind === "final_adjudication" ? Buffer.from(canonicalJson({ attemptId:
      answer.attemptId, questionId: answer.questionId,
    schemaVersion: "meeting_knowledge.semantic_quality_final_adjudication.v1" })) :
      Buffer.from(`${identity.attemptId}:${kind}`);
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
  const artifactsFor = (attemptIds: readonly string[]): RetainedArtifact[] =>
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
    const finalPlaintext = Buffer.from(canonicalJson({ attemptId, questionId:
      answerIdentity.questionId,
    schemaVersion: "meeting_knowledge.semantic_quality_final_adjudication.v1" }));
    finalAdjudicationByAttempt.set(attemptId, sha256(finalPlaintext));
    const bindings: Record<string, string> = {};
    const artifacts = [...REQUIRED_RETAINED_KINDS,
      ...(adjudication.resolverReceiptSha256 === null ? [] : ["resolver_result" as const])]
      .map((kind) => {
        const { aad, envelope, identity, keyId, plaintextSha256 } =
          encodeArtifact(answerIdentity, kind);
        const aadSha256 = sha256(aad); const envelopeSha256 = sha256(envelope);
        const keyBindingSha256 = sha256({ attemptId: identity.attemptId, keyId, kind,
          questionId: identity.questionId, repetition: identity.repetition,
          schemaVersion: "meeting_knowledge.semantic_quality_retained_key_binding.v1" });
        const storedBytes = envelope.byteLength;
        const artifactBindingSha256 = sha256({ aadSha256, attemptId: identity.attemptId,
          envelopeSha256, keyBindingSha256, keyId, kind, plaintextSha256,
          questionId: identity.questionId, repetition: identity.repetition, storedBytes,
          schemaVersion: "meeting_knowledge.semantic_quality_retained_artifact_binding.v1" });
        envelopeByDigest.set(envelopeSha256, envelope);
        bindings[kind] = artifactBindingSha256;
        return { aadSha256, artifactBindingSha256, attemptId: identity.attemptId,
          envelopeSha256, keyBindingSha256, keyId, kind, plaintextSha256,
          questionId: identity.questionId, repetition: identity.repetition, storedBytes };
      });
    artifactBindingsByAttempt.set(attemptId, bindings);
    artifactsByAttempt.set(attemptId, artifacts);
    return artifacts;
  });
  const deletedIds: string[] = []; const observedIds: string[] = [];
  const mainExchange = exchange(mainCalls, input.provider);
  const holdoutExchange = exchange(holdoutCalls, input.holdoutProvider);
  const mainEvidence = (attemptIds: readonly string[]) => {
    const adjudications = attemptIds.map(adjudicationFor);
    const artifacts = artifactsFor(attemptIds); const outcomes = outcomesFor(attemptIds);
    const authorizedLocatorIds = [...new Set(outcomes.flatMap(({ rankedLocatorDigests,
      relevantLocatorDigests }) => [...rankedLocatorDigests, ...relevantLocatorDigests]))].toSorted();
    const spendDigests = ([1, 2, 3] as const).map((repetition) => outcomes.find((outcome) =>
      outcome.repetition === repetition)!.identity.spendReservationSha256) as
      [string, string, string];
    const rootBindingSha256 = sha256({ authorizedLocatorSetSha256: sha256(authorizedLocatorIds),
      campaignRootSha256: outcomes[0]!.campaignRootSha256,
      questionSetSha256: sha256(input.questions), releaseRootSha256: input.releaseRootSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_final_root_binding.v2",
      spendReservationSetSha256: sha256(spendDigests) });
    const qualification = outcomes.map((outcome): QualificationOutcome => {
      const adjudication = adjudications.find(({ attemptId }) => attemptId === outcome.attemptId)!;
      const question = input.questions.find(({ questionId }) => questionId === outcome.questionId)!;
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
      relevantLocatorIds: outcome.relevantLocatorDigests, repetition: outcome.repetition,
      resolverRequired: adjudication.resolverReceiptSha256 !== null, rootBindingSha256,
      source: question.source, speakerTimeChecks:
        [{ canonicalTurnId: turnId, expectedSpeakerId: "speaker-1", expectedStartMs: 1_000,
          observedSpeakerId: "speaker-1", observedStartMs: 1_000, toleranceMs: 0 }],
      structurePassed: true };
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
    return { adjudications, artifacts, authorizedLocatorIds,
      campaignByteCeiling: 100_000_000, outcomes, repetitionEvidence };
  };
  const ports: QualityCampaignProductionPorts = {
    absence: { authorityId: input.absence.keyId,
      observe: async ({ campaignRootSha256, cleanupManifestSha256, targetArtifactIds }) => {
      observedIds.push(...targetArtifactIds);
      return input.absence.signed({ absentArtifactIds: [...targetArtifactIds].toSorted(),
        absentArtifactIdsSha256: sha256([...targetArtifactIds].toSorted()),
        campaignRootSha256, cleanupManifestSha256, presentProtectedArtifactIds:
          input.protectedOriginals.map(({ artifactId }) => artifactId).toSorted(),
        presentProtectedArtifactIdsSha256: sha256(input.protectedOriginals
          .map(({ artifactId }) => artifactId).toSorted()), releaseRootSha256:
          input.releaseRootSha256,
        schemaVersion: "meeting_knowledge.semantic_quality_cleanup_absence.v4" });
    } }, artifactCustody: { loadKey: async ({ keyId }) => keyId === "retention-key" ? {
      key: artifactKey, keyCustodySha256: input.release.artifactKeyCustodySha256 } : null,
    readEnvelope: async ({ envelopeSha256 }) => envelopeByDigest.get(envelopeSha256) ?? null },
    clock: input.clock,
    deletion: { authorityId: input.deletion.keyId, deleteDerived: async ({ targets }) => {
      deletedIds.push(...targets.map(({ artifactId }) => artifactId));
      return targets.map(({ artifactId }) => ({ artifactId, outcome: "deleted" as const }));
    } }, evidence: { holdout: async ({ attemptIds }) => ({ adjudications:
      attemptIds.map(adjudicationFor), outcomes: outcomesFor(attemptIds) }),
    main: async ({ attemptIds }) => mainEvidence(attemptIds) },
    holdoutProvider: { answer: holdoutExchange, capability: holdoutExchange,
      resultAuthority: input.holdoutProvider, retrieval: holdoutExchange },
    mainProvider: { answer: mainExchange, capability: mainExchange,
      resultAuthority: input.provider, retrieval: mainExchange },
    release: { observe: async () => input.release }, review: {
      first: reviewerPort(input.judge1, "first"),
      rawOutcomeEnvelopeSha256: async (attemptId) => digest(`envelope:${attemptId}`),
      resolver: reviewerPort(input.resolver, "resolver"),
      second: reviewerPort(input.judge2, "second", true),
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

function exactOutcome(attemptId: string, requests: ReadonlyMap<string, Record<string, unknown>>,
  artifactBindingsByAttempt:
  ReadonlyMap<string, Record<string, string>>, finalAdjudicationByAttempt:
  ReadonlyMap<string, string>): ExactOutcomeEvidence {
  const request = requests.get(attemptId);
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
  const artifactBindingSha256ByKind = artifactBindingsByAttempt.get(attemptId) ?? {};
  return { answerAbstained: isAbstention, artifactBindingSha256ByKind, attemptId,
    campaignRootSha256: String(request.campaignRootSha256),
    citationLocatorDigests: isAbstention ? [] : [locator],
    evidenceLocatorDigests: isAbstention ? [] : [locator],
    expectedAnswer: isAbstention ? "abstain" : "answerable",
    finalAdjudicationSha256: finalAdjudicationByAttempt.get(attemptId) ??
      digest(`${attemptId}:final-adjudication`), identity,
    forbiddenLocatorDigests: [digest(`forbidden:${questionId}`)],
    questionDigestSha256: String(request.questionDigestSha256), questionId,
    rankedLocatorDigests: [locator],
    relevantLocatorDigests: [locator],
    repetition, retrievalLatencyUs: 200_000 };
}

async function writeAuthority(root: string, name: string, authority: {
  readonly keyId: string; readonly publicKeyPem: string }): Promise<string> {
  const publicKeyPath = join(root, `${name}.pem`);
  await writeFile(publicKeyPath, authority.publicKeyPem);
  const path = join(root, `${name}-authority.json`);
  await writeFile(path, canonicalJson({ keyId: authority.keyId, publicKeyPath }));
  return path;
}
