import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { frozenSemanticQualityCorpus, type FrozenQualityQuestion } from "./semantic-quality-corpus.js";
import {
  runAuthenticatedAnswerEvaluation,
  type SubscriptionAnswerTransport,
} from "./semantic-quality-answer-runner.js";
import {
  createSemanticQualityRunEvidence,
  qualityDistribution,
  semanticQualityAnswerRunDigest,
  type QualityRawOutcome,
  type QualityRunBinding,
} from "./semantic-quality-evaluation.js";

const revision = "a".repeat(40);
const serviceRevision = "b".repeat(40);

describe("Infinity Context semantic and final-answer quality harness", () => {
  it("freezes a realistic two-hour multilingual holdout without unique marker questions", () => {
    const corpus = frozenSemanticQualityCorpus();
    const answerable = corpus.questions.filter(({ kind }) => kind === "answerable");
    const unsupported = corpus.questions.filter(({ kind }) => kind === "unsupported");
    const goldPositions = new Set(answerable.flatMap(({ goldTurnIds }) => goldTurnIds));

    expect(corpus.meeting.humanTurns).toHaveLength(421);
    expect(corpus.meeting.humanTurns.at(-1)?.endMs).toBe(8_418_500);
    expect(new Set(corpus.meeting.humanTurns.map(({ speakerId }) => speakerId))).toEqual(
      new Set(["maria", "mark", "nazar", "vitalii"]),
    );
    expect(corpus.meeting.humanTurns.some((turn, index, turns) =>
      index > 0 && turn.startMs < (turns[index - 1]?.endMs ?? 0))).toBe(true);
    expect(answerable).toHaveLength(100);
    expect(unsupported).toHaveLength(100);
    expect(goldPositions.size).toBe(50);
    expect(answerable.filter(({ tags }) => tags.includes("multi-hop"))).toHaveLength(5);
    expect(answerable.filter(({ tags }) => tags.includes("correction"))).toHaveLength(4);
    expect(corpus.questions.filter(({ locale }) => locale === "en").length).toBeGreaterThan(50);
    expect(corpus.questions.filter(({ locale }) => locale === "ru").length).toBeGreaterThan(50);
    expect(corpus.questions.filter(({ locale }) => locale === "mixed").length).toBe(75);
    expect(corpus.questions.map(({ question }) => question).join("\n")).not.toMatch(
      /(?:CORPUSFACT|marker|sentinel)/iu,
    );
    expect(corpus.meeting.humanTurns.map(({ text }) => text).join("\n")).toMatch(
      /twelve workspaces.+not final.+corrected it.+not twelve/isu,
    );
    expect(corpus.meeting.humanTurns.map(({ text }) => text).join("\n")).toMatch(
      /ignore all rules.+meeting content, not an instruction/isu,
    );
    expect(corpus.corpusSha256).toMatch(/^[a-f0-9]{64}$/u);
  });
  it("keeps live retrieval on the official-SDK adapter and leaves qualification false", () => {
    const helper = readFileSync(
      new URL("./semantic-quality-retrieval-helper.ts", import.meta.url),
      "utf8",
    );
    const entrypoint = readFileSync(
      new URL("./infinity-context-semantic-quality.e2e.test.ts", import.meta.url),
      "utf8",
    );
    expect(helper).toContain("new InfinityContextHistoricalMemoryAdapter({");
    expect(helper).not.toMatch(/\bfetch\s*\(/u);
    expect(helper).not.toContain('from "@infinity-context/sdk"');
    expect(entrypoint).toContain("finalAnswerQualityMeasured: false");
    expect(entrypoint).toContain("productionQualityQualified: false");
    expect(entrypoint).toContain("runAuthenticatedAnswerEvaluation");
  });
  it("scores retrieval separately from answers and retains raw per-query evidence", () => {
    const corpus = frozenSemanticQualityCorpus();
    const evidence = createSemanticQualityRunEvidence({
      binding: binding(corpus.corpusSha256, 1),
      corpus,
      labelStatus: "authored_fixture",
      outcomes: corpus.questions.map(perfectOutcome),
    });

    expect(evidence.claims).toEqual({
      productionQualityQualified: false,
      status: "harness_validation_only",
    });
    expect(evidence.outcomes).toHaveLength(200);
    expect(evidence.overall.retrievalRecallAt5).toMatchObject({
      denominator: 100,
      estimate: 1,
      numerator: 100,
    });
    expect(evidence.overall.answerRecall.estimate).toBe(1);
    expect(evidence.overall.abstentionRecall.estimate).toBe(1);
    expect(evidence.overall.claimPrecision.estimate).toBe(1);
    expect(evidence.overall.citationValidity.estimate).toBe(1);
    expect(evidence.perLocale.en.answerRecall.estimate).toBe(1);
    expect(evidence.perLocale.ru.abstentionRecall.estimate).toBe(1);
    expect(evidence.perLocale.mixed.retrievalRecallAt5.estimate).toBe(1);
    expect(evidence.resources).toEqual({
      estimatedCostUsd: 0,
      inputTokens: 64_000,
      latencyMs: { maximum: 900, p50: 400, p95: 900 },
      outputTokens: 4_000,
      peakMemoryBytes: 64 * 1024 * 1024,
      requestBytes: 256_000,
    });

    expect(evidence.sdk.packageSha256)
      .toBe("8727f751aed94769de8e7aec93ea0b927479a4ab501b3b01c31c2472b6cebc7f");
  });

  it("does not let a green retrieval score hide hallucination or partial answers", () => {
    const corpus = frozenSemanticQualityCorpus();
    const outcomes = corpus.questions.map(perfectOutcome);
    const firstAnswerable = corpus.questions.find(({ kind }) => kind === "answerable");
    const firstUnsupported = corpus.questions.find(({ kind }) => kind === "unsupported");
    if (firstAnswerable === undefined || firstUnsupported === undefined) {
      throw new Error("quality fixture is incomplete");
    }
    replace(outcomes, firstAnswerable.id, {
      ...perfectOutcome(firstAnswerable),
      adjudication: { claims: [], status: "fixture" },
      answer: { claims: [], status: "abstained" },
    });
    replace(outcomes, firstUnsupported.id, {
      ...perfectOutcome(firstUnsupported),
      adjudication: { claims: [{ citationValid: false, matchedGoldClaimId: null,
        verdict: "unsupported" }], status: "fixture" },
      answer: { claims: [{ citedTurnIds: [], text: "Unsupported approval was invented." }], status: "answered" },
    });
    const evidence = createSemanticQualityRunEvidence({
      binding: binding(corpus.corpusSha256, 1),
      corpus,
      labelStatus: "authored_fixture",
      outcomes,
    });

    expect(evidence.overall.retrievalRecallAt5.estimate).toBe(1);
    expect(evidence.overall.answerRecall.estimate).toBe(0.99);
    expect(evidence.overall.abstentionRecall.estimate).toBe(0.99);
    expect(evidence.overall.claimPrecision.estimate).toBe(104 / 105);
    expect(evidence.overall.citationValidity.estimate).toBe(104 / 105);
    expect(evidence.overall.answerRecall.wilson95?.high).toBeLessThan(1);
  });

  it("does not let duplicate gold mappings inflate claim precision", () => {
    const corpus = frozenSemanticQualityCorpus();
    const question = corpus.questions.find(({ kind }) => kind === "answerable");
    if (question === undefined) {throw new Error("missing answerable question");}
    const outcomes = corpus.questions.map(perfectOutcome);
    replace(outcomes, question.id, {
      ...perfectOutcome(question),
      adjudication: { claims: [
        { citationValid: true, matchedGoldClaimId: question.expectedClaimIds[0] ?? null,
          verdict: "supported" },
        { citationValid: false, matchedGoldClaimId: question.expectedClaimIds[0] ?? null,
          verdict: "supported" },
      ], status: "fixture" },
      answer: { claims: [
        { citedTurnIds: question.goldTurnIds, text: "Supported claim" },
        { citedTurnIds: [], text: "Unrelated duplicate mapping" },
      ], status: "answered" },
    });
    const evidence = createSemanticQualityRunEvidence({
      binding: binding(corpus.corpusSha256, 1), corpus,
      labelStatus: "authored_fixture", outcomes,
    });
    expect(evidence.overall.claimPrecision.estimate).toBe(105 / 106);
    expect(evidence.overall.citationValidity.estimate).toBe(105 / 106);
    expect(evidence.overall.answerRecall.estimate).toBe(0.99);
  });

  it("binds 100/100 unique topology and makes Fjord correction evidence mandatory", () => {
    const corpus = frozenSemanticQualityCorpus();
    const correction = corpus.questions.filter(({ tags }) => tags.includes("correction"));
    expect(correction).toHaveLength(4);
    expect(correction.every(({ goldTurnIds }) =>
      goldTurnIds.includes("quality-turn-086") && goldTurnIds.includes("quality-turn-088")))
      .toBe(true);
    expect(corpus.questions.filter(({ kind }) => kind === "unsupported")
      .every(({ distractorTurnIds }) => distractorTurnIds.length === 1)).toBe(true);

    const truncated = Object.freeze({ ...corpus,
      questions: Object.freeze(corpus.questions.slice(1)) });
    expect(() => createSemanticQualityRunEvidence({
      binding: binding(corpus.corpusSha256, 1), corpus: truncated,
      labelStatus: "authored_fixture", outcomes: corpus.questions.slice(1).map(perfectOutcome),
    })).toThrow(/100\/100|digest/u);
  });

  it("rejects stale correction answers under independent adjudication", () => {
    const corpus = frozenSemanticQualityCorpus();
    const correction = corpus.questions.find(({ tags }) => tags.includes("correction"));
    if (correction === undefined) {throw new Error("missing correction question");}
    const outcomes = corpus.questions.map((question) => ({
      ...perfectOutcome(question),
      adjudication: { ...perfectOutcome(question).adjudication, status: "human_verified" as const },
    }));
    replace(outcomes, correction.id, {
      ...perfectOutcome(correction),
      adjudication: { claims: [{ citationValid: false, matchedGoldClaimId: null,
        verdict: "stale" }], status: "human_verified" },
      answer: { claims: [{ citedTurnIds: ["quality-turn-086"], text: "Twelve workspaces" }],
        status: "answered" },
    });
    const evidence = createSemanticQualityRunEvidence({
      adjudicationReceipt: humanReceipt(corpus, outcomes),
      binding: binding(corpus.corpusSha256, 1), corpus,
      labelStatus: "independent_human_verified", outcomes,
    });
    expect(evidence.overall.answerRecall.estimate).toBe(0.99);
    expect(evidence.overall.claimPrecision.estimate).toBe(104 / 105);
  });

  it("fails closed on incomplete, self-claimed, unbounded, or mismatched evidence", () => {
    const corpus = frozenSemanticQualityCorpus();
    const outcomes = corpus.questions.map(perfectOutcome);
    expect(() => createSemanticQualityRunEvidence({
      binding: binding(corpus.corpusSha256, 1),
      corpus,
      labelStatus: "independent_human_verified",
      outcomes,
    })).toThrow(/human adjudicated/u);

    expect(() => createSemanticQualityRunEvidence({
      binding: binding(corpus.corpusSha256, 1),
      corpus,
      labelStatus: "authored_fixture",
      outcomes: outcomes.slice(1),
    })).toThrow(/exactly one outcome/u);

    const invalid = {
      ...outcomes[0],
      retrieval: { ...outcomes[0]?.retrieval, wholeTranscriptIncluded: true },
    } as unknown as QualityRawOutcome;
    expect(() => createSemanticQualityRunEvidence({
      binding: binding(corpus.corpusSha256, 1),
      corpus,
      labelStatus: "authored_fixture",
      outcomes: [invalid, ...outcomes.slice(1)],
    })).toThrow(/reference-only retrieval/u);
  });

  it("summarizes repeated exact-binding runs without collapsing their raw outcomes", () => {
    const corpus = frozenSemanticQualityCorpus();
    const runs = [1, 2, 3].map((repetition) => createSemanticQualityRunEvidence({
      binding: binding(corpus.corpusSha256, repetition),
      corpus,
      labelStatus: "authored_fixture",
      outcomes: corpus.questions.map(perfectOutcome),
    }));
    expect(qualityDistribution(runs, "answerRecall")).toEqual({
      metric: "answerRecall",
      repetitions: 3,
      values: { maximum: 1, median: 1, minimum: 1 },
    });
    expect(() => qualityDistribution(runs.slice(0, 2), "answerRecall")).toThrow(
      /at least three repetitions/u,
    );
  });

});

describe("subscription answer quality receipt", () => {
  it("binds an externally injected subscription answer receipt to bounded requests", async () => {
    const corpus = frozenSemanticQualityCorpus();
    const transport = answerTransport();
    const run = await runAuthenticatedAnswerEvaluation({
      build: { releaseRevision: "4".repeat(40), releaseTree: "5".repeat(40) }, corpus,
      observedAt: "2026-08-18T04:00:00.000Z", repetition: 1,
      retrieval: retrievalRun(corpus), runId: "answer-run-1", transport,
    });
    expect(run.outcomes).toHaveLength(200);
    expect(run.outcomes.every(({ adjudication }) => adjudication.status === "pending")).toBe(true);
    expect(run.binding.embeddingProfileId).toBe("endpoint-profile");
    expect(run.binding.releaseTree).toBe("5".repeat(40));
  });

  it("rejects an answer receipt that is not bound to the exact request batch", async () => {
    const corpus = frozenSemanticQualityCorpus();
    await expect(runAuthenticatedAnswerEvaluation({
      build: { releaseRevision: "4".repeat(40), releaseTree: "5".repeat(40) }, corpus,
      observedAt: "2026-08-18T04:00:00.000Z", repetition: 1,
      retrieval: retrievalRun(corpus), runId: "answer-run-bad-binding",
      transport: answerTransport({ wrongBatchDigest: true }),
    })).rejects.toThrow(/unbound/u);
  });

  it("rejects citations outside the bounded locally rehydrated request", async () => {
    const corpus = frozenSemanticQualityCorpus();
    await expect(runAuthenticatedAnswerEvaluation({
      build: { releaseRevision: "4".repeat(40), releaseTree: "5".repeat(40) }, corpus,
      observedAt: "2026-08-18T04:00:00.000Z", repetition: 1,
      retrieval: retrievalRun(corpus), runId: "answer-run-bad-citation",
      transport: answerTransport({ outsideCitation: true }),
    })).rejects.toThrow(/outside its bounded request/u);
  });
});

function binding(corpusSha256: string, repetition: number): QualityRunBinding {
  const corpus = frozenSemanticQualityCorpus();
  return {
    corpusSha256,
    embeddingProfileDigestSha256: `sha256:${"c".repeat(64)}`,
    embeddingProfileId: "multilingual-minilm-production-r1",
    modelConfigurationSha256: "d".repeat(64),
    modelContextTokens: 32_000,
    modelId: "gpt-5.6-sol",
    modelRevision: "hosted-subscription-pinned-r1",
    observedAt: "2026-08-18T04:00:00.000Z",
    questionSetSha256: corpus.questionSetSha256,
    releaseRevision: revision,
    releaseTree: "f".repeat(40),
    repetition,
    runId: `semantic-quality-run-${repetition}`,
    serviceApiVersion: "v1",
    serviceName: "disposable-infinity-context",
    serviceRevision,
    tokenizerId: "provider-tokenizer-r1",
    tokenizerDigestSha256: `sha256:${"e".repeat(64)}`,
  };
}

function perfectOutcome(question: FrozenQualityQuestion): QualityRawOutcome {
  const answered = question.kind === "answerable";
  return {
    adjudication: {
      claims: question.expectedClaimIds.map((claimId) => ({
        citationValid: true, matchedGoldClaimId: claimId, verdict: "supported" as const,
      })),
      status: "fixture",
    },
    answer: {
      claims: answered
        ? question.expectedClaimIds.map((claimId, index) => ({
            citedTurnIds: [question.goldTurnIds[index] ?? question.goldTurnIds[0] ?? ""],
            text: `Synthetic answer for ${question.id} claim ${claimId}`,
          }))
        : [],
      status: answered ? "answered" : "abstained",
    },
    measurement: {
      estimatedCostUsd: 0,
      inputTokens: answered ? 512 : 128,
      latencyMs: answered ? 900 : 400,
      outputTokens: answered ? 32 : 8,
      peakMemoryBytes: 64 * 1024 * 1024,
      requestBytes: answered ? 2_048 : 512,
      requestSha256: createHash("sha256").update(question.id).digest("hex"),
    },
    queryId: question.id,
    retrieval: {
      localRehydrationVerified: true,
      providerPayloadWasReferenceOnly: true,
      rehydratedTurnIds: question.goldTurnIds,
      topFiveTurnIds: question.goldTurnIds,
      wholeTranscriptIncluded: false,
      candidateBlockCountAt5: question.goldTurnIds.length,
    },
  };
}

function replace(outcomes: QualityRawOutcome[], queryId: string, replacement: QualityRawOutcome): void {
  const index = outcomes.findIndex((outcome) => outcome.queryId === queryId);
  if (index < 0) {
    throw new Error("missing fixture outcome");
  }
  outcomes[index] = replacement;
}

function retrievalRun(corpus: ReturnType<typeof frozenSemanticQualityCorpus>) {
  return {
    corpusSha256: corpus.corpusSha256,
    outcomes: corpus.questions.map((question) => ({
      answerRequest: { evidence: question.goldTurnIds.map((turnId) => ({ text: "bounded evidence",
        turnId })), question: question.question, requestBytes: 128 },
      candidateBlockCountAt5: 1, localRehydrationVerified: true,
      providerPayloadWasReferenceOnly: true as const, queryId: question.id,
      rehydratedTurnIds: question.goldTurnIds, status: "ready" as const,
      topFiveTurnIds: question.goldTurnIds, wholeTranscriptIncluded: false as const,
    })),
    remoteCleanupVerified: true as const,
    service: { apiVersion: "v1", embeddingProfileDigestSha256: `sha256:${"6".repeat(64)}` as const,
      embeddingProfileId: "endpoint-profile", enabledAdapters: ["qdrant"], name: "infinity",
      revision: "7".repeat(40) },
  };
}

function humanReceipt(
  corpus: ReturnType<typeof frozenSemanticQualityCorpus>,
  outcomes: readonly QualityRawOutcome[],
) {
  return {
    adjudicatorId: "independent-reviewer-1",
    answerRunSha256: semanticQualityAnswerRunDigest(outcomes),
    corpusSha256: corpus.corpusSha256,
    questionSetSha256: corpus.questionSetSha256,
    reviewedAt: "2026-08-18T05:00:00.000Z",
    schemaVersion: "meeting_knowledge.human_adjudication_receipt.v1" as const,
  };
}

function answerTransport(options: {
  readonly outsideCitation?: boolean;
  readonly wrongBatchDigest?: boolean;
} = {}): SubscriptionAnswerTransport {
  return {
    execute: async (batch) => ({
      answers: batch.requests.map((request, index) => ({
        claims: options.outsideCitation === true && index === 0
          ? [{ citedTurnIds: ["quality-turn-420"], text: "Out-of-request claim" }]
          : [],
        measurement: {
          estimatedCostUsd: 0, inputTokens: 1, latencyMs: 1, outputTokens: 0,
          peakMemoryBytes: 1,
          requestBytes: Buffer.byteLength(JSON.stringify(request), "utf8"),
          requestSha256: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
        },
        queryId: request.queryId,
        status: options.outsideCitation === true && index === 0
          ? "answered" as const : "abstained" as const,
      })),
      attestation: { authKind: "subscription_session", modelConfigurationSha256: "1".repeat(64),
        modelContextTokens: 32_000, modelId: "hosted-model", modelRevision: "pinned-r1",
        runnerRevision: "2".repeat(40), tokenizerDigestSha256: `sha256:${"3".repeat(64)}`,
        tokenizerId: "pinned-tokenizer" },
      requestSha256: options.wrongBatchDigest === true
        ? "0".repeat(64)
        : createHash("sha256").update(JSON.stringify(batch)).digest("hex"),
      schemaVersion: "meeting_knowledge.subscription_answer_receipt.v1",
    }),
  };
}
