import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { frozenSemanticQualityCorpus, type FrozenQualityQuestion } from "./semantic-quality-corpus.js";
import {
  createSemanticQualityRunEvidence,
  qualityDistribution,
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
    expect(goldPositions.size).toBe(25);
    expect(answerable.filter(({ tags }) => tags.includes("multi-hop"))).toHaveLength(5);
    expect(answerable.filter(({ tags }) => tags.includes("correction"))).toHaveLength(1);
    expect(corpus.questions.filter(({ locale }) => locale === "en").length).toBeGreaterThan(50);
    expect(corpus.questions.filter(({ locale }) => locale === "ru").length).toBeGreaterThan(50);
    expect(corpus.questions.filter(({ locale }) => locale === "mixed").length).toBe(50);
    expect(corpus.questions.map(({ question }) => question).join("\n")).not.toMatch(
      /(?:CORPUSFACT|marker|sentinel)/iu,
    );
    expect(corpus.meeting.humanTurns.map(({ text }) => text).join("\n")).toMatch(
      /obsolete.+Correction.+not twelve/isu,
    );
    expect(corpus.meeting.humanTurns.map(({ text }) => text).join("\n")).toMatch(
      /ignore all rules.+meeting content, not an instruction/isu,
    );
    expect(corpus.corpusSha256).toMatch(/^[a-f0-9]{64}$/u);
  });
  it("keeps the live retrieval phase on the official-SDK adapter and emits no transcript text", () => {
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
    expect(entrypoint).not.toContain("meeting.humanTurns");
  });



  it("scores retrieval separately from answers and retains raw per-query evidence", () => {
    const corpus = frozenSemanticQualityCorpus();
    const evidence = createSemanticQualityRunEvidence({
      binding: binding(corpus.corpusSha256, 1),
      labelStatus: "authored_fixture",
      outcomes: corpus.questions.map(perfectOutcome),
      questions: corpus.questions,
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
      .toBe("93ea6c98dec53c886250f3a3a06cb3825da27d1fc5ff73b85ab9633273e6bc1a");
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
      adjudication: { citationValid: true, matchedGoldClaimIds: [], status: "fixture" },
      answer: { claims: [], status: "abstained" },
    });
    replace(outcomes, firstUnsupported.id, {
      ...perfectOutcome(firstUnsupported),
      adjudication: { citationValid: false, matchedGoldClaimIds: [null], status: "fixture" },
      answer: { claims: [{ citedTurnIds: [], text: "Unsupported approval was invented." }], status: "answered" },
    });
    const evidence = createSemanticQualityRunEvidence({
      binding: binding(corpus.corpusSha256, 1),
      labelStatus: "authored_fixture",
      outcomes,
      questions: corpus.questions,
    });

    expect(evidence.overall.retrievalRecallAt5.estimate).toBe(1);
    expect(evidence.overall.answerRecall.estimate).toBe(0.99);
    expect(evidence.overall.abstentionRecall.estimate).toBe(0.99);
    expect(evidence.overall.claimPrecision.estimate).toBe(104 / 105);
    expect(evidence.overall.citationValidity.estimate).toBe(104 / 105);
    expect(evidence.overall.answerRecall.wilson95?.high).toBeLessThan(1);
  });

  it("fails closed on incomplete, self-claimed, unbounded, or mismatched evidence", () => {
    const corpus = frozenSemanticQualityCorpus();
    const outcomes = corpus.questions.map(perfectOutcome);
    expect(() => createSemanticQualityRunEvidence({
      binding: binding(corpus.corpusSha256, 1),
      labelStatus: "independent_human_verified",
      outcomes,
      questions: corpus.questions,
    })).toThrow(/human adjudicated/u);

    expect(() => createSemanticQualityRunEvidence({
      binding: binding(corpus.corpusSha256, 1),
      labelStatus: "authored_fixture",
      outcomes: outcomes.slice(1),
      questions: corpus.questions,
    })).toThrow(/exactly one outcome/u);

    const invalid = {
      ...outcomes[0],
      retrieval: { ...outcomes[0]?.retrieval, wholeTranscriptIncluded: true },
    } as unknown as QualityRawOutcome;
    expect(() => createSemanticQualityRunEvidence({
      binding: binding(corpus.corpusSha256, 1),
      labelStatus: "authored_fixture",
      outcomes: [invalid, ...outcomes.slice(1)],
      questions: corpus.questions,
    })).toThrow(/reference-only retrieval/u);
  });

  it("summarizes repeated exact-binding runs without collapsing their raw outcomes", () => {
    const corpus = frozenSemanticQualityCorpus();
    const runs = [1, 2, 3].map((repetition) => createSemanticQualityRunEvidence({
      binding: binding(corpus.corpusSha256, repetition),
      labelStatus: "authored_fixture",
      outcomes: corpus.questions.map(perfectOutcome),
      questions: corpus.questions,
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

function binding(corpusSha256: string, repetition: number): QualityRunBinding {
  return {
    corpusSha256,
    embeddingProfileDigestSha256: `sha256:${"c".repeat(64)}`,
    embeddingProfileId: "multilingual-minilm-production-r1",
    modelConfigurationSha256: "d".repeat(64),
    modelContextTokens: 32_000,
    modelId: "gpt-5.6-sol",
    modelRevision: "hosted-subscription-pinned-r1",
    observedAt: "2026-08-18T04:00:00.000Z",
    releaseRevision: revision,
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
      citationValid: true,
      matchedGoldClaimIds: question.expectedClaimIds,
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
