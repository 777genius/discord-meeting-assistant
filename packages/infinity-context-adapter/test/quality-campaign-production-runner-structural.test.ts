import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FROZEN_ANSWER_EXECUTION,
  admitMainCampaign,
  canonicalJson,
  runQualityCampaignProductionCli,
  sha256,
  verifyReleaseRoot,
  type CampaignQuestion,
  type CanonicalAdjudicationDecision,
  type QualityCampaignProductionPorts,
  type QualityCampaignRelease,
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
    expect(fixture.reviewCalls.resolver).toBe(1);
    expect(await fixture.cli("retention", "retention-status.json")).toBe(20);
    expect(await fixture.cli("cleanup-absence", "cleanup-status.json")).toBe(0);
    expect(fixture.deletedIds.toSorted()).toEqual(["derived-index", "projection", "prompt"]);
    expect(fixture.observedIds.toSorted()).toEqual(fixture.deletedIds.toSorted());

    expect(fixture.holdoutCalls).toHaveLength(0);
    expect(await fixture.cli("holdout-execute", "holdout-status.json")).toBe(0);
    expect(fixture.holdoutCalls).toHaveLength(30 * 3);
    expect(new Set(fixture.holdoutCalls.map(({ questionId }) => questionId)).size).toBe(30);
    expect(fixture.mainCalls.some(({ questionId }) => questionId.startsWith("h-"))).toBe(false);

    for (const statusName of ["execute-status.json", "adjudicate-status.json",
      "retention-status.json", "cleanup-status.json", "holdout-status.json"]) {
      const status = await readFile(join(fixture.root, statusName), "utf8");
      expect(status).not.toMatch(/question|rubric|transcript|credential|secret|answer text/iu);
    }
  }, 60_000);

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
  const reviewer1 = signer("reviewer-1"); const reviewer2 = signer("reviewer-2");
  const judge1 = signer("judge-1"); const judge2 = signer("judge-2");
  const resolver = signer("resolver"); const provider = signer("provider-results");
  const releaseAuthority = signer("release"); const spend = signer("spend");
  const holdoutAuthority = signer("holdout-custody");
  const release: QualityCampaignRelease = {
    answerImageSha256: digest("answer-image"), answerProcessIdentitySha256: digest("answer-process"),
    answerReleaseSha256: digest("answer-release"), discordCommitSha256: digest("discord-commit"),
    discordImageSha256: digest("discord-image"), discordReleaseSha256: digest("discord-release"),
    infinityCapabilitySha256: digest("capability"), infinityCommitSha256: digest("infinity-commit"),
    infinityImageSha256: digest("infinity-image"), infinityProfileSha256: digest("profile"),
    infinityReleaseSha256: digest("infinity-release"), mapperSha256: digest("mapper"),
    ...FROZEN_ANSWER_EXECUTION, policySha256: digest("policy"), promptSha256: digest("prompt"),
    sdkArchiveSha256: digest("sdk-archive"), tokenizerSha256: digest("tokenizer"),
  };
  const releaseDocument = releaseAuthority.signed(release);
  const releaseRootSha256 = verifyReleaseRoot({ authorityPublicKeyPem:
    releaseAuthority.publicKeyPem, document: releaseDocument }).releaseRootSha256;
  const authorities = { absence, custody, holdoutAuthority, judge1, judge2, resolver,
    reviewer1, reviewer2, spend };
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
      expiresAtEpochMs: 4_000_000_000_000, maxCalls: 720, maxEncryptedBytes: 100_000_000,
      maxTokens: 10_000_000, ...FROZEN_ANSWER_EXECUTION, provider: "structural-provider",
      releaseRootSha256, repetition }))));
  const protectedEvidence = ["original_craig_recording", "final_transcript", "meeting_database",
    "frozen_signed_root"].map((kind) => ({ artifactSha256: digest(kind), kind }));
  const targets = [{ artifactId: "derived-index", kind: "derived_index" },
    { artifactId: "prompt", kind: "temporary_prompt" },
    { artifactId: "projection", kind: "temporary_projection" }] as const;
  const cleanupPlanPath = join(root, "cleanup-plan.json");
  await writeFile(cleanupPlanPath, canonicalJson({ protectedEvidence,
    schemaVersion: "meeting_knowledge.semantic_quality_cleanup_plan.v1", targets }));

  const holdoutQuestions = questions(30, "independent_review", "h");
  const mainProof: import("@discord-meeting/infinity-context-adapter/quality-campaign")
    .FrozenMainInputProof = { loadedLocatorDigests: [digest("main-locator")],
      loadedQuestionDigests: allQuestions.map(({ questionDigestSha256 }) => questionDigestSha256),
      mainInputRootSha256: admitted.rootBindingSha256, mainReleaseRootSha256: releaseRootSha256,
      tuningCorpusSha256: corpusDigestSha256 };
  const holdoutAuthorization = { authorizationSha256: digest("holdout-authorization"),
    holdoutRootSha256: digest("holdout-root"), keyNamespace: "holdout:structural",
    mainInputRootSha256: admitted.rootBindingSha256, mainReleaseRootSha256: releaseRootSha256,
    questionReceiptSha256: digest("holdout-review") };
  const holdoutAuthorizationPath = join(root, "holdout-authorization.json");
  const holdoutQuestionsPath = join(root, "holdout-questions.json");
  const holdoutLocatorsPath = join(root, "holdout-locators.json");
  const mainProofPath = join(root, "main-proof.json");
  await writeFile(holdoutAuthorizationPath,
    canonicalJson(holdoutAuthority.signed(holdoutAuthorization)));
  await writeFile(holdoutQuestionsPath, canonicalJson(holdoutQuestions));
  await writeFile(holdoutLocatorsPath, canonicalJson([digest("holdout-locator")]));
  await writeFile(mainProofPath, canonicalJson(mainProof));
  const holdoutInputPath = join(root, "holdout-input.json");
  await writeFile(holdoutInputPath, canonicalJson({ authorizationReceiptPath:
    holdoutAuthorizationPath, locatorDigestsPath: holdoutLocatorsPath, mainProofPath,
    questionsPath: holdoutQuestionsPath,
    schemaVersion: "meeting_knowledge.semantic_quality_holdout_input.v1" }));

  const configPath = join(root, "operator.json");
  await writeFile(configPath, canonicalJson({ absenceAuthorityPath: authorityPaths.absence,
    adjudicationAuthorityPaths: [authorityPaths.judge1, authorityPaths.judge2,
      authorityPaths.resolver], admissionAuthorityPath: authorityPaths.custody,
    checkpointRoot: join(root, "checkpoints"), cleanupPlanPath, concurrency: 8,
    holdoutAuthorityPath: authorityPaths.holdoutAuthority, holdoutInputPath,
    holdoutJournalRoot: join(root, "holdout-journal"), journalRoot: join(root, "journal"),
    mainManifestPath: manifestPath, releaseAuthorityPublicKeyPath: releasePublicKeyPath,
    releaseRootPath, reviewerAuthorityPaths: [authorityPaths.reviewer1,
      authorityPaths.reviewer2], schemaVersion:
    "meeting_knowledge.semantic_quality_production_operator.v1",
    spendAuthorityPath: authorityPaths.spend, spendReservationsPath }));
  const connectionsPath = join(root, "unused-connections.json");
  await writeFile(connectionsPath, "{}");
  const phasePath = join(root, "phase.json");
  await writeFile(phasePath, canonicalJson({ payload: { configurationPath: configPath,
    connectionsPath }, schemaVersion: "meeting_knowledge.semantic_quality_production_phase.v1" }));

  const mainCalls: ProviderCall[] = []; const holdoutCalls: ProviderCall[] = [];
  const attemptQuestions = new Map<string, string>();
  let activeProviderCalls = 0; let maximumProviderConcurrency = 0;
  let ambiguousNext = false;
  const exchange = (collection: ProviderCall[]) => ({ exchange: async (input: {
    readonly attemptId: string; readonly request: Uint8Array }) => {
    activeProviderCalls += 1; maximumProviderConcurrency = Math.max(maximumProviderConcurrency,
      activeProviderCalls);
    try {
      await new Promise<void>((resolve) => {setImmediate(resolve);});
      const request = JSON.parse(Buffer.from(input.request).toString("utf8")) as
        Record<string, unknown>;
      const questionId = String(request.questionId);
      collection.push({ attemptId: input.attemptId, questionId, request });
      attemptQuestions.set(input.attemptId, questionId);
      if (ambiguousNext) {ambiguousNext = false; return { effect: "unknown" as const };}
      return { effect: "certain_success" as const, signedResult: provider.signed({
        attemptId: input.attemptId, resultDigestSha256: digest(input.attemptId),
        state: "terminal_success" }) };
    } finally {activeProviderCalls -= 1;}
  } });
  const mainExchange = exchange(mainCalls); const holdoutExchange = exchange(holdoutCalls);
  const reviewCalls = { first: 0, resolver: 0, second: 0 };
  const reviewerPort = (authority: ReturnType<typeof signer>, role: keyof typeof reviewCalls,
    disagree = false) => ({ authorityId: authority.keyId, publicKeyPem: authority.publicKeyPem,
      adjudicate: async (request: { readonly attemptId: string;
        readonly encryptedEvidenceSha256: string; readonly outcomeDigestSha256: string }) => {
        reviewCalls[role] += 1;
        const questionId = attemptQuestions.get(request.attemptId);
        if (questionId === undefined) {throw new Error("missing raw outcome identity");}
        const decision: CanonicalAdjudicationDecision = { answerComplete: !(disagree &&
          questionId === "a-0"), claims: [], outcomeDigestSha256: request.outcomeDigestSha256,
          questionId };
        return authority.signed({ attemptId: request.attemptId, decision,
          decisionDigestSha256: sha256(decision), encryptedEvidenceSha256:
          request.encryptedEvidenceSha256, outcomeDigestSha256: request.outcomeDigestSha256 });
      } });
  const deletedIds: string[] = []; const observedIds: string[] = [];
  const ports: QualityCampaignProductionPorts = {
    absence: { observe: async ({ campaignRootSha256, targetArtifactIds }) => {
      observedIds.push(...targetArtifactIds);
      return absence.signed({ absentArtifactIds: [...targetArtifactIds].toSorted(),
        campaignRootSha256, cleanupManifestSha256: sha256({ campaignRootSha256,
          protectedKinds: ["authoritative_transcript", "final_transcript", "meeting_database",
            "original_craig_recording", "summary"], schemaVersion:
          "meeting_knowledge.semantic_quality_cleanup_manifest.v2", targets }),
        protectedEvidence, schemaVersion:
        "meeting_knowledge.semantic_quality_canonical_absence.v1" });
    } }, clock,
    deletion: { deleteDerived: async ({ targets: values }) => {
      deletedIds.push(...values.map(({ artifactId }) => artifactId));
      return values.map(({ artifactId }) => ({ artifactId, outcome: "deleted" as const }));
    } },
    holdoutProvider: { answer: holdoutExchange, capability: holdoutExchange,
      resultAuthority: provider, retrieval: holdoutExchange },
    mainProvider: { answer: mainExchange, capability: mainExchange,
      resultAuthority: provider, retrieval: mainExchange },
    qualification: { metrics: async ({ repetition }) => ({ metricsSha256:
      digest(`metrics-${repetition}`), outcomeCount: 240, thresholdsPassed: true }),
    retention: async () => ({ inventorySha256: digest("inventory"), outcomeCount: 720 }) },
    release: { observe: async () => release },
    review: { first: reviewerPort(judge1, "first"), rawOutcomeEnvelopeSha256: async (attemptId) =>
      digest(`envelope:${attemptId}`), resolver: reviewerPort(resolver, "resolver"),
    second: reviewerPort(judge2, "second", true), vault: { reconstruct: async ({ attempt }) => ({
      encryptedEvidenceSha256: digest(`evidence:${attempt.attemptId}`),
      outcomeDigestSha256: digest(`outcome:${attempt.attemptId}`) }) } },
  };
  const cli = async (command: string, statusName: string) =>
    await runQualityCampaignProductionCli({ argv: [command, phasePath, join(root, statusName)],
      ports });
  return { cli, clock, deletedIds, get ambiguousNext() {return ambiguousNext;},
    set ambiguousNext(value: boolean) {ambiguousNext = value;}, holdoutCalls, mainCalls,
    get maximumProviderConcurrency() {return maximumProviderConcurrency;}, observedIds,
    release, reviewCalls, root, startedAt };
}

interface ProviderCall {
  readonly attemptId: string;
  readonly questionId: string;
  readonly request: Record<string, unknown>;
}

async function writeAuthority(root: string, name: string, authority: {
  readonly keyId: string; readonly publicKeyPem: string }): Promise<string> {
  const publicKeyPath = join(root, `${name}.pem`);
  await writeFile(publicKeyPath, authority.publicKeyPem);
  const path = join(root, `${name}-authority.json`);
  await writeFile(path, canonicalJson({ keyId: authority.keyId, publicKeyPath }));
  return path;
}
