import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { PostgresHistoricalEvidenceAuthority, PostgresHistoricalMemoryStore,
  assertConstructedPostgresHistoricalEvidenceAuthority,
  assertConstructedPostgresHistoricalMemoryStore } from "@discord-meeting/postgres-adapter";

import {
  runSemanticQualityV4,
  type SemanticQualityV4RunQuestion,
} from "../src/semantic-quality-v4-runner.js";
import {
  SemanticQualityV4CreateOnlyJournal,
  SemanticQualityV4EncryptedArtifactStore,
  assertSemanticQualityV4ProductionJournal,
  semanticQualityV4AttemptId,
} from "./semantic-quality-v4-evidence-store.js";
import { runSemanticQualityV4RealCampaign, sealSemanticQualityV4CampaignRequest } from
  "./semantic-quality-v4-real-run.js";
import { assertSemanticQualityV4ArtifactReceiptCoverage,
  type SemanticQualityV4ReleaseBinding } from
  "./semantic-quality-v4-qualification.js";
import {
  createSemanticQualityV4RealRunAuthorities,
  loadRealSemanticQualityV4Corpus,
  mapRealGoldTurnsToProductionLocators,
} from "./semantic-quality-v4-private-corpus.js";
import { frozenSemanticQualityCorpusV4 } from "./semantic-quality-v4-corpus.js";
import { evaluateSemanticQualityV4, evaluateV4Thresholds } from
  "./semantic-quality-v4-evaluation.js";
import { perfectOutcomesForP0Test } from "./semantic-quality-v4-test-fixtures.js";
import {
  assertSemanticQualityV4ObservedArtifactBinding,
  requireSemanticQualityV4ExecutionObservation,
  requireSemanticQualityV4ServiceExecutionAttestation,
  requireSemanticQualityV4AdjudicationReceipts,
  semanticQualityV4ReviewerKeyRegistrySha256,
  semanticQualityV4ReceiptSigningBytes,
  verifySemanticQualityV4Receipt,
  verifySemanticQualityV4ReleaseTrustAnchor,
  type SemanticQualityV4PinnedReviewerKey,
  type SemanticQualityV4ReceiptRole,
  type SemanticQualityV4SignedReceipt,
} from "./semantic-quality-v4-trusted-receipts.js";
import { canonicalIntegerJson, canonicalSha256 } from "./semantic-quality-v4-manifest.js";
import { HmacHistoricalOpaqueIds, assertConstructedHmacHistoricalOpaqueIds } from
  "../src/hmac-historical-ids.js";

function reviewer(keyId: string, roles: readonly SemanticQualityV4ReceiptRole[]) {
  const pair = generateKeyPairSync("ed25519");
  const pinned: SemanticQualityV4PinnedReviewerKey = { keyId,
    publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(), roles };
  return { pinned, privateKey: pair.privateKey };
}

function receipt(input: { readonly binding: Readonly<Record<string, string | number>>;
  readonly decision?: string; readonly id: string; readonly keyId: string;
  readonly privateKey: KeyObject; readonly role: SemanticQualityV4ReceiptRole }):
SemanticQualityV4SignedReceipt {
  const unsigned = { binding: input.binding,
    decisionDigestSha256: input.decision ?? canonicalSha256({ receiptId: input.id }),
    receiptId: input.id, reviewerKeyId: input.keyId, role: input.role,
    schemaVersion: "meeting_knowledge.semantic_quality_review_receipt.v1" as const };
  return { ...unsigned, signatureBase64: sign(null,
    semanticQualityV4ReceiptSigningBytes(unsigned), input.privateKey).toString("base64") };
}

const surface = Object.freeze({ fullInputBytes: 11, outputSchemaBytes: 3,
  systemPromptBytes: 3, userPromptBytes: 3 });
const answerMeasurement = Object.freeze({ answerLatencyUs: 1, attemptId: "fixture-attempt",
  originalInput: surface, originalModelInputSha256: "b".repeat(64),
  originalProviderRequestSha256: "e".repeat(64),
  originalProviderResponseSha256: "f".repeat(64),
  repairInput: surface, repairModelInputSha256: "c".repeat(64), responseBytes: 1,
  repairProviderRequestSha256: null, repairProviderResponseSha256: null,
  responseRuntimeArtifactSha256: "d".repeat(64), runtimeReceiptSha256: "a".repeat(64) });

describe("semantic quality V4 block authority and durable execution controls", () => {
  it("makes automated strata explicit and gates per-locale micro block recall", () => {
    const metrics = evaluateSemanticQualityV4({
      outcomes: perfectOutcomesForP0Test(frozenSemanticQualityCorpusV4()) });
    const withoutStrata = { ...metrics, retrievalStrata: { anchorlessRecallAt5:
      { denominator: 0, numerator: 0 }, namedAnchorRecallAt5: { denominator: 0, numerator: 0 } } };
    expect(evaluateV4Thresholds(withoutStrata,
      { automatedRetrievalStrata: false, locales: ["en", "ru"] }).failedGateIds)
      .not.toContain("marker_blind_recall_at_5");
    const localeMicroFailure = { ...metrics, byLocale: { ...metrics.byLocale, ru: {
      ...metrics.byLocale.ru, blockLocatorRecallAt5: { denominator: 10, numerator: 8 } } } };
    expect(evaluateV4Thresholds(localeMicroFailure,
      { automatedRetrievalStrata: false, locales: ["en", "ru"] }).failedGateIds)
      .toContain("block_locator_recall_at_5_ru");
  });
  it("admits canonical turns through opaque block locators and rejects turn/block confusion", async () => {
    const questions = Array.from({ length: 240 }, (_, index): SemanticQualityV4RunQuestion => ({
      id: `q-${index}`, locale: "en", question: `Question ${index}`,
    }));
    let forge = false;
    const execute = () => runSemanticQualityV4({
      adjudication: { adjudicate: async () => ({ adjudications: [], citationEntailments: [],
        kind: "synthetic_structural_fixture" }) },
      answer: { answer: async () => ({ claims: [], measurement: answerMeasurement,
        prompt: "system\nuser\nschema", status: "abstained" }) },
      canonicalQuestions: questions,
      evidence: { rehydrate: async ({ queryId }) => ({ turns: [{ endMs: 2,
        sourceLocatorId: forge ? `turn-${queryId}` : `block-${queryId}`, speakerId: "speaker",
        startMs: 1, text: "canonical local text", turnId: `turn-${queryId}` }] }) },
      questions,
      retrieval: { retrieve: async ({ queryId }) => ({
        capabilityAndRetrievalLatencyUs: 2, capabilityBytes: 3,
        capabilitySha256: "b".repeat(64), expandedNeighborLocators: [], latencyUs: 2,
        rankedSeedLocators: [{ locatorId: `block-${queryId}` }], requestBytes: 3,
        requestSha256: "c".repeat(64), requestSnapshotSha256: "e".repeat(64), responseBytes: 3,
        responseSha256: "d".repeat(64), routeLatencyUs: 1, status: "completed" }),
      },
    });
    await expect(execute()).resolves.toHaveLength(240);
    forge = true;
    await expect(execute()).rejects.toThrow(/local evidence/u);
  });

  it("uses stable create-only reservation identities and never resumes reserved or unknown work",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "semantic-v4-journal-"));
      try {
        const journal = new SemanticQualityV4CreateOnlyJournal(root);
        const binding = { questionId: "question-1", repetition: 1 as const,
          rootBindingSha256: "a".repeat(64) };
        expect(semanticQualityV4AttemptId(binding)).toBe(semanticQualityV4AttemptId(binding));
        expect(new Set([semanticQualityV4AttemptId({ ...binding, questionId: "question-2" }),
          semanticQualityV4AttemptId({ ...binding, repetition: 2 }),
          semanticQualityV4AttemptId({ ...binding, rootBindingSha256: "b".repeat(64) }),
          semanticQualityV4AttemptId(binding)]).size).toBe(4);
        expect(await journal.resumable(binding)).toBe(true);
        const reservedPayloadSha256 = canonicalSha256({ reserved: true });
        await journal.reserve({ ...binding, reservedPayloadSha256 });
        expect(await journal.resumable(binding)).toBe(false);
        const reopenedAfterCrash = new SemanticQualityV4CreateOnlyJournal(root);
        expect(await reopenedAfterCrash.state(binding)).toBe("outcome_unknown");
        expect(await reopenedAfterCrash.resumable(binding)).toBe(false);
        await expect(journal.reserve({ ...binding, reservedPayloadSha256 }))
          .rejects.toMatchObject({ code: "EEXIST" });
        await journal.terminal({ ...binding, reservedPayloadSha256,
          terminalPayloadSha256: canonicalSha256({ terminal: "unknown" }),
          state: "outcome_unknown" });
        expect(await journal.state(binding)).toBe("outcome_unknown");
        expect(await journal.resumable(binding)).toBe(false);
        await expect(journal.terminal({ ...binding, reservedPayloadSha256,
          terminalPayloadSha256: canonicalSha256({ terminal: "success" }),
          state: "succeeded" })).rejects.toMatchObject({ code: "EEXIST" });
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    });

  it("fails closed across file/directory fsync faults and syncs recursive parents", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-v4-fsync-"));
    try {
      const binding = { questionId: "question-fsync", repetition: 1 as const,
        rootBindingSha256: canonicalSha256({ root: "fsync" }) };
      const reservedPayloadSha256 = canonicalSha256({ reserved: "fsync" });
      let fileSynced = false;
      const nested = join(root, "one", "two", "journal");
      const syncedDirectories: string[] = [];
      const faulted = new SemanticQualityV4CreateOnlyJournal(nested, {
        afterDirectorySync: (path) => {
          syncedDirectories.push(path);
          if (fileSynced) {throw new Error("injected directory fsync crash");}
        },
        afterFileSync: () => {fileSynced = true;},
      });
      await expect(faulted.reserve({ ...binding, reservedPayloadSha256 }))
        .rejects.toThrow(/directory fsync crash/u);
      const reopened = new SemanticQualityV4CreateOnlyJournal(nested);
      expect(await reopened.state(binding)).toBe("outcome_unknown");
      expect(await reopened.resumable(binding)).toBe(false);
      expect(syncedDirectories).toEqual(expect.arrayContaining([
        join(root, "one"), join(root, "one", "two"), nested,
      ]));

      const fileFaultBinding = { ...binding, questionId: "question-file-fsync" };
      const fileFault = new SemanticQualityV4CreateOnlyJournal(nested, {
        afterFileSync: () => {throw new Error("injected file fsync crash");},
      });
      await expect(fileFault.reserve({ ...fileFaultBinding, reservedPayloadSha256 }))
        .rejects.toThrow(/file fsync crash/u);
      expect(await reopened.state(fileFaultBinding)).toBe("outcome_unknown");
      expect(await reopened.resumable(fileFaultBinding)).toBe(false);
    } finally {await rm(root, { force: true, recursive: true });}
  });

  it("authenticates versioned private artifacts and rejects ciphertext mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-v4-artifacts-"));
    try {
      const store = new SemanticQualityV4EncryptedArtifactStore(root);
      const attemptId = semanticQualityV4AttemptId({ questionId: "question-1", repetition: 1,
        rootBindingSha256: canonicalSha256({ root: 1 }) });
      const sealed = await store.sealCreateOnly({ artifactKind: "answer", attemptId,
        key: new Uint8Array(32).fill(7), keyId: "retention-key-1",
        plaintext: new TextEncoder().encode("private fixture bytes"),
        rootBindingSha256: canonicalSha256({ root: 1 }) });
      expect(new TextDecoder().decode(await store.open({ envelopeSha256: sealed.envelopeSha256,
        key: new Uint8Array(32).fill(7) }))).toBe("private fixture bytes");
      const exchangeBindingSha256 = canonicalSha256({ attemptId, callOrdinal: "original",
        purpose: "discord_meeting.knowledge.answer.v1", runtimeProfile: "exact-profile" });
      const provider = await store.sealCreateOnly({ artifactKind: "original_provider_request",
        attemptId, exchangeBindingSha256, key: new Uint8Array(32).fill(7),
        keyId: "retention-key-1", plaintext: new Uint8Array([8, 1, 18, 3, 114, 97, 119]),
        rootBindingSha256: canonicalSha256({ root: 1 }) });
      await expect(store.verifyReceipt({ key: new Uint8Array(32).fill(7), receipt: provider }))
        .resolves.toBeUndefined();
      await expect(store.verifyReceipt({ key: new Uint8Array(32).fill(7), receipt: {
        ...provider, exchangeBindingSha256: canonicalSha256({ attemptId: "substituted" }) } }))
        .rejects.toThrow(/envelope-bound/u);
      const path = join(root, `${sealed.envelopeSha256}.enc.json`);
      const bytes = await readFile(path);
      bytes[bytes.length - 2] = bytes[bytes.length - 2]! ^ 1;
      await writeFile(path, bytes);
      await expect(store.open({ envelopeSha256: sealed.envelopeSha256,
        key: new Uint8Array(32).fill(7) })).rejects.toThrow(/digest|authentication/u);
    } finally {await rm(root, { force: true, recursive: true });}
  });

});

describe("semantic quality V4 exact envelope reconstruction", () => {
  it("rejects missing or tampered exact retrieval and provider envelopes", () => {
    const rootBindingSha256 = canonicalSha256({ root: "raw-envelope-coverage" });
    const base = perfectOutcomesForP0Test(frozenSemanticQualityCorpusV4())[0]!;
    const attemptId = semanticQualityV4AttemptId({ questionId: base.queryId, repetition: 1,
      rootBindingSha256 });
    const outcome = { ...base, answerMeasurement: { ...base.answerMeasurement, attemptId },
      retrieval: { ...base.retrieval } };
    const digestByKind = { adjudication: canonicalSha256({ kind: "adjudication" }),
      answer: canonicalSha256({ kind: "answer" }), evidence: canonicalSha256({ kind: "evidence" }),
      original_model_input: outcome.answerMeasurement.originalModelInputSha256,
      original_provider_request: outcome.answerMeasurement.originalProviderRequestSha256,
      original_provider_response: outcome.answerMeasurement.originalProviderResponseSha256,
      repair_model_input: outcome.answerMeasurement.repairModelInputSha256,
      response_runtime: outcome.answerMeasurement.responseRuntimeArtifactSha256,
      retrieval_request: outcome.retrieval.requestSha256,
      retrieval_response: outcome.retrieval.responseSha256 } as const;
    const exchangeBindingSha256 = canonicalSha256({ attemptId, callOrdinal: "original" });
    const retrievalBindingSha256 = canonicalSha256({ attemptId, callOrdinal: "retrieval" });
    const receipts: { artifactKind: string; attemptId: string; plaintextSha256: string;
      rootBindingSha256: string; exchangeBindingSha256?: string }[] = Object.entries(digestByKind)
      .map(([artifactKind, plaintextSha256]) =>
        ({ artifactKind, attemptId, plaintextSha256, rootBindingSha256,
          ...(artifactKind === "original_provider_request" ||
            artifactKind === "original_provider_response" ? { exchangeBindingSha256 } : {}),
          ...(artifactKind === "retrieval_request" || artifactKind === "retrieval_response" ?
            { exchangeBindingSha256: retrievalBindingSha256 } : {}) }));
    expect(() =>{  assertSemanticQualityV4ArtifactReceiptCoverage(receipts as never, [outcome] as never,
      rootBindingSha256); }).not.toThrow();
    expect(() =>{  assertSemanticQualityV4ArtifactReceiptCoverage(receipts.slice(1) as never,
      [outcome] as never, rootBindingSha256); }).toThrow(/coverage is incomplete/u);
    const tampered = receipts.map((artifactReceipt: { artifactKind: string }) =>
      artifactReceipt.artifactKind === "original_provider_response"
        ? { ...artifactReceipt, plaintextSha256: canonicalSha256({ tampered: true }) }
        : artifactReceipt);
    expect(() =>{  assertSemanticQualityV4ArtifactReceiptCoverage(tampered as never,
      [outcome] as never, rootBindingSha256); }).toThrow(/coverage is incomplete/u);
    const substituted = receipts.map((artifactReceipt) =>
      artifactReceipt.artifactKind === "original_provider_response"
        ? { ...artifactReceipt, exchangeBindingSha256: canonicalSha256({
          attemptId: "cross-attempt", callOrdinal: "repair" }) }
        : artifactReceipt);
    expect(() =>{  assertSemanticQualityV4ArtifactReceiptCoverage(substituted as never,
      [outcome] as never, rootBindingSha256); }).toThrow(/coverage is incomplete/u);
  });

});

describe("semantic quality V4 production admission", () => {
  it("rejects fake production ports and an unsealed real campaign before effects", async () => {
    let composed = false;
    await expect(runSemanticQualityV4RealCampaign({
      productionPorts: () => {composed = true; throw new Error("must not compose");},
      request: {},
    } as never)).rejects.toThrow(/unsealed/u);
    expect(composed).toBe(false);

    const questionReviewer1 = reviewer("question-1", ["question_rubric_review"]);
    const questionReviewer2 = reviewer("question-2", ["question_rubric_review"]);
    const questionReviewBinding = privateDigestBinding();
    const request = sealSemanticQualityV4CampaignRequest({ questionReviewBinding,
      rootBinding: releaseBinding(questionReviewBinding) });
    const canonicalQuestions = Array.from({ length: 240 }, (_, index) => ({ id: `q-${index}`,
      locale: "en" as const, question: `Question ${index}` }));
    const minimalAuthority = { questions: canonicalQuestions.map((question) => ({ ...question,
      evaluationQuestionText: question.question })) };
    await expect(runSemanticQualityV4RealCampaign({ authorities: { overall: minimalAuthority },
      questions: canonicalQuestions, pinnedKeys: [questionReviewer1.pinned,
      questionReviewer2.pinned], productionPorts: () => {composed = true;
      throw new Error("must not compose");}, questionReviewReceipts: [], request,
    } as never)).rejects.toThrow(/receipts are not independent/u);
    expect(composed).toBe(false);
    const reviews = [receipt({ binding: questionReviewBinding, id: "q-review-1",
      keyId: "question-1", privateKey: questionReviewer1.privateKey,
      role: "question_rubric_review" }), receipt({ binding: questionReviewBinding,
      id: "q-review-2", keyId: "question-2", privateKey: questionReviewer2.privateKey,
      role: "question_rubric_review" })];
    composed = false;
    await expect(runSemanticQualityV4RealCampaign({ authorities: { overall: minimalAuthority },
      artifactEncryption: { key: new Uint8Array(32).fill(1), keyId: "test-key" },
      artifactStoreRoot: join(tmpdir(), "semantic-v4-fake-port-no-write"),
      questions: canonicalQuestions,
      pinnedKeys: [questionReviewer1.pinned, questionReviewer2.pinned],
    productionPorts: () => {composed = true; return { evidence: {
      rehydrate: async () => ({ turns: [] }) }, retrieval: { retrieve: async () => {
        throw new Error("must not retrieve");} } };}, questionReviewReceipts: reviews,
    request } as never)).rejects.toThrow(/must not retrieve/u);
    expect(composed).toBe(true);
    const unrelated = { ...request, failedThresholdIds: [] };
    await expect(runSemanticQualityV4RealCampaign({ request: unrelated } as never))
      .rejects.toThrow(/unsealed or drifted/u);
  });

  it("rejects structural PostgreSQL authority prototype spoofs", () => {
    assertPostgresPrototypeSpoofsRejected();
  });
});

function privateDigestBinding(): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(["corpusSha256", "declaredTranscriptSha256",
    "inputSha256", "questionFileSha256", "questionSetSha256", "rubricFileSha256",
    "rubricSha256", "transcriptFileSha256"].map((key) => [key, canonicalSha256({ key })])));
}

async function assertPostSendPreEnvelopeCrashIsUnknown(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "semantic-v4-post-send-crash-"));
  try {
    const journal = new SemanticQualityV4CreateOnlyJournal(root);
    const binding = { questionId: "post-send-crash", repetition: 1 as const,
      rootBindingSha256: canonicalSha256({ root: "post-send-crash" }) };
    const reservedPayloadSha256 = canonicalSha256({ request: "exact-wire-request" });
    const reservation = await journal.reserve({ ...binding, reservedPayloadSha256 });
    await journal.reserveProviderCall({ attemptId: reservation.attemptId,
      callOrdinal: "original", purpose: "discord_meeting.knowledge.answer.v1",
      requestRunId: "provider-run-1", rootBindingSha256: binding.rootBindingSha256,
      runtimeProfile: { maxOutputTokens: 2_048, model: "gpt-5.6-sol",
        outputSchemaName: "discord_meeting_knowledge_answer_v1",
        policyVersion: "meeting-knowledge.answer.subscription-runtime.v3",
        reasoningEffort: "medium" } });
    expect({ authenticatedRawEnvelopeReceipts: [], providerBytesSent: true })
      .toEqual({ authenticatedRawEnvelopeReceipts: [], providerBytesSent: true });
    const reopened = new SemanticQualityV4CreateOnlyJournal(root);
    expect(await reopened.state(binding)).toBe("outcome_unknown");
    expect(await reopened.resumable(binding)).toBe(false);
  } finally {await rm(root, { force: true, recursive: true });}
}

function assertPostgresPrototypeSpoofsRejected(): void {
  const spoofedAuthority: object = {};
  const spoofedStore: object = {};
  Object.setPrototypeOf(spoofedAuthority, PostgresHistoricalEvidenceAuthority.prototype);
  Object.setPrototypeOf(spoofedStore, PostgresHistoricalMemoryStore.prototype);
  expect(() => {assertConstructedPostgresHistoricalEvidenceAuthority(spoofedAuthority);})
    .toThrow(/not constructed/u);
  expect(() => {assertConstructedPostgresHistoricalMemoryStore(spoofedStore);})
    .toThrow(/not constructed/u);
  expect(() => {assertConstructedHmacHistoricalOpaqueIds(
    Object.setPrototypeOf({}, HmacHistoricalOpaqueIds.prototype));}).toThrow(/not constructed/u);
  expect(() => {assertSemanticQualityV4ProductionJournal(
    Object.setPrototypeOf({}, SemanticQualityV4CreateOnlyJournal.prototype));})
    .toThrow(/not constructed/u);
}

function releaseBinding(questionReviewBinding: Readonly<Record<string, string>>):
SemanticQualityV4ReleaseBinding {
  return { answerModelConfigurationSha256: releaseDigest("model"),
    answerPolicySha256: releaseDigest("policy"),
    automatedCorpusSha256: releaseDigest("automated-corpus"),
    automatedQuestionSetSha256: releaseDigest("automated-questions"),
    capabilityBytesSha256: releaseDigest("capability-bytes"),
    capabilityFingerprintSha256: releaseDigest("capability-fingerprint"),
    discordRuntimeModuleSha256: releaseDigest("discord-runtime-module"),
    discordSourceCommit: releaseRevision("discord-commit"),
    discordSourceTree: releaseRevision("discord-tree"),
    executionObservationSha256: releaseDigest("execution-observation"),
    indexProfileSha256: releaseDigest("index"),
    infinityServiceImageSha256: releaseDigest("image"),
    infinitySourceCommit: releaseRevision("infinity-commit"),
    infinitySourceTree: releaseRevision("infinity-tree"),
    locatorAuthoritySha256: releaseDigest("locator-authority"),
    privateCorpusSha256: questionReviewBinding.corpusSha256!,
    privateInputSha256: questionReviewBinding.inputSha256!,
    privateQuestionSetSha256: questionReviewBinding.questionSetSha256!,
    promptMapperSha256: releaseDigest("prompt"),
    questionReviewBindingSha256: canonicalSha256(questionReviewBinding),
    requestSnapshotSha256: releaseDigest("request"),
    reviewerKeyRegistrySha256: releaseDigest("reviewer-registry"),
    rubricSha256: questionReviewBinding.rubricSha256!,
    runtimeArtifactSha256: releaseDigest("runtime"), sdkPackageSha256: releaseDigest("sdk"),
    sdkPackageSriSha512: `sha512-${createHash("sha512").update("sdk").digest("base64")}`,
    thresholdProfileSha256: releaseDigest("threshold-profile"),
    tokenizerSha256: releaseDigest("tokenizer"),
    trustAnchorSha256: releaseDigest("trust-anchor"),
    turnToBlockMappingSha256: releaseDigest("turn-block-mapping"),
    verifierModuleSetSha256: releaseDigest("verifier-module-set") };
}

function releaseDigest(key: string): string {return canonicalSha256({ releaseField: key });}
function releaseRevision(key: string): string {
  return createHash("sha1").update(key).digest("hex");
}

describe("semantic quality V4 trusted receipts and three-run cleanup admission", () => {
  it("terminalizes post-send/pre-envelope crashes as unknown",
    assertPostSendPreEnvelopeCrashIsUnknown);

  it("rejects replay and substituted execution identities even when release values match", () => {
    const observer = reviewer("execution-observer", ["execution_observation"]);
    const binding = { artifactBindingSha256: releaseDigest("artifacts"),
      campaignRunId: "campaign-run-1", endpointIdentitySha256: releaseDigest("endpoints"),
      infinityServiceIdentitySha256: releaseDigest("infinity-service"),
      infinityServiceProcessIdentitySha256: releaseDigest("infinity-process"),
      modelIdentitySha256: releaseDigest("model-identity"),
      processIdentitySha256: releaseDigest("local-process"),
      promptMapperSha256: releaseDigest("prompt-mapper"),
      providerOrdinalContractSha256: releaseDigest("provider-ordinals"),
      runtimeServiceIdentitySha256: releaseDigest("runtime-service"),
      runtimeServiceProcessIdentitySha256: releaseDigest("runtime-process"),
      stableAttemptId: releaseDigest("stable-attempt"),
      tokenizerSha256: releaseDigest("tokenizer") };
    const signed = receipt({ binding, id: "execution-current", keyId: "execution-observer",
      privateKey: observer.privateKey, role: "execution_observation" });
    const expected = (({ infinityServiceIdentitySha256: _infinityService,
      infinityServiceProcessIdentitySha256: _infinityProcess,
      runtimeServiceIdentitySha256: _runtimeService,
      runtimeServiceProcessIdentitySha256: _runtimeProcess, ...local }) => local)(binding);
    expect(requireSemanticQualityV4ExecutionObservation({ expected,
      pinnedKeys: [observer.pinned], receipt: signed }).digestSha256).toHaveLength(64);
    for (const key of ["campaignRunId", "endpointIdentitySha256", "modelIdentitySha256",
      "processIdentitySha256", "promptMapperSha256", "providerOrdinalContractSha256",
      "stableAttemptId", "tokenizerSha256"] as const) {
      const mismatched = { ...expected, [key]: key === "campaignRunId" ? "campaign-run-2" :
        releaseDigest(`mismatch-${key}`) };
      expect(() => requireSemanticQualityV4ExecutionObservation({ expected: mismatched,
        pinnedKeys: [observer.pinned], receipt: signed })).toThrow(/current-process bound/u);
    }
    const fakeEndpoint = reviewer("fake-endpoint", ["service_execution_attestation"]);
    const serviceBinding = { artifactBindingSha256: binding.artifactBindingSha256,
      campaignRunId: binding.campaignRunId, endpointIdentitySha256: binding.endpointIdentitySha256,
      processIdentitySha256: binding.processIdentitySha256,
      providerOrdinalContractSha256: binding.providerOrdinalContractSha256,
      serviceIdentitySha256: releaseDigest("claimed-service"),
      serviceImageSha256: releaseDigest("expected-image"), serviceKind: "infinity_context",
      serviceProcessIdentitySha256: releaseDigest("claimed-process"),
      stableAttemptId: binding.stableAttemptId,
      workloadIdentitySha256: releaseDigest("claimed-workload") };
    const service = reviewer("infinity-service", ["service_execution_attestation"]);
    const serviceClaim = receipt({ binding: serviceBinding, id: "service-current-attempt",
      keyId: "infinity-service", privateKey: service.privateKey,
      role: "service_execution_attestation" });
    expect(requireSemanticQualityV4ServiceExecutionAttestation({ binding: serviceBinding,
      pinnedKeys: [service.pinned], receipt: serviceClaim }).digestSha256).toHaveLength(64);
    for (const key of ["campaignRunId", "endpointIdentitySha256", "serviceImageSha256",
      "serviceProcessIdentitySha256", "stableAttemptId", "workloadIdentitySha256"] as const) {
      const replayed = { ...serviceBinding, [key]: key === "campaignRunId" ? "campaign-run-2" :
        releaseDigest(`service-mismatch-${key}`) };
      expect(() => requireSemanticQualityV4ServiceExecutionAttestation({ binding: replayed,
        pinnedKeys: [service.pinned], receipt: serviceClaim })).toThrow(/exact-binding/u);
    }
    const fakeClaim = receipt({ binding: serviceBinding, id: "fake-image-claim",
      keyId: "fake-endpoint", privateKey: fakeEndpoint.privateKey,
      role: "service_execution_attestation" });
    expect(() => requireSemanticQualityV4ServiceExecutionAttestation({ binding: serviceBinding,
      pinnedKeys: [observer.pinned], receipt: fakeClaim })).toThrow(/reviewer is not pinned/u);
  });

  it("rejects an operator-generated reviewer registry and matching synthetic trust anchor", () => {
    const operator = reviewer("operator", ["execution_observation",
      "per_question_adjudication"]);
    const independentRoot = generateKeyPairSync("ed25519");
    const reviewerKeys = [operator.pinned];
    const artifactBinding = { answerModelConfigurationSha256: releaseDigest("model"),
      answerPolicySha256: releaseDigest("policy"),
      discordRuntimeModuleSha256: releaseDigest("discord-runtime-module"),
      discordSourceCommit: releaseRevision("discord-commit"),
      discordSourceTree: releaseRevision("discord-tree"),
      infinityServiceImageSha256: releaseDigest("image"),
      infinitySourceCommit: releaseRevision("infinity-commit"),
      infinitySourceTree: releaseRevision("infinity-tree"),
      promptMapperSha256: releaseDigest("prompt"),
      reviewerKeyRegistrySha256: semanticQualityV4ReviewerKeyRegistrySha256(reviewerKeys),
      runtimeArtifactSha256: releaseDigest("runtime"),
      runtimeLauncherSha256: releaseDigest("launcher"),
      sdkPackageSha256: releaseDigest("sdk"),
      sdkPackageSriSha512: `sha512-${createHash("sha512").update("sdk").digest("base64")}`,
      tokenizerSha256: releaseDigest("tokenizer"),
      verifierModuleSetSha256: releaseDigest("verifier-module-set") };
    const unsigned = { artifactBinding, reviewerKeys,
      schemaVersion: "meeting_knowledge.semantic_quality_release_trust_anchor.v1" };
    const externalRootPem = independentRoot.publicKey
      .export({ format: "pem", type: "spki" }).toString();
    const independentlyAnchored = { ...unsigned, signatureBase64: sign(null,
      new TextEncoder().encode(canonicalIntegerJson(unsigned)), independentRoot.privateKey)
      .toString("base64") };
    expect(verifySemanticQualityV4ReleaseTrustAnchor(independentlyAnchored,
      externalRootPem).artifactBinding).toEqual(artifactBinding);
    const anchor = { ...unsigned, signatureBase64: sign(null,
      new TextEncoder().encode(canonicalIntegerJson(unsigned)), operator.privateKey)
      .toString("base64") };
    expect(() => verifySemanticQualityV4ReleaseTrustAnchor(anchor,
      externalRootPem))
      .toThrow(/trust anchor signature is invalid/u);
    const verifiedShape = { anchorSha256: canonicalSha256(anchor), artifactBinding,
      reviewerKeys };
    for (const field of ["discordRuntimeModuleSha256", "promptMapperSha256",
      "runtimeArtifactSha256", "sdkPackageSha256", "tokenizerSha256",
      "verifierModuleSetSha256"] as const) {
      expect(() => {assertSemanticQualityV4ObservedArtifactBinding(verifiedShape,
        { ...artifactBinding, [field]: releaseDigest(`substituted-${field}`) });})
        .toThrow(/observed artifacts differ/u);
    }
  });

  it("verifies real Ed25519 signatures and requires independent conflict resolution", () => {
    const first = reviewer("reviewer-1", ["claim_citation_adjudication"]);
    const second = reviewer("reviewer-2", ["claim_citation_adjudication"]);
    const resolver = reviewer("reviewer-3", ["claim_citation_conflict_resolution"]);
    const binding = { repetition: 1, runSha256: "a".repeat(64) };
    const left = receipt({ binding, decision: canonicalSha256({ decision: "left" }),
      id: "left", keyId: "reviewer-1",
      privateKey: first.privateKey, role: "claim_citation_adjudication" });
    const right = receipt({ binding, decision: canonicalSha256({ decision: "right" }),
      id: "right", keyId: "reviewer-2",
      privateKey: second.privateKey, role: "claim_citation_adjudication" });
    const resolution = receipt({ binding, decision: canonicalSha256({ decision: "resolution" }),
      id: "resolution",
      keyId: "reviewer-3", privateKey: resolver.privateKey,
      role: "claim_citation_conflict_resolution" });
    const keys = [first.pinned, second.pinned, resolver.pinned];
    expect(() => requireSemanticQualityV4AdjudicationReceipts({ binding, pinnedKeys: keys,
      receipts: [left, right] })).toThrow(/require resolution/u);
    expect(requireSemanticQualityV4AdjudicationReceipts({ binding,
      conflictReceipt: resolution, pinnedKeys: keys, receipts: [left, right] })).toHaveLength(3);
    const unrelated = receipt({ binding: { ...binding, runSha256: canonicalSha256({ run: 2 }) },
      id: "unrelated", keyId: "reviewer-1", privateKey: first.privateKey,
      role: "claim_citation_adjudication" });
    expect(() => requireSemanticQualityV4AdjudicationReceipts({ binding, pinnedKeys: keys,
      receipts: [unrelated, right] })).toThrow(/exact-binding/u);
    expect(() => verifySemanticQualityV4Receipt({ ...left,
      signatureBase64: "a".repeat(88) }, keys)).toThrow(/signature is invalid/u);
    const placeholder = receipt({ binding, decision: "a".repeat(64), id: "placeholder",
      keyId: "reviewer-1", privateKey: first.privateKey,
      role: "claim_citation_adjudication" });
    expect(() => verifySemanticQualityV4Receipt(placeholder, keys)).toThrow(/schema is invalid/u);
  });

  it("rejects one Ed25519 public key pinned under two reviewer IDs", () => {
    const first = reviewer("reviewer-1", ["claim_citation_adjudication"]);
    const duplicate = { ...first.pinned, keyId: "reviewer-2" };
    const binding = { repetition: 1, runSha256: canonicalSha256({ run: 1 }) };
    const signed = receipt({ binding, id: "review", keyId: "reviewer-1",
      privateKey: first.privateKey, role: "claim_citation_adjudication" });
    expect(() => verifySemanticQualityV4Receipt(signed, [first.pinned, duplicate]))
      .toThrow(/registry is ambiguous/u);
  });
});

describe("semantic quality V4 strict path-injected private corpus", () => {
  it("binds the exact private files, atomic rubric, two reviews, and block ceiling safely",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "semantic-v4-private-"));
      try {
        const first = reviewer("question-reviewer-1", ["question_rubric_review"]);
        const second = reviewer("question-reviewer-2", ["question_rubric_review"]);
        const built = await writePrivateFixture(root);
        const reviewBinding = { corpusSha256: built.corpusSha256,
          declaredTranscriptSha256: built.declaredTranscriptSha256,
          inputSha256: built.inputSha256, questionFileSha256: built.questionFileSha256,
          questionSetSha256: built.questionSetSha256,
          rubricFileSha256: built.rubricFileSha256, rubricSha256: built.rubricSha256,
          transcriptFileSha256: built.transcriptFileSha256 };
        const reviews = [
          receipt({ binding: reviewBinding, id: "question-review-1", keyId: "question-reviewer-1",
            privateKey: first.privateKey, role: "question_rubric_review" }),
          receipt({ binding: reviewBinding, id: "question-review-2", keyId: "question-reviewer-2",
            privateKey: second.privateKey, role: "question_rubric_review" }),
        ];
        const corpus = loadRealSemanticQualityV4Corpus({
          pinnedReviewerKeys: [first.pinned, second.pinned], questionPath: built.questionPath,
          reviewReceipts: reviews, rubricPath: built.rubricPath,
          transcriptPath: built.transcriptPath,
        });
        expect(corpus.safeCounts).toMatchObject({ abstention: 3, answerable: 37,
          locales: { en: 22, ru: 18 }, questions: 40, speakers: 8, turns: 2209 });
        expect(JSON.stringify(corpus.bindings)).not.toContain("PRIVATE_EXPECTED_ANSWER");
        const mapped = mapRealGoldTurnsToProductionLocators({ corpus,
          mapping: corpus.turns.map(({ turnId }) => ({ sourceLocatorId: realBlock(turnId),
            turnId })) });
        expect(mapped.questions).toHaveLength(40);
        expect(mapped.structuralCeilings.overall.completeRecallAt5).toEqual({
          denominator: 37, numerator: 37,
        });
        const automatedCorpus = frozenSemanticQualityCorpusV4();
        const automatedTurns = [...automatedCorpus.primaryMeeting.humanTurns,
          ...automatedCorpus.auxiliaryTurns];
        const automatedMapping = automatedTurns.map(({ turnId }) => ({
          sourceLocatorId: `block-${turnId}`, turnId,
        }));
        const forbiddenLocatorIds = automatedCorpus.auxiliaryTurns.map(({ turnId }) =>
          `block-${turnId}`);
        const authorities = createSemanticQualityV4RealRunAuthorities({ automatedCorpus,
          automatedMapping, forbiddenLocatorIds, realCorpus: corpus,
          realMapping: corpus.turns.map(({ turnId }) => ({ sourceLocatorId: realBlock(turnId),
            turnId })) });
        expect(authorities.automated.questions).toHaveLength(200);
        expect(authorities.real.questions).toHaveLength(40);
        expect(authorities.overall.questions).toHaveLength(240);
        expect(authorities.real.questions.some(({ locale }) => locale === "mixed")).toBe(false);

        const baseQuestions = JSON.parse(await readFile(built.questionPath, "utf8")) as {
          categoryCounts: Record<string, number>; participantMap: Record<string, string>;
          questions: Array<Record<string, unknown>>; transcriptSha256: string };
        const mutations: Array<[string, (value: typeof baseQuestions) => void]> = [
          ["40-question count", (value) => {value.questions.pop();}],
          ["answerable/abstention count", (value) => {value.questions[39]!.shouldAbstain = false;
            value.questions[39]!.expectedAnswer = "PRIVATE_MUTATED";}],
          ["locale count", (value) => {value.questions[0]!.language = "ru";}],
          ["category distribution", (value) => {value.questions[0]!.category = "semantic_paraphrase";
            value.categoryCounts.direct_fact = 7; value.categoryCounts.semantic_paraphrase = 9;}],
          ["participant authority", (value) => {delete value.participantMap["speaker-1"];
            value.participantMap["speaker-unknown"] = "PRIVATE_UNKNOWN";}],
          ["question speaker evidence", (value) => {
            value.questions[0]!.involvedSpeakerIds = ["speaker-8"];
            value.questions[0]!.evidenceTurnIds = ["turn-0"];}],
          ["evidence reference count", (value) => {
            (value.questions[0]!.evidenceTurnIds as string[]).push("turn-1000");}],
          ["296 unique evidence turns", (value) => {
            const all = value.questions.flatMap((question) =>
              question.evidenceTurnIds as string[]);
            const counts = Map.groupBy(all, (turnId) => turnId);
            const unique = [...counts].find(([, occurrences]) => occurrences.length === 1)?.[0];
            if (unique === undefined) {throw new Error("fixture lacks unique evidence");}
            const question = value.questions.find((item) =>
              (item.evidenceTurnIds as string[]).includes(unique))!;
            const evidence = question.evidenceTurnIds as string[];
            evidence[evidence.indexOf(unique)] = (value.questions[0]!.evidenceTurnIds as string[])[0]!;
            question.involvedSpeakerIds = ["speaker-1"];}],
          ["five time windows", (value) => {
            value.questions[23]!.category = "direct_fact";
            value.questions[23]!.timeWindow = null;}],
          ["decoded time authority", (value) => {
            const window = value.questions[23]!.timeWindow as { startMs: number };
            window.startMs += 1;}],
        ];
        for (const [label, mutate] of mutations) {
          const candidate = structuredClone(baseQuestions);
          mutate(candidate);
          const mutationPath = join(root, `mutation-${label.replaceAll(/[^a-z]+/gu, "-")}.json`);
          await writeFile(mutationPath, JSON.stringify(candidate));
          expect(() => loadRealSemanticQualityV4Corpus({
            pinnedReviewerKeys: [first.pinned, second.pinned], questionPath: mutationPath,
            reviewReceipts: reviews, rubricPath: built.rubricPath,
            transcriptPath: built.transcriptPath }), label).toThrow();
        }

        const transcriptBase = JSON.parse(await readFile(built.transcriptPath, "utf8")) as {
          transcript: { turns: Array<Record<string, unknown>> } };
        for (const [label, mutate] of [
          ["2209-turn count", (value: typeof transcriptBase) => {value.transcript.turns.pop();}],
          ["eight-speaker count", (value: typeof transcriptBase) => {
            for (const turn of value.transcript.turns) {
              if (turn.speakerId === "speaker-8") {turn.speakerId = "speaker-7";}
            }
          }],
        ] as const) {
          const candidate = structuredClone(transcriptBase);
          mutate(candidate);
          const mutationPath = join(root, `mutation-${label}.json`);
          await writeFile(mutationPath, JSON.stringify(candidate));
          expect(() => loadRealSemanticQualityV4Corpus({
            pinnedReviewerKeys: [first.pinned, second.pinned], questionPath: built.questionPath,
            reviewReceipts: reviews, rubricPath: built.rubricPath,
            transcriptPath: mutationPath }), label).toThrow(/transcript aggregates/u);
        }
        const rawDigestMutation = structuredClone(baseQuestions);
        rawDigestMutation.transcriptSha256 = canonicalSha256({ unrelated: "raw-file" });
        const rawDigestPath = join(root, "mutation-raw-transcript-digest.json");
        await writeFile(rawDigestPath, JSON.stringify(rawDigestMutation));
        expect(() => loadRealSemanticQualityV4Corpus({
          pinnedReviewerKeys: [first.pinned, second.pinned], questionPath: rawDigestPath,
          reviewReceipts: reviews, rubricPath: built.rubricPath,
          transcriptPath: built.transcriptPath })).toThrow(/raw-file authority/u);

        const malformedPath = join(root, "malformed.json");
        await writeFile(malformedPath, JSON.stringify({ leakedPrivateText: "PRIVATE_EXPECTED_ANSWER" }));
        let message = "";
        try {
          loadRealSemanticQualityV4Corpus({ pinnedReviewerKeys: [first.pinned, second.pinned],
            questionPath: malformedPath, reviewReceipts: reviews, rubricPath: built.rubricPath,
            transcriptPath: built.transcriptPath });
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toMatch(/object shape/u);
        expect(message).not.toContain("PRIVATE_EXPECTED_ANSWER");
        expect(message).not.toContain(root);
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    });
});

async function writePrivateFixture(root: string) {
  const corpusId = "private-corpus-v1";
  const speakerIds = Array.from({ length: 8 }, (_, index) => `speaker-${index + 1}`);
  const turns = Array.from({ length: 2209 }, (_, index) => ({ endMs: index * 1000 + 900,
    speakerId: speakerIds[index % speakerIds.length]!, startMs: index * 1000,
    text: `PRIVATE_TRANSCRIPT_TEXT_${index}`, turnId: `turn-${index}` }));
  const realTranscript = { createdAt: "2026-01-01T00:00:00.000Z", meetingId: corpusId,
    schemaVersion: 1, summary: {}, transcript: { readableSegments: [],
      recordingId: "recording-private", transcriptId: "transcript-private", turns, version: 1 } };
  const transcriptBytes = Buffer.from(JSON.stringify(realTranscript));
  const transcriptFileSha256 = createHash("sha256").update(transcriptBytes).digest("hex");
  const categories = [
    ...Array.from({ length: 8 }, () => "direct_fact"),
    ...Array.from({ length: 8 }, () => "semantic_paraphrase"),
    ...Array.from({ length: 7 }, () => "speaker_attribution"),
    ...Array.from({ length: 5 }, () => "time_window_relative_order"),
    ...Array.from({ length: 5 }, () => "multi_turn_multi_hop"),
    ...Array.from({ length: 4 }, () => "negation_correction_changed_decision"),
    ...Array.from({ length: 3 }, () => "unanswerable"),
  ];
  const evidenceByQuestion = Array.from({ length: 37 }, (_, index) => {
    const unique = Array.from({ length: 8 }, (__, offset) => `turn-${index * 8 + offset}`);
    const next = ((index + 1) % 37) * 8;
    return [...unique, `turn-${next}`, ...(index < 5 ? [`turn-${next + 1}`] : [])];
  });
  const questions = Array.from({ length: 40 }, (_, index) => ({ category: categories[index]!,
    difficulty: index < 13 ? "easy" : index < 31 ? "medium" : "hard",
    evidenceSufficiency: `PRIVATE_EVIDENCE_SUFFICIENCY_${index}`,
    evidenceTurnIds: index < 37 ? evidenceByQuestion[index]! : [],
    expectedAnswer: index < 37 ? `PRIVATE_EXPECTED_ANSWER_${index}` : "",
    id: `real-question-${index}`,
    involvedSpeakerIds: index < 37 ? [turns[Number(evidenceByQuestion[index]![0]!.slice(5))]!
      .speakerId] : [],
    language: index < 22 ? "en" : "ru", question: `PRIVATE_QUESTION_TEXT_${index}`,
    shouldAbstain: index >= 37,
    timeWindow: categories[index] === "time_window_relative_order"
      ? { endMs: Math.max(...evidenceByQuestion[index]!.map((id) =>
          turns[Number(id.slice(5))]!.endMs)),
        startMs: Math.min(...evidenceByQuestion[index]!.map((id) =>
          turns[Number(id.slice(5))]!.startMs)) }
      : null }));
  const categoryCounts = { direct_fact: 8, semantic_paraphrase: 8,
    speaker_attribution: 7, time_window_relative_order: 5, multi_turn_multi_hop: 5,
    negation_correction_changed_decision: 4, unanswerable: 3, total: 40 };
  const curatorChecks = { allCitedTurnIdsExist: true,
    allEvidenceTextSupportsExpectedAnswer: true, distributionSumsTo40: true,
    noQuestionUsesSummaryAsEvidence: true, questionCountIs40: true,
    secondPassCompletedBeforeWrite: true, speakerFieldsMatchEvidence: true,
    timeFieldsMatchEvidence: true, transcriptTurnsWereSoleAnswerEvidence: true };
  const declaredTranscriptSha256 = transcriptFileSha256;
  const participantMap = Object.fromEntries(speakerIds.map((speakerId, index) =>
    [speakerId, `PRIVATE_PARTICIPANT_${index}`]));
  const questionSet = { categoryCounts, curatorChecks, meetingId: corpusId, participantMap,
    questions, schemaVersion: 1, transcriptSha256: declaredTranscriptSha256 };
  const questionBytes = Buffer.from(JSON.stringify(questionSet));
  const questionFileSha256 = createHash("sha256").update(questionBytes).digest("hex");
  const questionSetSha256 = canonicalSha256(questions.map((question) => ({
    category: question.category, evidenceTurnIds: question.evidenceTurnIds, id: question.id,
    kind: question.shouldAbstain ? "abstention" : "answerable", locale: question.language,
    speakerIds: question.involvedSpeakerIds, timeWindow: question.timeWindow,
  })));
  const corpusSha256 = canonicalSha256({ corpusId, questionFileSha256,
    transcriptFileSha256 });
  const inputSha256 = canonicalSha256({ questionFileSha256, transcriptFileSha256 });
  const rubricQuestions = questions.map((question, index) => ({
    expectedClaims: index < 37 ? [{ claimId: `claim-${index}`,
      text: `PRIVATE_ATOMIC_CLAIM_${index}` }] : [], questionId: question.id }));
  const rubricSha256 = canonicalSha256(rubricQuestions.map(({ expectedClaims, questionId }) => ({
    expectedClaimIds: expectedClaims.map(({ claimId }) => claimId), questionId,
  })));
  const rubric = { corpusId, corpusSha256, inputSha256, questions: rubricQuestions,
    questionSetSha256, schemaVersion: "meeting_memory.atomic_claim_rubric.v1" };
  const transcriptPath = join(root, "transcript.json");
  const questionPath = join(root, "questions.json");
  const rubricPath = join(root, "rubric.json");
  await writeFile(transcriptPath, transcriptBytes, { mode: 0o600 });
  await writeFile(questionPath, questionBytes, { mode: 0o600 });
  await writeFile(rubricPath, JSON.stringify(rubric), { mode: 0o600 });
  const rubricFileSha256 = createHash("sha256").update(JSON.stringify(rubric)).digest("hex");
  return { corpusSha256, declaredTranscriptSha256, inputSha256, questionFileSha256,
    questionPath, questionSetSha256, rubricFileSha256, rubricPath, rubricSha256,
    transcriptFileSha256, transcriptPath };
}

function realBlock(turnId: string): string {
  return `block-${Math.floor(Number(turnId.slice("turn-".length)) / 10)}`;
}
