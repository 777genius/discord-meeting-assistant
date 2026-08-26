import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
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
  type RetainedArtifact,
} from "../src/quality-campaign/index.js";

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

describe("production quality campaign", () => {
  it("rejects model, reasoning, tier, SDK, image, and signature substitutions", () => {
    const authority = signer("release");
    const release = { answerImageSha256: d("1"), answerProcessIdentitySha256: d("2"),
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
    for (const mutation of [{ sdkArchiveSha256: d("0") }, { infinityImageSha256: d("0") },
      { tokenizerSha256: d("1") }, { promptSha256: d("2") }]) {
      expect(() => assertObservedRelease(release,
        { ...release, ...mutation } as typeof release)).toThrow(/drifted/u);
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
        reservations: reservations as readonly unknown[] })).toThrow();
    }
  });

  it("never retries a crash-window or ambiguous retrieval and replays signed terminals", async () => {
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
    const success = { exchange: vi.fn(async () => ({ effect: "certain_success" as const,
      signedResult: authority.signed({ attemptId: second.attemptId,
        resultDigestSha256: d("4"), state: "terminal_success" }) })) };
    expect(await executeReservedExchange({ campaignRootSha256: d("1"), identity: second,
      journal, port: success, request: Buffer.from("bounded") })).toBe("terminal_success");
    expect(await executeReservedExchange({ campaignRootSha256: d("1"), identity: second,
      journal, port: success, request: Buffer.from("bounded") })).toBe("terminal_success");
    expect(success.exchange).toHaveBeenCalledTimes(1);
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
      return { authorityId: keyId, publicKeyPem: value.publicKeyPem,
        adjudicate: vi.fn(async (request) => value.signed({ attemptId: request.attemptId,
          decision: selected, decisionDigestSha256: sha256(selected),
          encryptedEvidenceSha256: request.encryptedEvidenceSha256,
          outcomeDigestSha256: request.outcomeDigestSha256 })) };
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
  });

  it("requires an exact retained inventory and protects authoritative source kinds", () => {
    const outcomes: ExpectedOutcomeInventory[] = Array.from({ length: 720 }, (_, index) => ({
      attemptId: `attempt-${index}`, questionId: `q-${index % 240}`,
      repetition: (Math.floor(index / 240) + 1) as 1 | 2 | 3,
      resolverRequired: index === 0 }));
    const kinds = ["capability_request", "capability_response", "retrieval_request",
      "retrieval_response", "evidence", "answer_request", "answer_response", "raw_outcome",
      "adjudication_input", "adjudicator_1_result", "adjudicator_2_result",
      "final_adjudication"] as const;
    const artifacts: RetainedArtifact[] = outcomes.flatMap((outcome) => [
      ...kinds.map((kind) => ({ attemptId: outcome.attemptId, envelopeSha256: d("1"), keyId: "k",
        kind, questionId: outcome.questionId, repetition: outcome.repetition, storedBytes: 1 })),
      ...(outcome.resolverRequired ? [{ attemptId: outcome.attemptId, envelopeSha256: d("2"),
        keyId: "k", kind: "resolver_result" as const, questionId: outcome.questionId,
        repetition: outcome.repetition, storedBytes: 1 }] : []),
    ]);
    expect(verifyExactRetentionInventory({ artifacts, campaignByteCeiling: artifacts.length,
      expectedOutcomes: outcomes }).artifactCount).toBe(8641);
    expect(() => verifyExactRetentionInventory({ artifacts: artifacts.slice(1),
      campaignByteCeiling: artifacts.length, expectedOutcomes: outcomes })).toThrow(/missing/u);
    expect(() => createCleanupManifest({ campaignRootSha256: d("1"), targets: [{ artifactId: "x",
      kind: "original_craig_recording" as never }] })).toThrow(/unsafe/u);
    expect(admitFinalCampaign({ cleanupReceiptSha256: d("1"), independentRepetitionPasses:
      [1, 2, 3].map((repetition) => ({ metricsSha256: d(String(repetition)),
        repetition: repetition as 1 | 2 | 3, thresholdsPassed: true as const })),
      inventorySha256: d("4"), outcomeCount: 720, rootBindingSha256: d("5") }).qualified).toBe(true);
  });

  it("enforces isolated 30-question holdout and non-qualifying report", () => {
    const questions: CampaignQuestion[] = Array.from({ length: 30 }, (_, index) => ({ locale: "en",
      questionDigestSha256: index.toString(16).padStart(64, "0"), questionId: `h-${index}`,
      rubricDigestSha256: d("a"), source: "independent_review" }));
    const main = { loadedLocatorDigests: [d("b")], loadedQuestionDigests: [d("c")],
      mainInputRootSha256: d("1"), mainReleaseRootSha256: d("2"), tuningCorpusSha256: d("3") };
    const authorization = { authorizationSha256: d("4"), holdoutRootSha256: d("5"),
      keyNamespace: "holdout:campaign-1", mainInputRootSha256: d("1"),
      mainReleaseRootSha256: d("2"), questionReceiptSha256: d("6") };
    expect(admitIsolatedHoldout({ authorization, holdoutLocatorDigests: [d("7")], main,
      questions }).questions).toHaveLength(30);
    expect(() => admitIsolatedHoldout({ authorization, holdoutLocatorDigests: [d("b")], main,
      questions })).toThrow(/disjoint/u);
    expect(createHoldoutReport({ cleanupReceiptSha256: d("1"), holdoutRootSha256: d("2"),
      outcomeCount: 30, reportMetricsSha256: d("3") }).affectsMainQualification).toBe(false);
  });

  it("emits create-only safe operator status and exit semantics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quality-cli-"));
    const phase = join(directory, "phase.json"); const status = join(directory, "status.json");
    await writeFile(phase, canonicalJson({ payload: {}, schemaVersion: "phase.v1" }));
    expect(await runQualityCampaignOperatorCli({ argv: ["execute", phase], handlers: {
      run: async ({ command }) => ({ blockers: ["custodian"], command, receipt: { count: 240 },
        status: "paused" }) }, statusReceiptPath: status })).toBe(20);
    expect((await readFile(status, "utf8"))).not.toContain("question");
    expect(await runQualityCampaignOperatorCli({ argv: ["execute", phase], handlers: {
      run: async ({ command }) => ({ blockers: [], command, receipt: {}, status: "completed" }) },
    statusReceiptPath: status })).toBe(1);
  });
});
