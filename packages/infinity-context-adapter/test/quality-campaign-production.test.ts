import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  admitMainCampaign,
  admitFinalCampaign,
  admitIsolatedHoldout,
  adjudicateOutcome,
  assertObservedRelease,
  attemptIdentity,
  canonicalJson,
  createCleanupManifest,
  createHoldoutReport,
  DurableAttemptJournal,
  executeReservedExchange,
  FROZEN_ANSWER_EXECUTION,
  runQualityCampaignOperatorCli,
  sha256,
  verifyExactRetentionInventory,
  verifyReleaseRoot,
  verifySpendReservations,
  type AdjudicationAuthorityPort,
  type CampaignQuestion,
  type ExpectedOutcomeInventory,
  type QualityCampaignRelease,
  type RetainedArtifact,
} from "../src/index.js";

const d = (character: string) => character.repeat(64);

function signer(keyId: string) {
  const keys = generateKeyPairSync("ed25519");
  return {
    keyId, publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
    signed<T>(payload: T) {return Object.freeze({ payload,
      signatureBase64: sign(null, Buffer.from(canonicalJson(payload)), keys.privateKey)
        .toString("base64"), signerKeyId: keyId });},
  };
}

function sealedQuestions(count: number, source: CampaignQuestion["source"], prefix: string) {
  return Array.from({ length: count }, (_, index) => ({ locale: "en" as const,
    questionDigestSha256: sha256({ index, prefix }), questionId: `${prefix}-${index}`,
    rubricDigestSha256: sha256({ index, rubric: prefix }), source }));
}

function terminalPayload(input: { readonly campaignRootSha256: string;
  readonly identity: ReturnType<typeof attemptIdentity>; readonly request: Uint8Array;
  readonly resultDigestSha256: string; readonly state: "terminal_failure" | "terminal_success" }) {
  return { ...input.identity, campaignRootSha256: input.campaignRootSha256,
    requestDigestSha256: sha256(input.request), resultDigestSha256: input.resultDigestSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal_payload.v3",
    state: input.state };
}

function retainedArtifact(outcome: Pick<ExpectedOutcomeInventory, "attemptId" | "questionId" |
  "repetition">,
  kind: RetainedArtifact["kind"]): RetainedArtifact {
  const keyId = "campaign-key";
  const aadSha256 = sha256({ attemptId: outcome.attemptId, kind, scope: "aad" });
  const envelopeSha256 = sha256({ attemptId: outcome.attemptId, kind, scope: "envelope" });
  const plaintextSha256 = sha256({ attemptId: outcome.attemptId, kind, scope: "plaintext" });
  const keyBindingSha256 = sha256({ attemptId: outcome.attemptId, keyId, kind,
    questionId: outcome.questionId, repetition: outcome.repetition,
    schemaVersion: "meeting_knowledge.semantic_quality_retained_key_binding.v1" });
  const storedBytes = 1;
  const artifactBindingSha256 = sha256({ aadSha256, attemptId: outcome.attemptId,
    envelopeSha256, keyBindingSha256, keyId, kind, plaintextSha256,
    questionId: outcome.questionId, repetition: outcome.repetition, storedBytes,
    schemaVersion: "meeting_knowledge.semantic_quality_retained_artifact_binding.v1" });
  return { aadSha256, artifactBindingSha256, attemptId: outcome.attemptId, envelopeSha256,
    keyBindingSha256, keyId, kind, plaintextSha256, questionId: outcome.questionId,
    repetition: outcome.repetition, storedBytes };
}

describe("production quality campaign", () => {
  it("admits an exact 200+40 sealed corpus and rejects checksum substitution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quality-admission-"));
    const custody = signer("custody"); const reviewer1 = signer("reviewer-1");
    const reviewer2 = signer("reviewer-2"); const releaseRootSha256 = d("9");
    const automatic = sealedQuestions(200, "automatic", "a");
    const reviewed = sealedQuestions(40, "independent_review", "r");
    const all = [...automatic, ...reviewed];
    const sourceDigestSha256 = d("1"); const corpusDigestSha256 = d("2");
    const reviewerDigestSha256 = d("3");
    const acceptance = custody.signed({ corpusDigestSha256, purpose: "custody_only",
      reviewerDigestSha256, schemaVersion: "meeting_knowledge.semantic_quality_acceptance.v1",
      sourceDigestSha256 });
    const authorization = custody.signed({ acceptanceReceiptSha256: sha256(acceptance),
      authorizedProviderExecution: true, corpusDigestSha256,
      expiresAtEpochMs: Date.now() + 60_000, releaseRootSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_execution_authorization.v1" });
    const reviewPayload = { corpusDigestSha256, questionSetSha256: sha256(all),
      reviewerDigestSha256, rubricSetSha256: sha256(all.map(({ questionId,
        rubricDigestSha256 }) => ({ questionId, rubricDigestSha256 }))),
      schemaVersion: "meeting_knowledge.semantic_quality_question_review.v1" };
    const authorityPayload = { entriesSha256: d("4"), releaseRootSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_locator_authority.v1",
      snapshotSha256: d("5") };
    const files: Record<string, unknown> = { "acceptance.json": acceptance,
      "authorization.json": authorization, "automatic.json": automatic,
      "forbidden.json": custody.signed(authorityPayload), "mapping.json":
      custody.signed(authorityPayload), "review-1.json": reviewer1.signed(reviewPayload),
      "review-2.json": reviewer2.signed(reviewPayload), "reviewed.json": reviewed };
    for (const [path, value] of Object.entries(files)) {
      await writeFile(join(directory, path), canonicalJson(value));
    }
    const checksumInventory = await Promise.all(Object.keys(files).map(async (path) => ({ path,
      sha256: sha256(await readFile(join(directory, path))) })));
    const manifest = { acceptanceReceiptPath: "acceptance.json", checksumInventory,
      corpusDigestSha256, executionAuthorizationPath: "authorization.json",
      forbiddenLocatorManifestPath: "forbidden.json", independentReviewQuestionsPath:
      "reviewed.json", questionReviewReceiptPaths: ["review-1.json", "review-2.json"],
      reviewerDigestSha256, schemaVersion: "meeting_knowledge.semantic_quality_input_manifest.v4",
      sealedAutomaticQuestionsPath: "automatic.json", sourceDigestSha256,
      turnToBlockManifestPath: "mapping.json" };
    const manifestPath = join(directory, "InputManifest.v4.json");
    await writeFile(manifestPath, canonicalJson(manifest));
    const admitted = await admitMainCampaign({ authority: custody, manifestPath,
      releaseRootSha256, reviewerAuthorities: [reviewer1, reviewer2] });
    expect(admitted.questions).toHaveLength(240);
    await expect(admitMainCampaign({ authority: custody, manifestPath, releaseRootSha256,
      reviewerAuthorities: [reviewer1, { ...reviewer2, publicKeyPem: reviewer1.publicKeyPem }] }))
      .rejects.toThrow(/cryptographically independent/u);
    await writeFile(join(directory, "automatic.json"), "[]");
    await expect(admitMainCampaign({ authority: custody, manifestPath, releaseRootSha256,
      reviewerAuthorities: [reviewer1, reviewer2] })).rejects.toThrow(/checksum/u);
  });

  it("rejects model, reasoning, tier, SDK, image, and signature substitutions", () => {
    const authority = signer("release");
    const release: QualityCampaignRelease = { answerImageSha256: d("1"),
      answerProcessIdentitySha256: d("2"),
      answerReleaseSha256: d("3"), discordCommitSha256: d("4"), discordImageSha256: d("5"),
      discordReleaseSha256: d("6"), infinityCapabilitySha256: d("7"),
      infinityCommitSha256: d("8"), infinityImageSha256: d("9"),
      infinityProfileSha256: d("a"), infinityReleaseSha256: d("b"), mapperSha256: d("c"),
      ...FROZEN_ANSWER_EXECUTION, policySha256: d("d"), promptSha256: d("e"),
      sdkArchiveSha256: d("f"), tokenizerSha256: d("0") };
    expect(verifyReleaseRoot({ authorityPublicKeyPem: authority.publicKeyPem,
      document: authority.signed(release) }).release).toEqual(release);
    for (const mutation of [{ model: "fallback" }, { reasoning: "medium" },
      { serviceTier: "fast" }]) {
      expect(() => verifyReleaseRoot({ authorityPublicKeyPem: authority.publicKeyPem,
        document: authority.signed({ ...release, ...mutation }) })).toThrow();
    }
    const provenanceMutations: readonly Partial<QualityCampaignRelease>[] = [
      { sdkArchiveSha256: d("0") }, { infinityImageSha256: d("0") },
      { tokenizerSha256: d("1") }, { promptSha256: d("2") }];
    for (const mutation of provenanceMutations) {
      expect(() => {assertObservedRelease(release, { ...release, ...mutation });}).toThrow(/drifted/u);
    }
    const tampered = authority.signed(release);
    expect(() => verifyReleaseRoot({ authorityPublicKeyPem: authority.publicKeyPem,
      document: { ...tampered, signatureBase64: "AA==" } })).toThrow(/signature/u);
  });

  it("authenticates three exact spend reservations and rejects tamper/expiry/budget drift", () => {
    const authority = signer("spend");
    const base = { campaignRootSha256: d("1"), expiresAtEpochMs: 2_000, maxCalls: 480,
      maxEncryptedBytes: 50_000_000, maxTokens: 500_000, ...FROZEN_ANSWER_EXECUTION,
      provider: "external-authority", releaseRootSha256: d("2") };
    const receipts = [1, 2, 3].map((repetition) => authority.signed({ ...base, repetition }));
    expect(verifySpendReservations({ authorityKeyId: authority.keyId,
      authorityPublicKeyPem: authority.publicKeyPem, campaignRootSha256: d("1"),
      nowEpochMs: 1_000, releaseRootSha256: d("2"), reservations: receipts })).toHaveLength(3);
    for (const reservations of [receipts.slice(0, 2), receipts.map((value, index) =>
      index === 0 ? authority.signed({ ...value.payload, maxCalls: 1 }) : value),
    receipts.map((value, index) => index === 0 ? authority.signed({ ...value.payload,
      expiresAtEpochMs: 500 }) : value)]) {
      expect(() => verifySpendReservations({ authorityKeyId: authority.keyId,
        authorityPublicKeyPem: authority.publicKeyPem, campaignRootSha256: d("1"),
        nowEpochMs: 1_000, releaseRootSha256: d("2"),
        reservations })).toThrow();
    }
  });

  it("binds terminal replay to the exact reserved exchange and blocks foreign evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quality-journal-"));
    const authority = signer("provider");
    const journal = new DurableAttemptJournal(directory, authority);
    const identity = attemptIdentity({ callKind: "retrieval", callOrdinal: 0,
      campaignRootSha256: d("1"), questionDigestSha256: d("2"), questionId: "q-1",
      repetition: 1 });
    const port = { exchange: vi.fn(async () => ({ effect: "unknown" as const })) };
    expect(await executeReservedExchange({ campaignRootSha256: d("1"), identity, journal, port,
      request: Buffer.from("bounded") })).toBe("outcome_unknown");
    expect(await executeReservedExchange({ campaignRootSha256: d("1"), identity, journal, port,
      request: Buffer.from("bounded") })).toBe("outcome_unknown");
    expect(port.exchange).toHaveBeenCalledTimes(1);

    const second = attemptIdentity({ callKind: "answer", callOrdinal: 0,
      campaignRootSha256: d("1"), questionDigestSha256: d("3"), questionId: "q-2",
      repetition: 1 });
    const request = Buffer.from("bounded");
    const success = { exchange: vi.fn(async () => ({ effect: "certain_success" as const,
      resultDigestSha256: d("4"),
      signedResult: authority.signed(terminalPayload({ campaignRootSha256: d("1"),
        identity: second, request, resultDigestSha256: d("4"), state: "terminal_success" })) })) };
    expect(await executeReservedExchange({ campaignRootSha256: d("1"), identity: second,
      journal, port: success, request })).toBe("terminal_success");
    expect(await executeReservedExchange({ campaignRootSha256: d("1"), identity: second,
      journal, port: success, request })).toBe("terminal_success");
    expect(success.exchange).toHaveBeenCalledTimes(1);
    expect(await executeReservedExchange({ campaignRootSha256: d("1"), identity: second,
      journal, port: success, request: Buffer.from("substituted") })).toBe("blocked_evidence");
    expect(success.exchange).toHaveBeenCalledTimes(1);

    const foreignDirectory = await mkdtemp(join(tmpdir(), "quality-journal-foreign-"));
    const foreignJournal = new DurableAttemptJournal(foreignDirectory, authority);
    const foreign = attemptIdentity({ callKind: "answer", callOrdinal: 1,
      campaignRootSha256: d("1"), questionDigestSha256: d("3"), questionId: "q-2",
      repetition: 1 });
    const foreignPort = { exchange: vi.fn(async () => ({ effect: "certain_success" as const,
      resultDigestSha256: d("4"),
      signedResult: authority.signed(terminalPayload({ campaignRootSha256: d("1"),
        identity: foreign, request, resultDigestSha256: d("4"), state: "terminal_success" })) })) };
    expect(await executeReservedExchange({ campaignRootSha256: d("1"), identity: second,
      journal: foreignJournal, port: foreignPort, request })).toBe("blocked_evidence");
    expect(foreignPort.exchange).toHaveBeenCalledTimes(1);
    expect(await executeReservedExchange({ campaignRootSha256: d("1"), identity: second,
      journal: foreignJournal, port: foreignPort, request })).toBe("blocked_evidence");
    expect(foreignPort.exchange).toHaveBeenCalledTimes(1);

    const replayDirectory = await mkdtemp(join(tmpdir(), "quality-journal-replay-"));
    const replayJournal = new DurableAttemptJournal(replayDirectory, authority);
    const unknownPort = { exchange: vi.fn(async () => ({ effect: "unknown" as const })) };
    expect(await executeReservedExchange({ campaignRootSha256: d("1"), identity: second,
      journal: replayJournal, port: unknownPort, request })).toBe("outcome_unknown");
    const reservation = JSON.parse(await readFile(join(replayDirectory, second.attemptId,
      "reserved.json"), "utf8")) as unknown;
    const foreignBinding = terminalPayload({ campaignRootSha256: d("1"), identity: foreign,
      request, resultDigestSha256: d("4"), state: "terminal_success" });
    const signedForeignBinding = authority.signed(foreignBinding);
    await writeFile(join(replayDirectory, second.attemptId, "terminal.json"), canonicalJson({
      attemptId: foreign.attemptId, binding: foreignBinding, reservationSha256: sha256(reservation),
      schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal.v3",
      signedResult: signedForeignBinding, state: "terminal_success" }));
    const replayPort = { exchange: vi.fn(async () => ({ effect: "certain_success" as const,
      resultDigestSha256: d("4"),
      signedResult: signedForeignBinding })) };
    expect(await executeReservedExchange({ campaignRootSha256: d("1"), identity: second,
      journal: replayJournal, port: replayPort, request })).toBe("blocked_evidence");
    expect(replayPort.exchange).not.toHaveBeenCalled();

    const basePayload = terminalPayload({ campaignRootSha256: d("1"), identity: second,
      request, resultDigestSha256: d("4"), state: "terminal_success" });
    const mutations: readonly Partial<typeof basePayload>[] = [
      { attemptId: foreign.attemptId }, { callKind: "retrieval" }, { callOrdinal: 99 },
      { campaignRootSha256: d("8") }, { questionDigestSha256: d("8") },
      { questionId: "foreign-question" }, { repetition: 2 },
      { requestDigestSha256: d("8") }, { resultDigestSha256: d("8") },
      { resultDigestSha256: "invalid" },
      { state: "terminal_failure" },
    ];
    for (const mutation of mutations) {
      const mutationDirectory = await mkdtemp(join(tmpdir(), "quality-journal-mutation-"));
      const mutationJournal = new DurableAttemptJournal(mutationDirectory, authority);
      const mutationPort = { exchange: vi.fn(async () => ({ effect: "certain_success" as const,
        resultDigestSha256: d("4"),
        signedResult: authority.signed({ ...basePayload, ...mutation }) })) };
      expect(await executeReservedExchange({ campaignRootSha256: d("1"), identity: second,
        journal: mutationJournal, port: mutationPort, request })).toBe("blocked_evidence");
      expect(await executeReservedExchange({ campaignRootSha256: d("1"), identity: second,
        journal: mutationJournal, port: mutationPort, request })).toBe("blocked_evidence");
      expect(mutationPort.exchange).toHaveBeenCalledTimes(1);
    }
    const forgedPort = { exchange: vi.fn() };
    await expect(executeReservedExchange({ campaignRootSha256: d("1"),
      identity: { ...second, callOrdinal: 99 }, journal, port: forgedPort,
      request })).rejects.toThrow(/reconstruct/u);
    expect(forgedPort.exchange).not.toHaveBeenCalled();

    const corruptDirectory = await mkdtemp(join(tmpdir(), "quality-journal-corrupt-"));
    const corruptJournal = new DurableAttemptJournal(corruptDirectory, authority);
    expect(await executeReservedExchange({ campaignRootSha256: d("1"), identity: second,
      journal: corruptJournal, port: unknownPort, request })).toBe("outcome_unknown");
    await writeFile(join(corruptDirectory, second.attemptId, "terminal.json"), "{");
    const corruptReplayPort = { exchange: vi.fn() };
    expect(await executeReservedExchange({ campaignRootSha256: d("1"), identity: second,
      journal: corruptJournal, port: corruptReplayPort, request })).toBe("blocked_evidence");
    expect(corruptReplayPort.exchange).not.toHaveBeenCalled();
  });

  it("uses two judges and invokes an independent resolver only on disagreement", async () => {
    const identity = attemptIdentity({ callKind: "answer", callOrdinal: 0,
      campaignRootSha256: d("1"), questionDigestSha256: d("2"), questionId: "q-1",
      repetition: 1 });
    const decision = { answerComplete: true, claims: [{ abstentionCorrect: true,
      citationEntailed: true, claimFactual: true, claimId: "c-1", claimSupported: true,
      matchedGoldClaimId: "g-1" }], outcomeDigestSha256: d("3"), questionId: "q-1" };
    const authority = (keyId: string, selected = decision): AdjudicationAuthorityPort => {
      const value = signer(keyId);
      return { authorityId: `authority-${keyId}`, publicKeyPem: value.publicKeyPem,
        signerKeyId: value.keyId,
        adjudicate: vi.fn(async (request: Parameters<AdjudicationAuthorityPort["adjudicate"]>[0]) =>
          value.signed({ attemptId: request.attemptId,
          decision: selected, decisionDigestSha256: sha256(selected),
          encryptedEvidenceSha256: request.encryptedEvidenceSha256,
          firstDecisionDigestSha256: request.firstDecisionDigestSha256,
          outcomeDigestSha256: request.outcomeDigestSha256, questionId: request.questionId,
          secondDecisionDigestSha256: request.secondDecisionDigestSha256 })) };
    };
    const first = authority("one"); const second = authority("two");
    const resolver = authority("three");
    const vault = { reconstruct: vi.fn(async () => ({ encryptedEvidenceSha256: d("4"),
      outcomeDigestSha256: d("3") })) };
    const agreed = await adjudicateOutcome({ attempt: identity, first,
      rawOutcomeEnvelopeSha256: d("5"), resolver, second, vault });
    expect(agreed.resolverReceiptSha256).toBeNull();
    const disagreement = authority("different", { ...decision, answerComplete: false });
    const resolved = await adjudicateOutcome({ attempt: identity, first,
      rawOutcomeEnvelopeSha256: d("5"), resolver, second: disagreement, vault });
    expect(resolved.resolverReceiptSha256).toMatch(/^[a-f0-9]{64}$/u);
    const impersonator = { ...authority("alias"), authorityId: "another-role",
      signerKeyId: first.signerKeyId, publicKeyPem: first.publicKeyPem };
    await expect(adjudicateOutcome({ attempt: identity, first, rawOutcomeEnvelopeSha256: d("5"),
      resolver, second: impersonator, vault })).rejects.toThrow(/cryptographically independent/u);
    const foreignQuestion = authority("foreign", { ...decision, questionId: "q-foreign" });
    await expect(adjudicateOutcome({ attempt: identity, first: foreignQuestion,
      rawOutcomeEnvelopeSha256: d("5"), resolver, second, vault })).rejects
      .toThrow(/exact raw evidence/u);
  });
});

describe("production quality campaign reporting", () => {
  it("requires an exact retained inventory and protects authoritative source kinds", () => {
    const kinds = ["capability_request", "capability_response", "retrieval_request",
      "retrieval_response", "evidence", "answer_request", "answer_response", "raw_outcome",
      "adjudication_input", "adjudicator_1_result", "adjudicator_2_result",
      "final_adjudication"] as const;
    const outcomes: ExpectedOutcomeInventory[] = Array.from({ length: 720 }, (_, index) => {
      const outcome = { attemptId: `attempt-${index}`, questionId: `q-${index % 240}`,
        repetition: (Math.floor(index / 240) + 1) as 1 | 2 | 3,
        resolverRequired: index === 0 };
      const expectedKinds = outcome.resolverRequired ? [...kinds, "resolver_result" as const] : kinds;
      return { ...outcome, artifactBindingSha256ByKind: Object.fromEntries(expectedKinds.map(
        (kind) => [kind, retainedArtifact(outcome, kind).artifactBindingSha256])) };
    });
    const artifacts: RetainedArtifact[] = outcomes.flatMap((outcome) => [
      ...kinds.map((kind) => retainedArtifact(outcome, kind)),
      ...(outcome.resolverRequired ? [retainedArtifact(outcome, "resolver_result")] : []),
    ]);
    expect(verifyExactRetentionInventory({ artifacts, campaignByteCeiling: artifacts.length,
      expectedOutcomes: outcomes }).artifactCount).toBe(8641);
    expect(() => verifyExactRetentionInventory({ artifacts: artifacts.slice(1),
      campaignByteCeiling: artifacts.length, expectedOutcomes: outcomes })).toThrow(/missing/u);
    expect(() => verifyExactRetentionInventory({ artifacts: artifacts.map((artifact, index) =>
      index === 0 ? { ...artifact, questionId: "substituted" } : artifact),
    campaignByteCeiling: artifacts.length, expectedOutcomes: outcomes })).toThrow(/corruption/u);
    expect(() => verifyExactRetentionInventory({ artifacts: artifacts.map((artifact, index) =>
      index === 1 ? { ...artifact, envelopeSha256: artifacts[0]!.envelopeSha256 } : artifact),
    campaignByteCeiling: artifacts.length, expectedOutcomes: outcomes })).toThrow(/corruption/u);
    expect(() => createCleanupManifest({ campaignRootSha256: d("1"), targets: [{ artifactId: "x",
      kind: "original_craig_recording" as never }] })).toThrow(/unsafe/u);
    const campaignRootSha256 = d("6"); const inventorySha256 = d("4");
    const rootBindingSha256 = d("5");
    const passes = [1, 2, 3].map((repetition) => {
      const repetitionIdentitySha256 = sha256({ campaignRootSha256, repetition,
        rootBindingSha256, schemaVersion:
        "meeting_knowledge.semantic_quality_repetition_identity.v1" });
      const metricsSha256 = d(String(repetition));
      return { campaignRootSha256, inventorySha256,
        metricsBindingSha256: sha256({ campaignRootSha256, inventorySha256, metricsSha256,
          outcomeCount: 240, repetition, repetitionIdentitySha256, rootBindingSha256,
          schemaVersion: "meeting_knowledge.semantic_quality_repetition_pass.v1",
          thresholdsPassed: true }), metricsSha256, outcomeCount: 240,
        repetition: repetition as 1 | 2 | 3, repetitionIdentitySha256, rootBindingSha256,
        thresholdsPassed: true };
    });
    const finalInput = { campaignRootSha256, cleanupReceiptSha256: d("1"),
      independentRepetitionPasses: passes, inventorySha256, outcomeCount: 720,
      rootBindingSha256 };
    expect(admitFinalCampaign(finalInput).qualified).toBe(true);
    for (const independentRepetitionPasses of [passes.slice(0, 2),
      passes.map((pass, index) => index === 0 ? { ...pass, thresholdsPassed: false } : pass),
      [passes[0]!, passes[0]!, passes[2]!], passes.map((pass, index) => index === 0 ?
        { ...pass, outcomeCount: 239 } : pass)]) {
      expect(() => admitFinalCampaign({ ...finalInput, independentRepetitionPasses }))
        .toThrow();
    }
  });

  it("enforces isolated 30-question holdout and non-qualifying report", () => {
    const questions: CampaignQuestion[] = Array.from({ length: 30 }, (_, index) => ({ locale: "en",
      questionDigestSha256: index.toString(16).padStart(64, "0"), questionId: `h-${index}`,
      rubricDigestSha256: d("a"), source: "independent_review" }));
    const mainSigner = signer("main-proof"); const holdoutSigner = signer("holdout-auth");
    const main = { loadedLocatorDigests: [d("b")], loadedQuestionDigests: [d("c")],
      mainInputRootSha256: d("1"), mainReleaseRootSha256: d("2"),
      schemaVersion: "meeting_knowledge.semantic_quality_main_input_proof.v1",
      tuningCorpusSha256: d("3") };
    const holdoutLocatorDigests = [d("7")];
    const authorization = { holdoutLocatorSetSha256: sha256(holdoutLocatorDigests),
      holdoutQuestionSetSha256: sha256(questions), holdoutRootSha256: d("5"),
      keyNamespace: "holdout:campaign-1", mainInputRootSha256: d("1"),
      mainReleaseRootSha256: d("2"), questionReceiptSha256: d("6"),
      schemaVersion: "meeting_knowledge.semantic_quality_holdout_authorization.v1" };
    const admittedInput = { authorization: holdoutSigner.signed(authorization),
      authorizationAuthority: holdoutSigner, holdoutLocatorDigests,
      main: mainSigner.signed(main), mainAuthority: mainSigner, questions };
    expect(admitIsolatedHoldout(admittedInput).questions).toHaveLength(30);
    expect(() => admitIsolatedHoldout({ ...admittedInput,
      holdoutLocatorDigests: [d("b")] })).toThrow(/disjoint/u);
    expect(() => admitIsolatedHoldout({ ...admittedInput,
      authorizationAuthority: { ...holdoutSigner, publicKeyPem: mainSigner.publicKeyPem } }))
      .toThrow(/cryptographically independent/u);
    expect(createHoldoutReport({ cleanupReceiptSha256: d("1"), holdoutRootSha256: d("2"),
      outcomeCount: 30, reportMetricsSha256: d("3") }).affectsMainQualification).toBe(false);
  });

  it("emits create-only safe operator status and exit semantics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quality-cli-"));
    const phase = join(directory, "phase.json"); const status = join(directory, "status.json");
    await writeFile(phase, canonicalJson({ payload: {}, schemaVersion: "phase.v1" }));
    expect(await runQualityCampaignOperatorCli({ argv: ["execute", phase], handlers: {
      run: async ({ command }) => ({ blockers: ["authorization_missing"], command,
        receipt: { counters: { outcomeCount: 240 }, digests: {}, errorCode: null },
        status: "paused" }) }, statusReceiptPath: status })).toBe(20);
    expect((await readFile(status, "utf8"))).not.toContain("question");
    expect(await runQualityCampaignOperatorCli({ argv: ["execute", phase], handlers: {
      run: async ({ command }) => ({ blockers: [], command,
        receipt: { counters: {}, digests: {}, errorCode: null }, status: "completed" }) },
    statusReceiptPath: status })).toBe(1);

    const secret = "PRIVATE question answer transcript provider-body /secret/path";
    for (const [index, run] of [
      async ({ command }: { command: string }) => ({ blockers: [secret], command,
        receipt: { counters: {}, digests: {}, errorCode: null }, status: "paused" }),
      async ({ command }: { command: string }) => ({ blockers: [], command,
        receipt: { counters: { [secret]: 1 }, digests: {}, errorCode: null },
        status: "completed" }),
      async ({ command }: { command: string }) => ({ blockers: [], command,
        receipt: { counters: { outcomeCount: 1_000_000_000_001 }, digests: {}, errorCode: null },
        status: "completed" }),
      async ({ command }: { command: string }) => ({ blockers: [], command,
        receipt: { counters: {}, digests: { campaignRootSha256: secret }, errorCode: null },
        status: "completed" }),
      async ({ command }: { command: string }) => ({ blockers: [], command,
        receipt: { counters: {}, digests: {}, errorCode: secret }, status: "failed" }),
    ].entries()) {
      const unsafeStatus = join(directory, `unsafe-${index}.json`); const lines: string[] = [];
      expect(await runQualityCampaignOperatorCli({ argv: ["execute", phase], handlers: {
        run: run as never }, statusReceiptPath: unsafeStatus,
      writeSafeLine: (line) => {lines.push(line);} })).toBe(1);
      expect(lines.join("\n")).not.toContain(secret);
      await expect(readFile(unsafeStatus, "utf8")).rejects.toThrow();
    }
  });
});
