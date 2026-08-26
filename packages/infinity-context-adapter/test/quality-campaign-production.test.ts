import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  admitFinalCampaign,
  admitIsolatedHoldout,
  admitMainCampaign,
  adjudicateOutcome,
  assertObservedRelease,
  attemptIdentity,
  CampaignEncryptedArtifactStore,
  canonicalJson,
  createCleanupManifest,
  createHoldoutReport,
  DurableAttemptJournal,
  executeReservedExchange,
  FROZEN_ANSWER_EXECUTION,
  reconstructMetrics,
  runQualityCampaignOperatorCli,
  sha256,
  verifyReleaseRoot,
  verifySpendReservations,
  type AdjudicationAuthorityPort,
  type AdjudicationRequest,
  type ArtifactStoreVerificationPort,
  type AttemptIdentity,
  type CampaignQuestion,
  type EncryptedArtifactKind,
  type QualificationOutcome,
  type QualityCampaignRelease,
  type RepetitionQualificationEvidence,
  type RetainedArtifact,
} from "../src/index.js";

const d = (character: string) => character.repeat(64);
const CAMPAIGN_ROOT = d("1");
const RELEASE_ROOT = d("2");
const SPEND = [d("3"), d("4"), d("5")] as const;

function signer(keyId: string) {
  const keys = generateKeyPairSync("ed25519");
  return {
    keyId, publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
    signed<T>(payload: T) {return Object.freeze({ payload,
      signatureBase64: sign(null, Buffer.from(canonicalJson(payload)), keys.privateKey)
        .toString("base64"), signerKeyId: keyId });},
  };
}

function sealedQuestions(count: number, source: CampaignQuestion["source"], prefix: string):
CampaignQuestion[] {
  const locales: readonly CampaignQuestion["locale"][] = ["en", "ru", "mixed"];
  return Array.from({ length: count }, (_, index) => ({ locale: locales[index % locales.length]!,
    questionDigestSha256: sha256({ index, prefix }), questionId: `${prefix}-${index}`,
    rubricDigestSha256: sha256({ index, rubric: prefix }), source }));
}

function identity(input: { readonly callKind?: AttemptIdentity["callKind"];
  readonly callOrdinal?: number; readonly question: CampaignQuestion;
  readonly repetition: 1 | 2 | 3 }): AttemptIdentity {
  return attemptIdentity({ callKind: input.callKind ?? "answer",
    callOrdinal: input.callOrdinal ?? 0, campaignRootSha256: CAMPAIGN_ROOT,
    questionDigestSha256: input.question.questionDigestSha256,
    questionId: input.question.questionId, releaseRootSha256: RELEASE_ROOT,
    repetition: input.repetition, spendReservationSha256: SPEND[input.repetition - 1]! });
}

function terminalPayload(input: { readonly identity: AttemptIdentity;
  readonly request: Uint8Array; readonly resultDigestSha256: string;
  readonly state: "terminal_failure" | "terminal_success" }) {
  return { ...input.identity, requestDigestSha256: sha256(input.request),
    resultDigestSha256: input.resultDigestSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal_payload.v4",
    state: input.state };
}

interface StoredEnvelope {
  readonly envelopeBytes: Uint8Array;
  readonly plaintext: Uint8Array;
}

function retainedArtifact(outcome: Pick<QualificationOutcome, "identity">,
  kind: EncryptedArtifactKind, stored: Map<string, StoredEnvelope>): RetainedArtifact {
  const keyId = "campaign-key";
  const plaintext = Buffer.from(`${outcome.identity.attemptId}:${kind}`);
  const plaintextSha256 = sha256(plaintext);
  const aad = { artifactKind: kind, attemptId: outcome.identity.attemptId,
    callKind: outcome.identity.callKind, callOrdinal: outcome.identity.callOrdinal,
    campaignRootSha256: outcome.identity.campaignRootSha256, keyId, plaintextSha256,
    questionDigestSha256: outcome.identity.questionDigestSha256,
    questionId: outcome.identity.questionId, releaseRootSha256:
    outcome.identity.releaseRootSha256, repetition: outcome.identity.repetition,
    schemaVersion: "meeting_knowledge.semantic_quality_artifact_aad.v3",
    spendReservationSha256: outcome.identity.spendReservationSha256 };
  const envelopeBytes = Buffer.from(canonicalJson({ aad, algorithm: "A256GCM",
    ciphertextBase64: "Y2lwaGVydGV4dA==", nonceBase64: "bm9uY2U=", tagBase64: "dGFn" }));
  const aadSha256 = sha256(aad); const envelopeSha256 = sha256(envelopeBytes);
  const keyBindingSha256 = sha256({ attemptId: outcome.identity.attemptId, keyId, kind,
    questionId: outcome.identity.questionId, repetition: outcome.identity.repetition,
    schemaVersion: "meeting_knowledge.semantic_quality_retained_key_binding.v1" });
  const storedBytes = envelopeBytes.byteLength;
  const artifactBindingSha256 = sha256({ aadSha256, attemptId: outcome.identity.attemptId,
    envelopeSha256, keyBindingSha256, keyId, kind, plaintextSha256,
    questionId: outcome.identity.questionId, repetition: outcome.identity.repetition,
    storedBytes, schemaVersion: "meeting_knowledge.semantic_quality_retained_artifact_binding.v1" });
  stored.set(envelopeSha256, { envelopeBytes, plaintext });
  return { aadSha256, artifactBindingSha256, attemptId: outcome.identity.attemptId,
    envelopeSha256, keyBindingSha256, keyId, kind, plaintextSha256,
    questionId: outcome.identity.questionId, repetition: outcome.identity.repetition,
    storedBytes };
}

const KINDS = ["capability_request", "capability_response", "retrieval_request",
  "retrieval_response", "evidence", "answer_request", "answer_response", "raw_outcome",
  "adjudication_input", "adjudicator_1_result", "adjudicator_2_result",
  "final_adjudication"] as const;

function finalFixture() {
  const questions = [...sealedQuestions(200, "automatic", "a"),
    ...sealedQuestions(40, "independent_review", "r")];
  const rootBindingSha256 = sha256({ campaignRootSha256: CAMPAIGN_ROOT,
    questionSetSha256: sha256(questions), releaseRootSha256: RELEASE_ROOT,
    schemaVersion: "meeting_knowledge.semantic_quality_final_root_binding.v1",
    spendReservationSetSha256: sha256(SPEND) });
  const stored = new Map<string, StoredEnvelope>();
  const artifacts: RetainedArtifact[] = [];
  const outcomesByRepetition = ([1, 2, 3] as const).map((repetition) =>
    questions.map((question, index): QualificationOutcome => {
      const outcomeIdentity = identity({ question, repetition });
      const resolverRequired = index === 0;
      const kinds: readonly EncryptedArtifactKind[] = resolverRequired ?
        [...KINDS, "resolver_result"] : KINDS;
      const artifactBindingSha256ByKind: Record<string, string> = {};
      for (const kind of kinds) {
        const artifact = retainedArtifact({ identity: outcomeIdentity }, kind, stored);
        artifacts.push(artifact); artifactBindingSha256ByKind[kind] = artifact.artifactBindingSha256;
      }
      return { artifactBindingSha256ByKind, campaignRootSha256: CAMPAIGN_ROOT,
        completeQuestionRecallAt5: true, finalAdjudicationSha256: sha256({ index, repetition }),
        identity: outcomeIdentity, locale: question.locale, relevantLocatorCount: 10,
        repetition, resolverRequired, retrievedRelevantLocatorCountAt5: 9,
        rootBindingSha256, source: question.source, structurePassed: true };
    }));
  const authority = signer("metrics-authority");
  const evidence = outcomesByRepetition.map((outcomes, index) => {
    const metrics = reconstructMetrics(outcomes);
    const payload: RepetitionQualificationEvidence = { campaignRootSha256: CAMPAIGN_ROOT,
      metrics, metricsSha256: sha256(metrics), outcomes, outcomesSha256: sha256(outcomes),
      releaseRootSha256: RELEASE_ROOT, repetition: (index + 1) as 1 | 2 | 3,
      rootBindingSha256, schemaVersion:
      "meeting_knowledge.semantic_quality_repetition_evidence.v2",
      spendReservationSha256: SPEND[index]!, thresholdsPassed: true };
    return authority.signed(payload);
  });
  const cleanupAuthority = signer("cleanup-authority");
  const cleanupManifest = createCleanupManifest({ campaignRootSha256: CAMPAIGN_ROOT,
    targets: [{ artifactId: "derived-1", kind: "derived_index" },
      { artifactId: "prompt-1", kind: "temporary_prompt" }] });
  const absentArtifactIds = cleanupManifest.targets.map(({ artifactId }) => artifactId).toSorted();
  const cleanupReceipt = cleanupAuthority.signed({ absentArtifactIds,
    absentArtifactIdsSha256: sha256(absentArtifactIds), campaignRootSha256: CAMPAIGN_ROOT,
    cleanupManifestSha256: sha256(cleanupManifest), protectedSourcePreserved: true,
    schemaVersion: "meeting_knowledge.semantic_quality_cleanup_absence.v3" });
  const store: ArtifactStoreVerificationPort = { openVerified: vi.fn(async (request: {
    readonly envelopeSha256: string; readonly keyId: string }) =>
  stored.get(request.envelopeSha256) ?? null) };
  const input = { artifactStore: store, artifacts, campaignByteCeiling:
    artifacts.reduce((total, artifact) => total + artifact.storedBytes, 0),
    campaignRootSha256: CAMPAIGN_ROOT, cleanupAuthority, cleanupManifest, cleanupReceipt,
    questions, releaseRootSha256: RELEASE_ROOT, repetitionAuthority: authority,
    repetitionEvidence: evidence, rootBindingSha256,
    spendReservationSha256ByRepetition: SPEND } as const;
  return { authority, cleanupAuthority, evidence, input, outcomesByRepetition, stored, store };
}

describe("production quality campaign authority", () => {
  it("admits exact sealed inputs and rejects a foreign locator-authority schema", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quality-admission-"));
    const custody = signer("custody"); const reviewer1 = signer("reviewer-1");
    const reviewer2 = signer("reviewer-2");
    const automatic = sealedQuestions(200, "automatic", "a");
    const reviewed = sealedQuestions(40, "independent_review", "r");
    const all = [...automatic, ...reviewed];
    const sourceDigestSha256 = d("6"); const corpusDigestSha256 = d("7");
    const reviewerDigestSha256 = d("8");
    const acceptance = custody.signed({ corpusDigestSha256, purpose: "custody_only",
      reviewerDigestSha256, schemaVersion: "meeting_knowledge.semantic_quality_acceptance.v1",
      sourceDigestSha256 });
    const authorization = custody.signed({ acceptanceReceiptSha256: sha256(acceptance),
      authorizedProviderExecution: true, corpusDigestSha256,
      expiresAtEpochMs: Date.now() + 60_000, releaseRootSha256: RELEASE_ROOT,
      schemaVersion: "meeting_knowledge.semantic_quality_execution_authorization.v1" });
    const reviewPayload = { corpusDigestSha256, questionSetSha256: sha256(all),
      reviewerDigestSha256, rubricSetSha256: sha256(all.map(({ questionId,
        rubricDigestSha256 }) => ({ questionId, rubricDigestSha256 }))),
      schemaVersion: "meeting_knowledge.semantic_quality_question_review.v1" };
    const authorityPayload = { entriesSha256: d("9"), releaseRootSha256: RELEASE_ROOT,
      schemaVersion: "meeting_knowledge.semantic_quality_locator_authority.v1",
      snapshotSha256: d("a") };
    const files: Record<string, unknown> = { "acceptance.json": acceptance,
      "authorization.json": authorization, "automatic.json": automatic,
      "forbidden.json": custody.signed(authorityPayload), "mapping.json":
      custody.signed(authorityPayload), "review-1.json": reviewer1.signed(reviewPayload),
      "review-2.json": reviewer2.signed(reviewPayload), "reviewed.json": reviewed };
    const writeInputs = async () => {
      for (const [path, value] of Object.entries(files)) {
        await writeFile(join(directory, path), canonicalJson(value));
      }
      return await Promise.all(Object.keys(files).map(async (path) => ({ path,
        sha256: sha256(await readFile(join(directory, path))) })));
    };
    const manifestPath = join(directory, "InputManifest.v4.json");
    const writeManifest = async () => {
      const checksumInventory = await writeInputs();
      await writeFile(manifestPath, canonicalJson({ acceptanceReceiptPath: "acceptance.json",
        checksumInventory, corpusDigestSha256, executionAuthorizationPath: "authorization.json",
        forbiddenLocatorManifestPath: "forbidden.json", independentReviewQuestionsPath:
        "reviewed.json", questionReviewReceiptPaths: ["review-1.json", "review-2.json"],
        reviewerDigestSha256, schemaVersion: "meeting_knowledge.semantic_quality_input_manifest.v4",
        sealedAutomaticQuestionsPath: "automatic.json", sourceDigestSha256,
        turnToBlockManifestPath: "mapping.json" }));
    };
    await writeManifest();
    expect((await admitMainCampaign({ authority: custody, manifestPath,
      releaseRootSha256: RELEASE_ROOT, reviewerAuthorities: [reviewer1, reviewer2] })).questions)
      .toHaveLength(240);
    files["mapping.json"] = custody.signed({ ...authorityPayload,
      schemaVersion: "foreign.locator.authority.schema" });
    await writeManifest();
    await expect(admitMainCampaign({ authority: custody, manifestPath,
      releaseRootSha256: RELEASE_ROOT, reviewerAuthorities: [reviewer1, reviewer2] }))
      .rejects.toThrow(/schema version/u);
  });

  it("pins release provenance and produces exact spend-reservation digests", () => {
    const authority = signer("release");
    const release: QualityCampaignRelease = { answerImageSha256: d("1"),
      answerProcessIdentitySha256: d("2"), answerReleaseSha256: d("3"),
      discordCommitSha256: d("4"), discordImageSha256: d("5"), discordReleaseSha256: d("6"),
      infinityCapabilitySha256: d("7"), infinityCommitSha256: d("8"),
      infinityImageSha256: d("9"), infinityProfileSha256: d("a"),
      infinityReleaseSha256: d("b"), mapperSha256: d("c"), ...FROZEN_ANSWER_EXECUTION,
      policySha256: d("d"), promptSha256: d("e"), sdkArchiveSha256: d("f"),
      tokenizerSha256: d("0") };
    expect(verifyReleaseRoot({ authorityPublicKeyPem: authority.publicKeyPem,
      document: authority.signed(release) }).release).toEqual(release);
    expect(() => {assertObservedRelease(release, { ...release, promptSha256: d("0") });})
      .toThrow(/drifted/u);
    const spendAuthority = signer("spend");
    const base = { campaignRootSha256: CAMPAIGN_ROOT, expiresAtEpochMs: 2_000, maxCalls: 480,
      maxEncryptedBytes: 50_000_000, maxTokens: 500_000, ...FROZEN_ANSWER_EXECUTION,
      provider: "external-authority", releaseRootSha256: RELEASE_ROOT };
    const receipts = [1, 2, 3].map((repetition) => spendAuthority.signed({ ...base, repetition }));
    const verified = verifySpendReservations({ authorityKeyId: spendAuthority.keyId,
      authorityPublicKeyPem: spendAuthority.publicKeyPem, campaignRootSha256: CAMPAIGN_ROOT,
      nowEpochMs: 1_000, releaseRootSha256: RELEASE_ROOT, reservations: receipts });
    expect(verified.map(({ spendReservationSha256 }) => spendReservationSha256))
      .toEqual(receipts.map((receipt) => sha256(receipt)));
  });

  it("binds release and spend through attempt, request, reservation, and terminal replay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quality-journal-"));
    const authority = signer("provider"); const question = sealedQuestions(1, "automatic", "q")[0]!;
    const attempt = identity({ question, repetition: 1 });
    const journal = new DurableAttemptJournal(directory, authority); const request = Buffer.from("bounded");
    const success = { exchange: vi.fn(async () => ({ effect: "certain_success" as const,
      resultDigestSha256: d("6"), signedResult: authority.signed(terminalPayload({ identity: attempt,
        request, resultDigestSha256: d("6"), state: "terminal_success" })) })) };
    const exact = { campaignRootSha256: CAMPAIGN_ROOT, identity: attempt, journal, port: success,
      releaseRootSha256: RELEASE_ROOT, request, spendReservationSha256: SPEND[0] };
    expect(await executeReservedExchange(exact)).toBe("terminal_success");
    expect(await executeReservedExchange(exact)).toBe("terminal_success");
    expect(success.exchange).toHaveBeenCalledTimes(1);
    expect(await executeReservedExchange({ ...exact, request: Buffer.from("substitution") }))
      .toBe("blocked_evidence");
    await expect(executeReservedExchange({ ...exact, releaseRootSha256: d("7") }))
      .rejects.toThrow(/reconstruct/u);
    await expect(executeReservedExchange({ ...exact, spendReservationSha256: d("8") }))
      .rejects.toThrow(/reconstruct/u);
    expect(success.exchange).toHaveBeenCalledTimes(1);

    for (const mutation of [{ releaseRootSha256: d("7") },
      { spendReservationSha256: d("8") }]) {
      const mutationDirectory = await mkdtemp(join(tmpdir(), "quality-terminal-mutation-"));
      const mutationJournal = new DurableAttemptJournal(mutationDirectory, authority);
      const port = { exchange: vi.fn(async () => ({ effect: "certain_success" as const,
        resultDigestSha256: d("6"), signedResult: authority.signed({
          ...terminalPayload({ identity: attempt, request, resultDigestSha256: d("6"),
            state: "terminal_success" }), ...mutation }) })) };
      const input = { ...exact, journal: mutationJournal, port };
      expect(await executeReservedExchange(input)).toBe("blocked_evidence");
      expect(await executeReservedExchange(input)).toBe("blocked_evidence");
      expect(port.exchange).toHaveBeenCalledTimes(1);
    }
  });

  it("reconstructs artifact identity before encryption and verifies stored AAD", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quality-artifacts-"));
    const question = sealedQuestions(1, "automatic", "q")[0]!;
    const attempt = identity({ question, repetition: 1 });
    const store = new CampaignEncryptedArtifactStore(directory, 100_000);
    const base = { artifactKind: "answer_response" as const, campaignRootSha256: CAMPAIGN_ROOT,
      identity: attempt, key: Buffer.alloc(32, 7), keyId: "key-1", plaintext: Buffer.from("secret"),
      releaseRootSha256: RELEASE_ROOT, spendReservationSha256: SPEND[0] };
    await expect(store.seal({ ...base, campaignRootSha256: d("9") }))
      .rejects.toThrow(/reconstruct/u);
    expect(await readdir(directory)).toEqual([]);
    const receipt = await store.seal(base);
    const envelopeBytes = await readFile(join(directory, `${receipt.envelopeSha256}.enc.json`));
    const envelope = JSON.parse(envelopeBytes.toString("utf8")) as { aad: AttemptIdentity };
    expect(envelope.aad.releaseRootSha256).toBe(RELEASE_ROOT);
    expect(envelope.aad.spendReservationSha256).toBe(SPEND[0]);
  });

  it("gives the resolver both complete signed conflicting decisions and verifies its binding", async () => {
    const question = sealedQuestions(1, "automatic", "q")[0]!;
    const attempt = identity({ question, repetition: 1 });
    const decision = { answerComplete: true, claims: [{ abstentionCorrect: true,
      citationEntailed: true, claimFactual: true, claimId: "c-1", claimSupported: true,
      matchedGoldClaimId: "g-1" }], outcomeDigestSha256: d("6"), questionId: question.questionId };
    const resolverRequests: AdjudicationRequest[] = [];
    const authority = (keyId: string, selected = decision,
      corruptResolverBinding = false): AdjudicationAuthorityPort => {
      const value = signer(keyId);
      return { authorityId: `authority-${keyId}`, publicKeyPem: value.publicKeyPem,
        signerKeyId: value.keyId, adjudicate: vi.fn(async (request: AdjudicationRequest) => {
          if (keyId === "three") {resolverRequests.push(request);}
          return value.signed({
          attemptId: request.attemptId, decision: selected, decisionDigestSha256: sha256(selected),
          encryptedEvidenceSha256: request.encryptedEvidenceSha256,
          firstDecisionDigestSha256: request.firstDecisionDigestSha256,
          outcomeDigestSha256: request.outcomeDigestSha256, questionId: request.questionId,
          resolverBindingSha256: corruptResolverBinding ? d("f") : request.resolverBindingSha256,
          secondDecisionDigestSha256: request.secondDecisionDigestSha256 });
        }) };
    };
    const first = authority("one");
    const second = authority("two", { ...decision, answerComplete: false });
    const resolver = authority("three");
    const result = await adjudicateOutcome({ attempt, first, rawOutcomeEnvelopeSha256: d("7"),
      resolver, second, vault: { reconstruct: async () => ({ encryptedEvidenceSha256: d("8"),
        outcomeDigestSha256: d("6") }) } });
    expect(result.resolverReceiptSha256).toMatch(/^[a-f0-9]{64}$/u);
    const request = resolverRequests[0]!;
    expect(request.firstDecisionReceipt?.payload.decision.answerComplete).toBe(true);
    expect(request.secondDecisionReceipt?.payload.decision.answerComplete).toBe(false);
    expect(request.resolverBindingSha256).toMatch(/^[a-f0-9]{64}$/u);
    await expect(adjudicateOutcome({ attempt, first, rawOutcomeEnvelopeSha256: d("7"),
      resolver: authority("four", decision, true), second,
      vault: { reconstruct: async () => ({ encryptedEvidenceSha256: d("8"),
        outcomeDigestSha256: d("6") }) } })).rejects.toThrow(/exact raw evidence/u);
  });
});

describe("production quality campaign final evidence", () => {
  it("qualifies only authenticated 3x240 outcomes, real envelopes, exact metrics, and exact cleanup", async () => {
    const fixture = finalFixture();
    expect((await admitFinalCampaign(fixture.input)).qualified).toBe(true);

    const firstPayload = fixture.evidence[0]!.payload;
    const failedOutcomes = firstPayload.outcomes.map((outcome, index) => index < 30 ?
      { ...outcome, completeQuestionRecallAt5: false, retrievedRelevantLocatorCountAt5: 0 } :
      outcome);
    const failedMetrics = reconstructMetrics(failedOutcomes);
    const failed = fixture.authority.signed({ ...firstPayload, metrics: failedMetrics,
      metricsSha256: sha256(failedMetrics), outcomes: failedOutcomes,
      outcomesSha256: sha256(failedOutcomes), thresholdsPassed: false });
    await expect(admitFinalCampaign({ ...fixture.input,
      repetitionEvidence: [failed, fixture.evidence[1]!, fixture.evidence[2]!] }))
      .rejects.toThrow(/binding or structure/u);

    for (const payload of [
      { ...firstPayload, outcomes: firstPayload.outcomes.slice(1),
        outcomesSha256: sha256(firstPayload.outcomes.slice(1)) },
      { ...firstPayload, metricsSha256: d("f") },
      { ...firstPayload, rootBindingSha256: d("f") },
    ]) {
      await expect(admitFinalCampaign({ ...fixture.input, repetitionEvidence:
        [fixture.authority.signed(payload), fixture.evidence[1]!, fixture.evidence[2]!] }))
        .rejects.toThrow();
    }

    const firstEnvelope = fixture.input.artifacts[0]!.envelopeSha256;
    const storedEnvelope = fixture.stored.get(firstEnvelope)!;
    fixture.stored.delete(firstEnvelope);
    await expect(admitFinalCampaign(fixture.input)).rejects.toThrow(/does not exist/u);
    fixture.stored.set(firstEnvelope, storedEnvelope);

    const unrelated = fixture.cleanupAuthority.signed({ absentArtifactIds: ["unrelated"],
      absentArtifactIdsSha256: sha256(["unrelated"]), campaignRootSha256: CAMPAIGN_ROOT,
      cleanupManifestSha256: sha256(fixture.input.cleanupManifest),
      protectedSourcePreserved: true,
      schemaVersion: "meeting_knowledge.semantic_quality_cleanup_absence.v3" });
    await expect(admitFinalCampaign({ ...fixture.input, cleanupReceipt: unrelated }))
      .rejects.toThrow(/authoritative/u);
  }, 30_000);

  it("rejects retention receipts for nonexistent or foreign-AAD envelopes", async () => {
    const fixture = finalFixture();
    const artifacts = [...fixture.input.artifacts];
    const artifact = artifacts[0]!; const stored = fixture.stored.get(artifact.envelopeSha256)!;
    const envelope = JSON.parse(Buffer.from(stored.envelopeBytes).toString("utf8")) as {
      aad: Record<string, unknown> };
    envelope.aad.questionId = "foreign-question";
    const foreignBytes = Buffer.from(canonicalJson(envelope));
    const foreignEnvelopeSha256 = sha256(foreignBytes);
    fixture.stored.set(foreignEnvelopeSha256, { ...stored, envelopeBytes: foreignBytes });
    const keyBindingSha256 = artifact.keyBindingSha256;
    const foreignBinding = sha256({ aadSha256: sha256(envelope.aad),
      attemptId: artifact.attemptId, envelopeSha256: foreignEnvelopeSha256, keyBindingSha256,
      keyId: artifact.keyId, kind: artifact.kind, plaintextSha256: artifact.plaintextSha256,
      questionId: artifact.questionId, repetition: artifact.repetition,
      storedBytes: foreignBytes.byteLength,
      schemaVersion: "meeting_knowledge.semantic_quality_retained_artifact_binding.v1" });
    artifacts[0] = { ...artifact, aadSha256: sha256(envelope.aad),
      artifactBindingSha256: foreignBinding, envelopeSha256: foreignEnvelopeSha256,
      storedBytes: foreignBytes.byteLength };
    const firstPayload = fixture.evidence[0]!.payload;
    const outcomes = firstPayload.outcomes.map((outcome, index) => index === 0 ? {
      ...outcome, artifactBindingSha256ByKind: { ...outcome.artifactBindingSha256ByKind,
        [artifact.kind]: foreignBinding } } : outcome);
    const receipt = fixture.authority.signed({ ...firstPayload, outcomes,
      outcomesSha256: sha256(outcomes) });
    await expect(admitFinalCampaign({ ...fixture.input, artifacts,
      repetitionEvidence: [receipt, fixture.evidence[1]!, fixture.evidence[2]!] }))
      .rejects.toThrow(/AAD identity/u);
  }, 30_000);

  it("derives the signed holdout root, exact questions, locator set, and one-use namespace", () => {
    const questions = sealedQuestions(30, "independent_review", "h");
    const mainSigner = signer("main-proof"); const holdoutSigner = signer("holdout-auth");
    const questionSigner = signer("holdout-reviewer");
    const main = { loadedLocatorDigests: [d("a")], loadedQuestionDigests: [d("b")],
      mainInputRootSha256: d("6"), mainReleaseRootSha256: RELEASE_ROOT,
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
      authorizationAuthority: holdoutSigner, holdoutLocatorDigests,
      main: mainSigner.signed(main), mainAuthority: mainSigner, questionAuthority: questionSigner,
      questionReceipt, questions };
    expect(admitIsolatedHoldout(input).questions).toHaveLength(30);
    for (const mutation of [
      { ...authorization, holdoutRootSha256: d("e") },
      { ...authorization, keyNamespace: "holdout:reusable" },
    ]) {
      expect(() => admitIsolatedHoldout({ ...input,
        authorization: holdoutSigner.signed(mutation) })).toThrow(/exact isolated/u);
    }
    const duplicate = questions.map((question, index) => index === 1 ?
      { ...question, questionId: questions[0]!.questionId } : question);
    expect(() => admitIsolatedHoldout({ ...input, questions: duplicate })).toThrow();
    for (const invalidQuestions of [
      questions.map((question, index) => index === 0 ?
        { ...question, locale: "foreign" as never } : question),
      questions.map((question, index) => index === 0 ?
        { ...question, questionDigestSha256: "invalid" } : question),
    ]) {
      expect(() => admitIsolatedHoldout({ ...input, questions: invalidQuestions })).toThrow();
    }
    expect(() => admitIsolatedHoldout({ ...input, holdoutLocatorDigests: [d("c"), d("c")] }))
      .toThrow(/disjoint/u);
    expect(createHoldoutReport({ cleanupReceiptSha256: d("1"), holdoutRootSha256,
      outcomeCount: 30, reportMetricsSha256: d("2") }).affectsMainQualification).toBe(false);
  });

  it("rejects arbitrary public handler status without echoing it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quality-cli-"));
    const phase = join(directory, "phase.json"); const status = join(directory, "status.json");
    await writeFile(phase, canonicalJson({ payload: {}, schemaVersion: "phase.v1" }));
    const secret = "SYNTHETIC_PRIVATE_HANDLER_TEXT"; const lines: string[] = [];
    expect(await runQualityCampaignOperatorCli({ argv: ["execute", phase], handlers: {
      run: async ({ command }) => ({ blockers: ["authorization_missing"], command,
        receipt: { counters: {}, digests: {}, errorCode: null }, status: secret as never }) },
    statusReceiptPath: status, writeSafeLine: (line) => {lines.push(line);} })).toBe(1);
    expect(lines.join("\n")).not.toContain(secret);
    await expect(readFile(status, "utf8")).rejects.toThrow();
  });
});
