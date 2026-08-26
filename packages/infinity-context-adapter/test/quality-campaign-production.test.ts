import { createCipheriv, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  admitFinalCampaign, admitIsolatedHoldout, admitMainCampaign, adjudicateOutcome,
  artifactAttemptIdentity, assertObservedRelease, attemptIdentity, CampaignEncryptedArtifactStore,
  canonicalJson, createHoldoutReport, DurableAttemptJournal, executeReservedExchange,
  FROZEN_ANSWER_EXECUTION, publicKeyFingerprintSha256, reconstructMetrics,
  runQualityCampaignOperatorCli, sha256, verifyReleaseRoot, verifySpendReservation,
  type AdjudicationRequest, type ArtifactCustodyPort,
  type AttemptIdentity, type CampaignQuestion, type EncryptedArtifactKind,
  type PinnedReleaseDocument, type QualificationOutcome, type QualityCampaignRelease,
  type RepetitionQualificationEvidence, type RetainedArtifact,
} from "../src/quality-campaign/index.js";

const d = (character: string) => character.repeat(64);
const CAMPAIGN_ROOT = d("1");
const ARTIFACT_KEY = Buffer.alloc(32, 7);
const ARTIFACT_KEY_CUSTODY = d("c");
const PROVIDER = "pinned-provider";

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

function sealedQuestions(count: number, source: CampaignQuestion["source"], prefix: string):
CampaignQuestion[] {
  const locales: readonly CampaignQuestion["locale"][] = ["en", "ru", "mixed"];
  return Array.from({ length: count }, (_, index) => ({ locale: locales[index % locales.length]!,
    questionDigestSha256: sha256({ index, prefix }), questionId: `${prefix}-${index}`,
    rubricDigestSha256: sha256({ index, rubric: prefix }), source }));
}

function releaseFixture(targetInventoryAuthority: TestSigner) {
  const authority = signer("release-authority");
  const release: QualityCampaignRelease = { answerImageSha256: d("1"),
    answerProcessIdentitySha256: d("2"), answerReleaseSha256: d("3"),
    artifactKeyCustodySha256: ARTIFACT_KEY_CUSTODY, discordCommitSha256: d("4"),
    discordImageSha256: d("5"), discordReleaseSha256: d("6"),
    infinityCapabilitySha256: d("7"), infinityCommitSha256: d("8"),
    infinityImageSha256: d("9"), infinityProfileSha256: d("a"),
    infinityReleaseSha256: d("b"), mapperSha256: d("c"), ...FROZEN_ANSWER_EXECUTION,
    policySha256: d("d"), promptSha256: d("e"), sdkArchiveSha256: d("f"),
    targetInventoryAuthorityKeySha256: publicKeyFingerprintSha256(
      targetInventoryAuthority.publicKeyPem, "target inventory authority"),
    tokenizerSha256: d("0") };
  const document = authority.signed(release);
  const pinned: PinnedReleaseDocument = { authorityKeyId: authority.keyId,
    authorityPublicKeyPem: authority.publicKeyPem, document, releaseRootSha256: sha256(document) };
  return { authority, document, pinned, release, releaseRootSha256: sha256(document) };
}

function spendReceipt(input: { readonly authority: TestSigner; readonly releaseRootSha256: string;
  readonly repetition: 1 | 2 | 3; readonly overrides?: Record<string, unknown> }) {
  return input.authority.signed({ allowedCallKinds: ["answer", "retrieval", "capability",
    "adjudicator_1", "adjudicator_2", "resolver"], campaignRootSha256: CAMPAIGN_ROOT,
  expiresAtEpochMs: 10_000, maxCalls: 2_000, maxEncryptedBytes: 100_000_000,
  maxTokens: 5_000_000, ...FROZEN_ANSWER_EXECUTION, provider: PROVIDER,
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

function custody(stored: ReadonlyMap<string, StoredEnvelope>, key = ARTIFACT_KEY):
ArtifactCustodyPort {
  return { loadKey: vi.fn(async () => ({ key, keyCustodySha256: ARTIFACT_KEY_CUSTODY })),
    readEnvelope: vi.fn(async ({ envelopeSha256 }: { readonly envelopeSha256: string }) =>
      stored.get(envelopeSha256)?.envelopeBytes ?? null) };
}

function finalFixture() {
  const targetInventoryAuthority = signer("target-inventory-authority");
  const release = releaseFixture(targetInventoryAuthority); const spendAuthority = signer("spend");
  const spends = ([1, 2, 3] as const).map((repetition) => spendReceipt({ authority:
    spendAuthority, releaseRootSha256: release.releaseRootSha256, repetition }));
  const spendDigests = spends.map((receipt) => sha256(receipt)) as [string, string, string];
  const questions = [...sealedQuestions(200, "automatic", "a"),
    ...sealedQuestions(40, "independent_review", "r")];
  const authorizedLocatorIds = Array.from({ length: 10 }, (_, index) => `locator-${index}`);
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
      const finalPlaintext = Buffer.from(canonicalJson({ attemptId: identity.attemptId,
        questionId: identity.questionId,
        schemaVersion: "meeting_knowledge.semantic_quality_final_adjudication.v1" }));
      const finalAdjudicationSha256 = sha256(finalPlaintext);
      const artifactBindingSha256ByKind: Record<string, string> = {};
      const kinds: readonly EncryptedArtifactKind[] = resolverRequired ?
        [...KINDS, "resolver_result"] : KINDS;
      for (const kind of kinds) {
        const plaintext = kind === "final_adjudication" ? finalPlaintext :
          Buffer.from(`${identity.attemptId}:${kind}`);
        const artifact = encryptedArtifact(identity, kind, plaintext, stored);
        artifacts.push(artifact); artifactBindingSha256ByKind[kind] = artifact.artifactBindingSha256;
      }
      const turnId = `turn-${repetition}-${index}`; const claimId = `claim-${repetition}-${index}`;
      return { abstention: { expected: false, observed: false }, artifactBindingSha256ByKind,
        campaignRootSha256: CAMPAIGN_ROOT,
        citationChecks: [{ citedTurnId: turnId, claimId, entailed: true }],
        claimChecks: [{ claimId, factual: true, supported: true }], evidenceTurnIds: [turnId],
        finalAdjudicationSha256, identity, locale: question.locale,
        rankedLocatorIds: authorizedLocatorIds.slice(0, 5),
        relevantLocatorIds: authorizedLocatorIds.slice(0, 5), repetition, resolverRequired,
        rootBindingSha256, source: question.source,
        speakerTimeChecks: [{ canonicalTurnId: turnId, expectedSpeakerId: "speaker-1",
          expectedStartMs: 1_000, observedSpeakerId: "speaker-1", observedStartMs: 1_050,
          toleranceMs: 100 }], structurePassed: true };
    }));
  const repetitionAuthority = signer("metrics-authority");
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
  const cleanupAuthority = signer("cleanup-authority");
  const absentArtifactIds = manifest.targets.map(({ artifactId }) => artifactId).toSorted();
  const presentProtectedArtifactIds = manifest.protectedOriginals.map(({ artifactId }) =>
    artifactId).toSorted();
  const cleanupReceipt = cleanupAuthority.signed({ absentArtifactIds,
    absentArtifactIdsSha256: sha256(absentArtifactIds), campaignRootSha256: CAMPAIGN_ROOT,
    cleanupManifestSha256: sha256(manifest), presentProtectedArtifactIds,
    presentProtectedArtifactIdsSha256: sha256(presentProtectedArtifactIds),
    releaseRootSha256: release.releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_cleanup_absence.v4" });
  const input = { artifactCustody: custody(stored), artifacts, authorizedLocatorIds,
    campaignByteCeiling: artifacts.reduce((total, artifact) => total + artifact.storedBytes, 0),
    campaignRootSha256: CAMPAIGN_ROOT, cleanupAuthority, cleanupReceipt, questions,
    release: release.pinned, repetitionAuthority, repetitionEvidence: evidence,
    rootBindingSha256, spendReservationSha256ByRepetition: spendDigests,
    targetInventoryAuthority, targetInventoryReceipt } as const;
  return { cleanupAuthority, evidence, input, outcomesByRepetition, release, repetitionAuthority,
    spendAuthority, spends, stored, targetInventoryAuthority };
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
    const custodySigner = signer("custody"); const reviewer1 = signer("reviewer-1");
    const reviewer2 = signer("reviewer-2"); const automatic = sealedQuestions(200, "automatic", "a");
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
    expect((await admitMainCampaign({ authority: custodySigner, manifestPath,
      releaseRootSha256: FINAL.release.releaseRootSha256,
      reviewerAuthorities: [reviewer1, reviewer2] })).questions).toHaveLength(240);
    files["mapping.json"] = custodySigner.signed({ ...locatorPayload,
      schemaVersion: "foreign.locator.authority.schema" });
    await writeManifest();
    await expect(admitMainCampaign({ authority: custodySigner, manifestPath,
      releaseRootSha256: FINAL.release.releaseRootSha256,
      reviewerAuthorities: [reviewer1, reviewer2] })).rejects.toThrow(/schema version/u);
  });

  it("cryptographically pins release and validates one exact spend reservation", () => {
    expect(verifyReleaseRoot({ authorityKeyId: FINAL.release.authority.keyId,
      authorityPublicKeyPem: FINAL.release.authority.publicKeyPem,
      document: FINAL.release.document }).release).toEqual(FINAL.release.release);
    expect(() => {assertObservedRelease(FINAL.release.release,
      { ...FINAL.release.release, promptSha256: d("0") });}).toThrow(/drifted/u);
    expect(verifySpendReservation({ authorityKeyId: FINAL.spendAuthority.keyId,
      authorityPublicKeyPem: FINAL.spendAuthority.publicKeyPem,
      campaignRootSha256: CAMPAIGN_ROOT, expectedRepetition: 1, nowEpochMs: 1_000,
      releaseRootSha256: FINAL.release.releaseRootSha256,
      reservation: FINAL.spends[0] }).spendReservationSha256).toBe(sha256(FINAL.spends[0]));
  });

  it("revalidates signed release, spend, expiry, provider, call, and ceilings before effect/replay", async () => {
    const providerAuthority = signer("provider-result"); const question = FINAL.input.questions[0]!;
    const attempt = FINAL.outcomesByRepetition[0]![0]!.identity; const request = Buffer.from("bounded");
    const port = { exchange: vi.fn(async () => ({ effect: "certain_success" as const,
      resultDigestSha256: d("6"), signedResult: providerAuthority.signed(terminalPayload({
        identity: attempt, request, resultDigestSha256: d("6"), state: "terminal_success" })) })) };
    const journal = new DurableAttemptJournal(await mkdtemp(join(tmpdir(), "quality-journal-")),
      providerAuthority);
    const exact = { campaignRootSha256: CAMPAIGN_ROOT,
      deadlineEpochMs: 9_000,
      effectUsage: { callsConsumed: 0, encryptedBytesConsumed: 0,
        requestedEncryptedBytes: 100, requestedTokens: 100, tokensConsumed: 0 },
      identity: attempt, journal, nowEpochMs: 1_000, port, provider: PROVIDER,
      release: FINAL.release.pinned, request, signal: new AbortController().signal,
      spendAuthority: FINAL.spendAuthority,
      spendReservation: FINAL.spends[0] };
    expect(await executeReservedExchange(exact)).toBe("terminal_success");
    expect(await executeReservedExchange(exact)).toBe("terminal_success");
    expect(port.exchange).toHaveBeenCalledTimes(1);
    await expect(executeReservedExchange({ ...exact, nowEpochMs: 11_000 })).rejects
      .toThrow(/spend reservation/u);
    expect(port.exchange).toHaveBeenCalledTimes(1);

    const invalidCases = [
      { provider: "foreign-provider" },
      { effectUsage: { ...exact.effectUsage, callsConsumed: 2_000 } },
      { effectUsage: { ...exact.effectUsage, requestedTokens: 5_000_001 } },
      { effectUsage: { ...exact.effectUsage, requestedEncryptedBytes: 100_000_001 } },
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
        "quality-blocked-")), providerAuthority);
      await expect(executeReservedExchange({ ...exact, ...mutation, journal: blockedJournal,
        port: blockedPort })).rejects.toThrow();
      expect(blockedPort.exchange).not.toHaveBeenCalled();
    }
    const forgedRelease = { ...FINAL.release.pinned, releaseRootSha256: d("f") };
    const releasePort = { exchange: vi.fn(port.exchange.getMockImplementation()) };
    await expect(executeReservedExchange({ ...exact, journal: new DurableAttemptJournal(
      await mkdtemp(join(tmpdir(), "quality-release-")), providerAuthority), port: releasePort,
      release: forgedRelease })).rejects.toThrow(/pinned release/u);
    expect(releasePort.exchange).not.toHaveBeenCalled();
    expect(question.questionId).toBe(attempt.questionId);
  });

  it("uses a closed artifact-kind call map and rejects retrieval under answer before storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quality-artifacts-"));
    const answer = FINAL.outcomesByRepetition[0]![0]!.identity;
    const store = new CampaignEncryptedArtifactStore(directory, 100_000);
    const base = { artifactKind: "retrieval_request" as const,
      campaignRootSha256: CAMPAIGN_ROOT, key: ARTIFACT_KEY, keyId: "key-1",
      plaintext: Buffer.from("secret"), releaseRootSha256: FINAL.release.releaseRootSha256,
      spendReservationSha256: answer.spendReservationSha256 };
    await expect(store.seal({ ...base, identity: answer })).rejects.toThrow(/call semantics/u);
    expect(await readdir(directory)).toEqual([]);
    const retrieval = artifactAttemptIdentity(answer, "retrieval_request");
    expect((await store.seal({ ...base, identity: retrieval })).attemptId).toBe(retrieval.attemptId);
  });

  it("validates complete adjudication identity before vault or reviewer effects", async () => {
    const attempt = FINAL.outcomesByRepetition[0]![0]!.identity;
    const decision = { answerComplete: true, claims: [{ abstentionCorrect: true,
      citationEntailed: true, claimFactual: true, claimId: "c-1", claimSupported: true,
      matchedGoldClaimId: "g-1" }], outcomeDigestSha256: d("6"),
      questionId: attempt.questionId };
    const makeAuthority = (keyId: string, selected = decision) => {
      const value = signer(keyId);
      return { authorityId: `authority-${keyId}`, publicKeyPem: value.publicKeyPem,
        signerKeyId: value.keyId, adjudicate: vi.fn(async (request: AdjudicationRequest) =>
          value.signed({ attemptId: request.attemptId, decision: selected,
            decisionDigestSha256: sha256(selected),
            encryptedEvidenceSha256: request.encryptedEvidenceSha256,
            firstDecisionDigestSha256: request.firstDecisionDigestSha256,
            outcomeDigestSha256: request.outcomeDigestSha256, questionId: request.questionId,
            resolverBindingSha256: request.resolverBindingSha256,
            secondDecisionDigestSha256: request.secondDecisionDigestSha256 })) };
    };
    const first = makeAuthority("one"); const second = makeAuthority("two",
      { ...decision, answerComplete: false });
    const resolver = makeAuthority("three"); const vault = { reconstruct: vi.fn(async () =>
      ({ encryptedEvidenceSha256: d("8"), outcomeDigestSha256: d("6") })) };
    const context = { deadlineEpochMs: 9_000, signal: new AbortController().signal };
    expect((await adjudicateOutcome({ attempt, ...context,
      expectedAttempt: expectedAttempt(attempt), first,
      rawOutcomeEnvelopeSha256: d("7"), resolver, second, vault })).decision.answerComplete)
      .toBe(true);
    vi.mocked(first.adjudicate).mockClear(); vi.mocked(second.adjudicate).mockClear();
    vault.reconstruct.mockClear();
    const mutations: unknown[] = [
      { attemptId: attempt.attemptId, questionId: attempt.questionId },
      { ...attempt, campaignRootSha256: d("f") }, { ...attempt, releaseRootSha256: d("e") },
      { ...attempt, spendReservationSha256: d("d") },
      answerIdentity({ question: FINAL.input.questions[0]!, callKind: "retrieval",
        releaseRootSha256: attempt.releaseRootSha256, repetition: 1,
        spendReservationSha256: attempt.spendReservationSha256 }),
    ];
    for (const mutation of mutations) {
      await expect(adjudicateOutcome({ attempt: mutation as AttemptIdentity, ...context,
        expectedAttempt: expectedAttempt(attempt), first, rawOutcomeEnvelopeSha256: d("7"),
        resolver, second, vault })).rejects.toThrow();
      expect(vault.reconstruct).not.toHaveBeenCalled();
      expect(first.adjudicate).not.toHaveBeenCalled(); expect(second.adjudicate).not.toHaveBeenCalled();
    }
  });
});

describe("production quality campaign final evidence", () => {
  it("qualifies real AES-GCM evidence and reconstructs all bounded metric groups", async () => {
    const result = await admitFinalCampaign(FINAL.input);
    expect(result.qualified).toBe(true);
    const metrics = FINAL.evidence[0]!.payload.metrics;
    expect(metrics.find(({ group }) => group === "automatic")?.applicableOutcomeCount).toBe(200);
    expect(metrics.find(({ group }) => group === "independent_review")?.applicableOutcomeCount)
      .toBe(40);
    expect(metrics.every(({ thresholdPassed }) => thresholdPassed)).toBe(true);
  }, 30_000);

  it("rejects all-automatic admission, duplicate/foreign/rank-overflow locators, and absent groups", async () => {
    const allAutomatic = sealedQuestions(240, "automatic", "only-auto");
    await expect(admitFinalCampaign({ ...FINAL.input, questions: allAutomatic }))
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
      await expect(admitFinalCampaign({ ...FINAL.input,
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
        "locator-5"], speakerTimeChecks: outcome.speakerTimeChecks.map((check) =>
        ({ ...check, observedSpeakerId: "foreign-speaker" })) } : outcome);
    const metrics = reconstructMetrics(outcomes);
    expect(metrics.find(({ group }) => group === "overall")?.thresholdPassed).toBe(false);
    const receipt = FINAL.repetitionAuthority.signed({ ...first, metrics,
      metricsSha256: sha256(metrics), outcomes, outcomesSha256: sha256(outcomes) });
    await expect(admitFinalCampaign({ ...FINAL.input,
      repetitionEvidence: [receipt, FINAL.evidence[1]!, FINAL.evidence[2]!] }))
      .rejects.toThrow(/thresholds/u);
  }, 30_000);

  it("binds final adjudication plaintext and authenticates canonical AES-256-GCM itself", async () => {
    const first = FINAL.evidence[0]!.payload;
    const outcomes = first.outcomes.map((outcome, index) => index === 0 ?
      { ...outcome, finalAdjudicationSha256: d("f") } : outcome);
    const digestMutation = FINAL.repetitionAuthority.signed({ ...first, outcomes,
      outcomesSha256: sha256(outcomes) });
    await expect(admitFinalCampaign({ ...FINAL.input,
      repetitionEvidence: [digestMutation, FINAL.evidence[1]!, FINAL.evidence[2]!] }))
      .rejects.toThrow(/final adjudication/u);
    await expect(admitFinalCampaign({ ...FINAL.input,
      artifactCustody: custody(FINAL.stored, Buffer.alloc(32, 9)) }))
      .rejects.toThrow(/AES-256-GCM authentication/u);
    await expect(admitFinalCampaign({ ...FINAL.input,
      artifactCustody: { loadKey: async () => null, readEnvelope: async () => null } }))
      .rejects.toThrow(/does not exist/u);
    await expect(admitFinalCampaign({ ...FINAL.input,
      artifactCustody: { openVerified: async () => ({}) } as never }))
      .rejects.toThrow();
  }, 30_000);

  it("reconstructs cleanup only from a release-pinned signed target inventory", async () => {
    const forged = FINAL.cleanupAuthority.signed(FINAL.input.targetInventoryReceipt.payload);
    await expect(admitFinalCampaign({ ...FINAL.input, targetInventoryReceipt: forged }))
      .rejects.toThrow(/signer|signature/u);
    const payload = FINAL.input.cleanupReceipt.payload;
    const missingProtected = FINAL.cleanupAuthority.signed({ ...payload,
      presentProtectedArtifactIds: payload.presentProtectedArtifactIds.slice(1),
      presentProtectedArtifactIdsSha256: sha256(payload.presentProtectedArtifactIds.slice(1)) });
    await expect(admitFinalCampaign({ ...FINAL.input, cleanupReceipt: missingProtected }))
      .rejects.toThrow(/authoritative/u);
    const unrelated = FINAL.cleanupAuthority.signed({ ...payload,
      absentArtifactIds: ["unrelated"], absentArtifactIdsSha256: sha256(["unrelated"]) });
    await expect(admitFinalCampaign({ ...FINAL.input, cleanupReceipt: unrelated }))
      .rejects.toThrow(/authoritative/u);
  }, 30_000);

  it("derives the signed 30-question holdout without affecting main qualification", () => {
    const questions = sealedQuestions(30, "independent_review", "h");
    const mainSigner = signer("main-proof"); const holdoutSigner = signer("holdout-auth");
    const questionSigner = signer("holdout-reviewer");
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
      authorizationAuthority: holdoutSigner, holdoutLocatorDigests,
      main: mainSigner.signed(main), mainAuthority: mainSigner, questionAuthority: questionSigner,
      questionReceipt, questions };
    expect(admitIsolatedHoldout(input).questions).toHaveLength(30);
    expect(createHoldoutReport({ cleanupReceiptSha256: d("1"), holdoutRootSha256,
      outcomeCount: 30, reportMetricsSha256: d("2") }).affectsMainQualification).toBe(false);
  });

  it("keeps public operator status closed without echoing handler text", async () => {
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
