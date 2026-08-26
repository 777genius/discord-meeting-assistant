import { describe, expect, it } from "vitest";

import {
  FailClosedSemanticQualityV4Adjudication,
  FailClosedSemanticQualityV4Answer,
  FailClosedSemanticQualityV4Evidence,
  FailClosedSemanticQualityV4Retrieval,
  runSemanticQualityV4,
  type SemanticQualityV4AnswerPort,
  type SemanticQualityV4RunQuestion,
} from "../src/semantic-quality-v4-runner.js";
import {
  assertSemanticQualityV4StaticLeakageSafety,
  frozenSemanticQualityCorpusV4,
  v4EvaluationQuestionText,
  v4HardNegativeLocatorIds,
  v4RetrievalStratum,
} from "./semantic-quality-v4-corpus.js";
import {
  createV4GeneratedClaimId,
  evaluateSemanticQualityV4,
  evaluateV4Thresholds,
} from "./semantic-quality-v4-evaluation.js";
import { canonicalSha256 } from "./semantic-quality-v4-manifest.js";
import { perfectOutcomesForP0Test } from "./semantic-quality-v4-test-fixtures.js";

function validAnswerMeasurement() {
  const surface = { fullInputBytes: 11, outputSchemaBytes: 3,
    systemPromptBytes: 3, userPromptBytes: 3 };
  return { answerLatencyUs: 1, attemptId: "fixture-attempt", originalInput: surface,
    originalModelInputSha256: "d".repeat(64), repairInput: surface,
    originalProviderRequestSha256: "b".repeat(64),
    originalProviderResponseSha256: "c".repeat(64),
    repairModelInputSha256: "e".repeat(64), responseBytes: 1,
    repairProviderRequestSha256: null, repairProviderResponseSha256: null,
    responseRuntimeArtifactSha256: "f".repeat(64), runtimeReceiptSha256: "a".repeat(64) };
}

function validRetrievalMeasurement() {
  return { capabilityAndRetrievalLatencyUs: 1, capabilityBytes: 1,
    capabilitySha256: "a".repeat(64), requestSha256: "b".repeat(64),
    requestSnapshotSha256: "d".repeat(64),
    responseSha256: "c".repeat(64), routeLatencyUs: 1 };
}

describe("meeting-memory V4 P0 frozen gates", () => {
  it("freezes anchorless and named-anchor strata with hard negatives and no static leakage", () => {
    const corpus = frozenSemanticQualityCorpusV4();
    const answerable = corpus.automatedQuestions.filter(({ kind }) => kind === "answerable");
    expect(answerable.filter((question) => v4RetrievalStratum(question) === "anchorless"))
      .toHaveLength(25);
    expect(answerable.filter((question) => v4RetrievalStratum(question) === "named_anchor"))
      .toHaveLength(75);
    expect(answerable.every((question) => v4HardNegativeLocatorIds(corpus, question).length > 0))
      .toBe(true);
    expect(answerable.filter((question) => v4RetrievalStratum(question) === "anchorless" &&
      v4EvaluationQuestionText(question) !== question.question).length).toBeGreaterThanOrEqual(5);
    expect(() => {assertSemanticQualityV4StaticLeakageSafety(corpus);}).not.toThrow();
    expect(() => {assertSemanticQualityV4StaticLeakageSafety({
      ...corpus,
      automatedQuestions: [{ ...corpus.automatedQuestions[0]!,
        question: `Use QuAlItY-TuRn-007 FaCt-00 ${"a".repeat(64)} CORPUSFACT-17` },
      ...corpus.automatedQuestions.slice(1)],
    });}).toThrow(/static leakage/u);
  });

  it("gates final answers and retrieval overall and independently for EN, RU, and mixed", () => {
    const corpus = frozenSemanticQualityCorpusV4();
    const outcomes = perfectOutcomesForP0Test(corpus);
    const metrics = evaluateSemanticQualityV4({ outcomes });
    expect(metrics.byLocale.en.answerableCount).toBe(39);
    expect(metrics.byLocale.ru.answerableCount).toBe(43);
    expect(metrics.byLocale.mixed.answerableCount).toBe(38);
    expect(evaluateV4Thresholds(metrics).failedGateIds).not.toContain("final_answer_recall");

    for (const locale of ["en", "ru", "mixed"] as const) {
      const broken = perfectOutcomesForP0Test(corpus);
      const questions = [...corpus.automatedQuestions, ...corpus.humanReviewQuestions]
        .filter((question) => question.kind === "answerable" && question.locale === locale)
        .slice(0, Math.ceil(metrics.byLocale[locale].answerableCount / 10) + 1);
      for (const question of questions) {
        const index = broken.findIndex(({ queryId }) => queryId === question.id);
        broken[index] = { ...broken[index]!, adjudications: [], citationEntailments: [],
          evidenceBytes: new TextEncoder().encode("[]").byteLength,
          locallyRehydratedEvidence: [],
          answer: { claims: [], status: "abstained" }, retrieval: { ...broken[index]!.retrieval,
            rankedSeedLocators: [] } };
      }
      const decision = evaluateV4Thresholds(evaluateSemanticQualityV4({ outcomes: broken }));
      expect(decision.failedGateIds).toContain(`final_answer_recall_${locale}`);
      expect(decision.failedGateIds).toContain(`complete_question_recall_at_5_${locale}`);
    }
  });

  it("derives citation admission from exact local evidence and gates entailment", () => {
    const corpus = frozenSemanticQualityCorpusV4();
    const outcomes = perfectOutcomesForP0Test(corpus);
    const target = outcomes.find(({ answer }) => answer.claims.length > 0)!;
    const index = outcomes.indexOf(target);
    outcomes[index] = { ...target, evidenceBytes: new TextEncoder().encode("[]").byteLength,
      locallyRehydratedEvidence: [] };
    const admission = evaluateSemanticQualityV4({ outcomes });
    expect(admission.citationMembership.numerator).toBeLessThan(
      admission.citationMembership.denominator,
    );
    expect(evaluateV4Thresholds(admission).failedGateIds).toContain("citation_membership");
    const forged = perfectOutcomesForP0Test(corpus);
    const forgedTarget = forged.find(({ locallyRehydratedEvidence }) =>
      locallyRehydratedEvidence.length > 0)!;
    const forgedEvidence = forgedTarget.locallyRehydratedEvidence.map((turn, turnIndex) =>
      turnIndex === 0 ? { ...turn, text: `${turn.text} forged` } : turn);
    forged[forged.indexOf(forgedTarget)] = { ...forgedTarget,
      evidenceBytes: new TextEncoder().encode(JSON.stringify(forgedEvidence)).byteLength,
      locallyRehydratedEvidence: forgedEvidence };
    expect(() => evaluateSemanticQualityV4({ outcomes: forged }))
      .toThrow(/non-canonical local evidence/u);

    const entailed = perfectOutcomesForP0Test(corpus);
    const entailedTarget = entailed.find(({ answer }) => answer.claims.length > 0)!;
    const entailedIndex = entailed.indexOf(entailedTarget);
    entailed[entailedIndex] = { ...entailedTarget,
      citationEntailments: entailedTarget.citationEntailments.map((item) => ({
        ...item, verdict: "does_not_entail" as const,
      })) };
    const entailment = evaluateSemanticQualityV4({ outcomes: entailed });
    expect(evaluateV4Thresholds(entailment).failedGateIds).toContain("citation_entailment");
  });

  it("scores only ordered upstream seeds before neighbor expansion", () => {
    const corpus = frozenSemanticQualityCorpusV4();
    const outcomes = perfectOutcomesForP0Test(corpus);
    const question = corpus.automatedQuestions.find(({ kind, goldTurnIds }) =>
      kind === "answerable" && goldTurnIds.length === 2)!;
    const index = outcomes.findIndex(({ queryId }) => queryId === question.id);
    const outcome = outcomes[index]!;
    outcomes[index] = { ...outcome, retrieval: { ...outcome.retrieval,
      expandedNeighborLocators: question.goldTurnIds.map((locatorId) => ({ locatorId })),
      rankedSeedLocators: outcome.retrieval.rankedSeedLocators
        .filter(({ locatorId }) => !question.goldTurnIds.includes(locatorId)),
    } };
    const metrics = evaluateSemanticQualityV4({ outcomes });
    expect(metrics.completeQuestionRecallAt5.numerator)
      .toBeLessThan(metrics.completeQuestionRecallAt5.denominator);
    expect(metrics.blockLocatorRecallAt5.denominator)
      .toBeGreaterThan(metrics.completeQuestionRecallAt5.denominator);
    expect(metrics.blockLocatorRecallAt10.denominator)
      .toBe(metrics.blockLocatorRecallAt5.denominator);
  });
});

describe("meeting-memory V4 consumer-owned runner ports", () => {
  it("executes 240 questions through every consumer-owned port", async () => {
    const questions = Array.from({ length: 240 }, (_, index): SemanticQualityV4RunQuestion => ({
      id: `q-${index}`, locale: "en", question: `Question ${index}`,
    }));
    const calls: string[] = [];
    const outcomes = await runSemanticQualityV4({
      adjudication: { adjudicate: async ({ queryId }) => { calls.push(`j:${queryId}`); return {
        adjudications: [], citationEntailments: [], kind: "synthetic_structural_fixture",
      }; } },
      answer: { answer: async ({ queryId }) => { calls.push(`a:${queryId}`); return {
        claims: [], measurement: validAnswerMeasurement(),
        prompt: `Prompt ${queryId}`, status: "abstained",
      }; } },
      evidence: { rehydrate: async ({ queryId }) => { calls.push(`e:${queryId}`); return {
        turns: [],
      }; } },
      canonicalQuestions: questions,
      questions,
      retrieval: { retrieve: async ({ queryId }) => { calls.push(`r:${queryId}`); return {
        ...validRetrievalMeasurement(), expandedNeighborLocators: [], latencyUs: 1,
        rankedSeedLocators: [], requestBytes: 1, responseBytes: 1, status: "completed",
      }; } },
    });
    expect(outcomes).toHaveLength(240);
    expect(calls).toHaveLength(960);
    expect(calls.slice(0, 4)).toEqual(["r:q-0", "e:q-0", "r:q-1", "e:q-1"]);
    expect(calls.slice(478, 482)).toEqual(["r:q-239", "e:q-239", "a:q-0", "a:q-1"]);
    expect(calls.slice(718, 722)).toEqual(["a:q-238", "a:q-239", "j:q-0", "j:q-1"]);
  });

  it("keeps the uncomposed production retrieval implementation fail-closed", async () => {
    await expect(new FailClosedSemanticQualityV4Retrieval().retrieve({
      locale: "en", queryId: "q", question: "question",
    })).rejects.toThrow(/not composed/u);
    await expect(new FailClosedSemanticQualityV4Evidence().rehydrate({
      expandedNeighborLocators: [], locale: "en", questionDigestSha256: "a".repeat(64),
      queryId: "q", rankedSeedLocators: [],
    })).rejects.toThrow(/not composed/u);
    await expect(new FailClosedSemanticQualityV4Answer().answer({
      evidence: [], locale: "en", queryId: "q", question: "question",
    })).rejects.toThrow(/not composed/u);
    await expect(new FailClosedSemanticQualityV4Adjudication().adjudicate({
      answer: { claims: [], status: "abstained" }, evidence: [], queryId: "q",
      locale: "en", question: "question", questionDigestSha256: "a".repeat(64),
    })).rejects.toThrow(/not composed/u);
  });

  it("finishes retrieval-only and stops every answer effect after one retrieval failure",
    async () => {
      const questions = Array.from({ length: 240 }, (_, index): SemanticQualityV4RunQuestion => ({
        id: `q-${index}`, locale: "en", question: `Question ${index}`,
      }));
      let answers = 0;
      await expect(runSemanticQualityV4({
        adjudication: { adjudicate: async () => ({ adjudications: [], citationEntailments: [],
          kind: "synthetic_structural_fixture" }) },
        answer: { answer: async () => {answers += 1; return { claims: [],
          measurement: validAnswerMeasurement(), prompt: "", status: "abstained" };} },
        canonicalQuestions: questions, questions,
        evidence: { rehydrate: async () => ({ turns: [] }) },
        retrieval: { retrieve: async ({ queryId }) => ({ ...validRetrievalMeasurement(),
          expandedNeighborLocators: [], latencyUs: 1, rankedSeedLocators: [], requestBytes: 1,
          responseBytes: 1, status: queryId === "q-17" ? "failure" : "completed" }) },
      })).rejects.toThrow(/failed before answer execution/u);
      expect(answers).toBe(0);
    });
});

describe("meeting-memory V4 reviewer exploit regressions", () => {
  it("rejects leaked or relabeled execution questions before any port executes", async () => {
    const corpus = frozenSemanticQualityCorpusV4();
    const canonicalQuestions = [...corpus.automatedQuestions, ...corpus.humanReviewQuestions]
      .map((question) => ({ id: question.id, locale: question.locale,
        question: v4EvaluationQuestionText(question) }));
    const leaked = canonicalQuestions.map((question) => ({ ...question,
      question: `quality-turn-007 fact-00 ${question.question}` }));
    await expect(runSemanticQualityV4({
      adjudication: { adjudicate: async () => ({ adjudications: [], citationEntailments: [],
        kind: "synthetic_structural_fixture" }) },
      answer: { answer: async () => ({ claims: [], measurement: validAnswerMeasurement(),
        prompt: "", status: "abstained" }) },
      canonicalQuestions,
      evidence: { rehydrate: async () => ({ turns: [] }) },
      questions: leaked,
      retrieval: { retrieve: async () => ({ ...validRetrievalMeasurement(),
        expandedNeighborLocators: [], latencyUs: 0, rankedSeedLocators: [], requestBytes: 0,
        responseBytes: 0, status: "completed" }) },
    })).rejects.toThrow(/exact 240 canonical/u);
  });

  it("rejects canonical evidence injected outside the retrieved seed and neighbor set", async () => {
    const corpus = frozenSemanticQualityCorpusV4();
    const fixtures = perfectOutcomesForP0Test(corpus);
    const byId = new Map(fixtures.map((outcome) => [outcome.queryId, outcome]));
    const canonicalQuestions = [...corpus.automatedQuestions, ...corpus.humanReviewQuestions]
      .map((question) => ({ id: question.id, locale: question.locale,
        question: v4EvaluationQuestionText(question) }));
    await expect(runSemanticQualityV4({
      adjudication: { adjudicate: async () => ({ adjudications: [], citationEntailments: [],
        kind: "synthetic_structural_fixture" }) },
      answer: { answer: async () => ({ claims: [], measurement: validAnswerMeasurement(),
        prompt: "", status: "abstained" }) },
      canonicalQuestions,
      evidence: { rehydrate: async ({ queryId }) => ({
        turns: byId.get(queryId)?.locallyRehydratedEvidence ?? [],
      }) },
      questions: canonicalQuestions,
      retrieval: { retrieve: async () => ({ ...validRetrievalMeasurement(),
        expandedNeighborLocators: [], latencyUs: 0, rankedSeedLocators: [], requestBytes: 0,
        responseBytes: 0, status: "completed" }) },
    })).rejects.toThrow(/local evidence/u);
  });

  it("rejects a missing exact prompt and a scorer outcome with a forged question binding", async () => {
    const corpus = frozenSemanticQualityCorpusV4();
    const canonicalQuestions = [...corpus.automatedQuestions, ...corpus.humanReviewQuestions]
      .map((question) => ({ id: question.id, locale: question.locale,
        question: v4EvaluationQuestionText(question) }));
    type AnswerResult = Awaited<ReturnType<SemanticQualityV4AnswerPort["answer"]>>;
    const omittedPrompt = { claims: [], status: "abstained" } as unknown as AnswerResult;
    await expect(runSemanticQualityV4({
      adjudication: { adjudicate: async () => ({ adjudications: [], citationEntailments: [],
        kind: "synthetic_structural_fixture" }) },
      answer: { answer: async () => omittedPrompt }, canonicalQuestions,
      evidence: { rehydrate: async () => ({ turns: [] }) }, questions: canonicalQuestions,
      retrieval: { retrieve: async () => ({ ...validRetrievalMeasurement(),
        expandedNeighborLocators: [], latencyUs: 0, rankedSeedLocators: [], requestBytes: 0,
        responseBytes: 0, status: "completed" }) },
    })).rejects.toThrow(/omitted its exact prompt/u);

    const forged = perfectOutcomesForP0Test(corpus);
    forged[0] = { ...forged[0]!, locale: "ru", questionDigestSha256: "a".repeat(64) };
    expect(() => evaluateSemanticQualityV4({ outcomes: forged }))
      .toThrow(/canonical question/u);
  });

  it("recomputes bytes and whole-transcript inclusion from exact evidence and prompt", () => {
    const corpus = frozenSemanticQualityCorpusV4();
    const forged = perfectOutcomesForP0Test(corpus);
    forged[0] = { ...forged[0]!, evidenceBytes: 0 };
    expect(() => evaluateSemanticQualityV4({ outcomes: forged })).toThrow(/bounded rank-10/u);

    const transcript = perfectOutcomesForP0Test(corpus);
    const target = transcript[0]!;
    const allTurns = corpus.primaryMeeting.humanTurns.map((turn) =>
      ({ ...turn, sourceLocatorId: turn.turnId }));
    transcript[0] = { ...target,
      evidenceBytes: new TextEncoder().encode(JSON.stringify(allTurns)).byteLength,
      locallyRehydratedEvidence: allTurns,
      retrieval: { ...target.retrieval, expandedNeighborLocators:
        allTurns.map(({ turnId }) => ({ locatorId: turnId })) } };
    const decision = evaluateV4Thresholds(evaluateSemanticQualityV4({ outcomes: transcript }));
    expect(decision.failedGateIds).toContain("bounded_input");
    expect(decision.failedGateIds).toContain("whole_transcript");
  });

  it("uses independent factuality adjudication even when the generator marks a claim nonfactual", () => {
    const corpus = frozenSemanticQualityCorpusV4();
    const outcomes = perfectOutcomesForP0Test(corpus);
    const outcome = outcomes.find(({ answer }) => answer.claims.length > 0)!;
    const index = outcomes.indexOf(outcome);
    const original = outcome.answer.claims[0]!;
    const text = "Unsupported hallucinated deployment claim";
    const claimPayloadSha256 = canonicalSha256({ factual: false, text });
    const claimId = createV4GeneratedClaimId({ citationRefs: original.citationRefs,
      claimOrdinal: 0, claimPayloadSha256, factual: false, queryId: outcome.queryId });
    outcomes[index] = { ...outcome,
      adjudications: [{ claimId, factuality: "factual", matchedGoldClaimId: null,
        status: "finalized", verdict: "unsupported" }, ...outcome.adjudications.slice(1)],
      citationEntailments: outcome.citationEntailments.map((item, itemIndex) =>
        itemIndex === 0 ? { ...item, claimId, verdict: "does_not_entail" } : item),
      answer: { ...outcome.answer, claims: [{ ...original, claimId, claimPayloadSha256,
        factual: false, text }, ...outcome.answer.claims.slice(1)] } };
    expect(() => evaluateSemanticQualityV4({ outcomes }))
      .toThrow(/requires a supported factual claim/u);
  });

  it("case-folds and tokenizes codename ablation and freezes four negatives per fact family", () => {
    const corpus = frozenSemanticQualityCorpusV4();
    const anchorless = corpus.automatedQuestions.find((question) =>
      v4RetrievalStratum(question) === "anchorless")!;
    expect(v4EvaluationQuestionText({ ...anchorless,
      question: "What did aUrOrA settle? Auroral remains unrelated." }))
      .toContain("Auroral");
    expect(v4EvaluationQuestionText({ ...anchorless,
      question: "What did aUrOrA settle?" }).toLocaleLowerCase()).not.toContain("aurora");
    const byFamily = Map.groupBy(corpus.fixtureComponents.factFamilyNegatives,
      ({ factFamilyId }) => factFamilyId);
    expect(byFamily.size).toBe(25);
    expect([...byFamily.values()].every((turns) => turns.length === 4 &&
      new Set(turns.map(({ negativeKind }) => negativeKind)).size === 4)).toBe(true);
  });
});
