import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertSemanticQualityV4CorpusIntegrity,
  frozenSemanticQualityCorpusV4,
  v4EvaluationQuestionText,
  type FrozenSemanticQualityCorpusV4,
  type V4QualityQuestion,
} from "./semantic-quality-v4-corpus.js";
import { frozenSemanticQualityCorpus } from "./semantic-quality-corpus.js";
import {
  createV4GeneratedClaimId,
  evaluateSemanticQualityV4,
  evaluateV4Thresholds,
  type V4EvaluationOutcome,
  type V4QualityMetrics,
} from "./semantic-quality-v4-evaluation.js";
import {
  assertSemanticQualityV4Manifest,
  canonicalIntegerJson,
  canonicalSha256,
  createSemanticQualityV4Manifest,
  evaluateV4QualificationReadiness,
} from "./semantic-quality-v4-manifest.js";

describe("meeting-memory V4 frozen provider-free corpus", () => {
  it("preserves the exact primary corpus and adds only bounded adversarial topology", () => {
    const corpus = frozenSemanticQualityCorpusV4();
    const base = frozenSemanticQualityCorpus();
    const human = corpus.humanReviewQuestions;
    expect(corpus.primaryMeeting.humanTurns).toHaveLength(421);
    expect(corpus.primaryMeeting.humanTurns.at(-1)?.endMs).toBe(8_418_500);
    expect(corpus.automatedQuestions).toHaveLength(200);
    expect(corpus.automatedQuestions.filter(({ kind }) => kind === "answerable")).toHaveLength(100);
    expect(corpus.automatedQuestions.filter(({ kind }) => kind === "unsupported")).toHaveLength(100);
    expect(corpus.fixtureComponents.primaryTurnOverrides).toHaveLength(16);
    expect(corpus.auxiliaryTurns).toHaveLength(112);
    expect(corpus.fixtureComponents.factFamilyNegatives).toHaveLength(100);
    expect(new Set(corpus.auxiliaryTurns.map(({ meetingId }) => meetingId)).size).toBe(6);
    expect(corpus.auxiliaryTurns.filter(({ endMs }) => endMs === 120_000)).toHaveLength(6);
    expect(corpus.automatedQuestions.filter(({ tags }) => tags.includes("cross-scope")))
      .toHaveLength(12);
    expect(corpus.automatedQuestions.filter(({ tags }) => tags.includes("correction")).length)
      .toBeGreaterThanOrEqual(16);

    expect(human).toHaveLength(40);
    expect(human.filter(({ kind }) => kind === "answerable")).toHaveLength(20);
    expect(human.filter(({ kind }) => kind === "unsupported")).toHaveLength(20);
    expect(human.filter(({ locale }) => locale === "en")).toHaveLength(12);
    expect(human.filter(({ locale }) => locale === "ru")).toHaveLength(12);
    expect(human.filter(({ locale }) => locale === "mixed")).toHaveLength(16);
    expect(human.every(({ reviewStatus }) => reviewStatus === "unreviewed")).toBe(true);
    expect(tagCount(human, "asr-text-challenge")).toBeGreaterThanOrEqual(8);
    expect(tagCount(human, "overlap")).toBeGreaterThanOrEqual(6);
    expect(tagCount(human, "alias")).toBeGreaterThanOrEqual(8);
    expect(tagCount(human, "ambiguous-alias")).toBeGreaterThanOrEqual(4);
    expect(tagCount(human, "correction")).toBeGreaterThanOrEqual(8);
    expect(tagCount(human, "contradiction")).toBeGreaterThanOrEqual(8);
    expect(tagCount(human, "multi-hop")).toBeGreaterThanOrEqual(8);
    expect(tagCount(human, "cross-scope")).toBe(12);
    expect(tagCount(human, "natural-paraphrase")).toBe(40);
    const v4ById = new Map(corpus.automatedQuestions.map((question) => [question.id, question]));
    const baseTurns = new Map(base.meeting.humanTurns.map((turn) => [turn.turnId, turn]));
    const v4Turns = new Map(corpus.primaryMeeting.humanTurns.map((turn) => [turn.turnId, turn]));
    for (const question of base.questions) {
      const v4 = v4ById.get(question.id);
      expect(v4?.kind).toBe(question.kind);
      expect(v4?.expectedClaimIds).toEqual(question.expectedClaimIds);
      expect(v4?.contradictedClaimIds).toEqual(question.contradictedClaimIds);
      expect(v4?.distractorTurnIds).toEqual(question.distractorTurnIds);
      expect(question.goldTurnIds.every((turnId) =>
        v4 !== undefined && v4.goldTurnIds.includes(turnId))).toBe(true);
      for (const turnId of [...question.goldTurnIds, ...question.distractorTurnIds]) {
        expect(v4Turns.get(turnId)).toEqual(baseTurns.get(turnId));
      }
    }
    for (const turnId of [...base.profile.asrNoiseTurnIds,
      ...base.profile.interruptionTurnIds]) {
      expect(v4Turns.get(turnId)).toEqual(baseTurns.get(turnId));
    }
  });

  it("canonically binds every component without float serialization or qualification claims", () => {
    const corpus = frozenSemanticQualityCorpusV4();
    const first = createSemanticQualityV4Manifest(corpus);
    const second = createSemanticQualityV4Manifest(corpus);
    expect(first).toEqual(second);
    expect(JSON.parse(readFileSync(new URL(
      "./fixtures/meeting-memory-v4/manifest.v4.json",
      import.meta.url,
    ), "utf8"))).toEqual(first);
    expect(Object.values(first.components).every((digest: unknown) =>
      typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest)))
      .toBe(true);
    expect(first.corpus).toMatchObject({ primaryDurationMs: 8_418_500,
      primaryTurnCount: 421, totalDurationMs: 10_658_500 });
    expect(first.questionSets.automated).toMatchObject({ answerable: 100, count: 200,
      unsupported: 100 });
    expect(first.questionSets.humanReviewCandidates).toMatchObject({ answerable: 20,
      count: 40, locales: { en: 12, mixed: 16, ru: 12 }, reviewStatus: "unreviewed",
      unsupported: 20 });
    expect(first.qualification).toEqual({
      exactBindingRealRunsPresent: 0,
      independentAnswerAdjudicationReceiptsPresent: 0,
      independentQuestionReviewReceiptsPresent: 0,
      requiredExactBindingRealRuns: 3,
      requiredIndependentAnswerAdjudicationReceipts: 2,
      requiredIndependentQuestionReviewReceipts: 2,
      status: "unqualified",
    });
    expect(canonicalIntegerJson({ ratio: { denominator: 10, numerator: 9 } }))
      .toBe('{"ratio":{"denominator":10,"numerator":9}}');
    expect(() => canonicalIntegerJson({ fabricatedFloat: 0.9 })).toThrow(/safe integer/u);
  });

  it("fails manifest verification on mutation, reordering, count, or classification drift", () => {
    const corpus = frozenSemanticQualityCorpusV4();
    const manifest = createSemanticQualityV4Manifest(corpus);
    const firstTurn = corpus.primaryMeeting.humanTurns[0];
    const firstQuestion = corpus.automatedQuestions[0];
    if (firstTurn === undefined || firstQuestion === undefined) {throw new Error("missing V4 fixture");}
    const mutation = replaceCorpus(corpus, { primaryMeeting: { ...corpus.primaryMeeting,
      humanTurns: [{ ...firstTurn, text: `${firstTurn.text} mutated` },
        ...corpus.primaryMeeting.humanTurns.slice(1)] } });
    const reordered = replaceCorpus(corpus, { automatedQuestions:
      [corpus.automatedQuestions[1] ?? firstQuestion, firstQuestion,
        ...corpus.automatedQuestions.slice(2)] });
    const countDrift = replaceCorpus(corpus, { humanReviewQuestions:
      corpus.humanReviewQuestions.slice(1) });
    const classificationDrift = replaceCorpus(corpus, { automatedQuestions: [
      { ...firstQuestion, kind: "unsupported", expectedClaimIds: [],
        goldTurnIds: [] },
      ...corpus.automatedQuestions.slice(1),
    ] });
    const authorityDrift = replaceCorpus(corpus, { globalForbiddenLocatorIds: [] });
    const expectedClaimDrift = replaceCorpus(corpus, { automatedQuestions: [
      { ...firstQuestion, expectedClaimIds: ["forged-gold"] },
      ...corpus.automatedQuestions.slice(1),
    ] });
    const overrideDrift = replaceCorpus(corpus, { fixtureComponents: {
      ...corpus.fixtureComponents,
      primaryTurnOverrides: corpus.fixtureComponents.primaryTurnOverrides.slice(1),
    } });
    for (const changed of [mutation, reordered, countDrift, classificationDrift,
      authorityDrift, expectedClaimDrift, overrideDrift]) {
      expect(() => {assertSemanticQualityV4Manifest(manifest, changed);}).toThrow();
    }
  });

  it("keeps absent and provider-free run evidence explicitly unqualified", () => {
    expect(evaluateV4QualificationReadiness({
      independentQuestionReviewReceiptDigests: [], runs: [],
    })).toEqual({
      blockers: ["exact_binding_real_runs", "threshold_runs", "question_review_receipts",
        "answer_adjudication_receipts", "independent_evidence_unverified"],
      status: "unqualified",
    });
    const manifest = createSemanticQualityV4Manifest();
    const binding = {
      answerModelConfigurationSha256: "fixture-only",
      automatedQuestionSetSha256: manifest.questionSets.automated.questionSetSha256,
      capabilityFingerprintSha256: "fixture-only",
      corpusSha256: manifest.corpus.corpusSha256,
      embeddingProfileSha256: "fixture-only",
      humanQuestionSetSha256:
        manifest.questionSets.humanReviewCandidates.questionSetSha256,
      rootManifestSha256: manifest.manifestSha256,
      releaseRevision: "fixture-only",
      releaseTree: "fixture-only",
      runtimeRevision: "fixture-only",
      sdkPackageSha256: "fixture-only",
      serviceRevision: "fixture-only",
      tokenizerSha256: "fixture-only",
      thresholdProfileSha256: manifest.evaluation.thresholdProfileSha256,
    };
    expect(evaluateV4QualificationReadiness({
      independentQuestionReviewReceiptDigests: [],
      runs: [1, 2, 3].map((repetition) => ({
        adjudicatedOutcomesSha256: "fixture-only", binding, failedThresholdIds: [],
        independentAnswerAdjudicationReceiptDigests: [], repetition,
        runResultSha256: "fixture-only",
        runKind: "provider_free_fixture" as const })),
    }).status).toBe("unqualified");
  });

  it("rejects malformed corpus references and auxiliary topology", () => {
    const corpus = frozenSemanticQualityCorpusV4();
    const first = corpus.automatedQuestions[0];
    const wrongScopeIndex = corpus.auxiliaryTurns.findIndex(({ meetingId }) =>
      meetingId === "fixture-quality-wrong-scope-meeting");
    if (first === undefined || wrongScopeIndex < 0) {throw new Error("missing V4 fixture");}
    const badGold = replaceCorpus(corpus, { automatedQuestions: [{ ...first,
      goldLocatorRelevance: [{ locatorId: "missing-turn", relevance: 3 }],
      goldTurnIds: ["missing-turn"] }, ...corpus.automatedQuestions.slice(1)] });
    const duplicateGold = replaceCorpus(corpus, { automatedQuestions: [{ ...first,
      goldLocatorRelevance: [...first.goldLocatorRelevance, first.goldLocatorRelevance[0] ??
        { locatorId: "missing-turn", relevance: 3 }],
      goldTurnIds: [...first.goldTurnIds, first.goldTurnIds[0] ?? "missing-turn"] },
    ...corpus.automatedQuestions.slice(1)] });
    const wrongScopeTurns = [...corpus.auxiliaryTurns];
    const wrongScope = wrongScopeTurns[wrongScopeIndex];
    if (wrongScope === undefined) {throw new Error("missing wrong-scope fixture");}
    wrongScopeTurns[wrongScopeIndex] = { ...wrongScope, roomId: "not-primary-room" };
    const badTopology = replaceCorpus(corpus, { auxiliaryTurns: wrongScopeTurns });
    const badForbidden = replaceCorpus(corpus, { humanReviewQuestions: [{
      ...corpus.humanReviewQuestions[0]!, forbiddenLocatorIds: [first.goldTurnIds[0] ?? ""],
    }, ...corpus.humanReviewQuestions.slice(1)] });
    const firstPatch = corpus.fixtureComponents.automatedQuestionPatches[0];
    if (firstPatch === undefined) {throw new Error("missing patch fixture");}
    const badPatch = replaceCorpus(corpus, { fixtureComponents: {
      ...corpus.fixtureComponents, automatedQuestionPatches: [{ ...firstPatch,
        addGoldTurnIds: ["missing-turn"] },
      ...corpus.fixtureComponents.automatedQuestionPatches.slice(1)],
    } });
    const firstOverride = corpus.fixtureComponents.primaryTurnOverrides[0];
    if (firstOverride === undefined) {throw new Error("missing override fixture");}
    const boundOverride = replaceCorpus(corpus, { fixtureComponents: {
      ...corpus.fixtureComponents, primaryTurnOverrides: [{ ...firstOverride,
        turnId: "quality-turn-007" }, ...corpus.fixtureComponents.primaryTurnOverrides.slice(1)],
    } });
    for (const changed of [badGold, duplicateGold, badTopology, badForbidden, badPatch,
      boundOverride]) {
      expect(() => {assertSemanticQualityV4CorpusIntegrity(changed);}).toThrow();
    }
  });

  it("never promotes digest-shaped placeholders without a trusted receipt verifier", () => {
    const manifest = createSemanticQualityV4Manifest();
    const binding = {
      answerModelConfigurationSha256: "a".repeat(64),
      automatedQuestionSetSha256: manifest.questionSets.automated.questionSetSha256,
      capabilityFingerprintSha256: "b".repeat(64),
      corpusSha256: manifest.corpus.corpusSha256,
      embeddingProfileSha256: "c".repeat(64),
      humanQuestionSetSha256: manifest.questionSets.humanReviewCandidates.questionSetSha256,
      releaseRevision: "d".repeat(40), releaseTree: "e".repeat(40),
      rootManifestSha256: manifest.manifestSha256, runtimeRevision: "a".repeat(40),
      sdkPackageSha256: "d".repeat(64), serviceRevision: "b".repeat(40),
      thresholdProfileSha256: manifest.evaluation.thresholdProfileSha256,
      tokenizerSha256: "e".repeat(64),
    };
    const readiness = evaluateV4QualificationReadiness({
      independentQuestionReviewReceiptDigests: ["1".repeat(64), "2".repeat(64)],
      runs: [1, 2, 3].map((repetition) => ({
        adjudicatedOutcomesSha256: `${repetition}`.repeat(64), binding,
        failedThresholdIds: [], independentAnswerAdjudicationReceiptDigests:
          ["3".repeat(64), "4".repeat(64)], repetition,
        runKind: "real_exact_binding" as const, runResultSha256: `${repetition + 4}`.repeat(64),
      })),
    });
    expect(readiness.status).toBe("unqualified");
    expect(readiness.blockers).toEqual(["independent_evidence_unverified"]);
    for (const changedBinding of [
      { ...binding, automatedQuestionSetSha256: "f".repeat(64) },
      { ...binding, rootManifestSha256: "f".repeat(64) },
      { ...binding, thresholdProfileSha256: "f".repeat(64) },
    ]) {
      const changed = evaluateV4QualificationReadiness({
        independentQuestionReviewReceiptDigests: ["1".repeat(64), "2".repeat(64)],
        runs: [1, 2, 3].map((repetition) => ({
          adjudicatedOutcomesSha256: `${repetition}`.repeat(64), binding: changedBinding,
          failedThresholdIds: [], independentAnswerAdjudicationReceiptDigests:
            ["3".repeat(64), "4".repeat(64)], repetition,
          runKind: "real_exact_binding" as const,
          runResultSha256: `${repetition + 4}`.repeat(64),
        })),
      });
      expect(changed.blockers).toContain("exact_binding_match");
    }
    const substitutedRun = evaluateV4QualificationReadiness({
      independentQuestionReviewReceiptDigests: ["1".repeat(64), "2".repeat(64)],
      runs: [1, 2, 3].map((repetition) => ({
        adjudicatedOutcomesSha256: "5".repeat(64), binding, failedThresholdIds: [],
        independentAnswerAdjudicationReceiptDigests: ["3".repeat(64), "4".repeat(64)],
        repetition, runKind: "real_exact_binding" as const,
        runResultSha256: "5".repeat(64),
      })),
    });
    expect(substitutedRun.blockers).toContain("threshold_runs");
  });
});

describe("meeting-memory V4 exact rational metrics and thresholds", () => {
  it("scores ranked opaque top-10 inputs and applies only preregistered gates", () => {
    const corpus = frozenSemanticQualityCorpusV4();
    const metrics = evaluateSemanticQualityV4({ outcomes: perfectOutcomes(corpus) });
    expect(metrics.completeQuestionRecallAt5).toEqual({ denominator: 120, numerator: 118 });
    expect(metrics.completeQuestionRecallAt10).toEqual({ denominator: 120, numerator: 120 });
    expect(metrics.mrrAt10).toEqual({ denominator: 302_400, numerator: 302_400 });
    expect(metrics.ndcgAt10.numerator).toBe(metrics.ndcgAt10.denominator);
    expect(metrics.finalAnswerRecall.numerator).toBe(metrics.finalAnswerRecall.denominator);
    expect(metrics.abstentionPrecision).toEqual({ denominator: 120, numerator: 120 });
    expect(metrics.abstentionRecall).toEqual({ denominator: 120, numerator: 120 });
    expect(metrics.citationMembership.numerator).toBe(metrics.citationMembership.denominator);
    expect(metrics.speakerAccuracy.numerator).toBe(metrics.speakerAccuracy.denominator);
    expect(metrics.timeAccuracy.numerator).toBe(metrics.timeAccuracy.denominator);
    expect(metrics.crossScopeLeakageCount).toBe(0);
    expect(metrics.timeoutCount).toBe(0);
    expect(metrics.failureCount).toBe(0);
    expect(metrics.answerableCoverageFailureCount).toBe(0);
    expect(metrics.answerableExecutionFailureCount).toBe(0);
    expect(metrics.externallyAdjudicatedFactualClaimCount).toBe(0);
    expect(evaluateV4Thresholds(metrics)).toEqual({ failedGateIds: [], passed: true,
      reportedOnlyMetricIds: ["block_locator_recall_at_10",
        "complete_question_recall_at_10", "ndcg_at_10"] });
  });

  it("counts timeout and failure questions in quality and latency denominators", () => {
    const corpus = frozenSemanticQualityCorpusV4();
    const outcomes = perfectOutcomes(corpus);
    const answerable = corpus.automatedQuestions.find(({ kind }) => kind === "answerable");
    const unsupported = corpus.automatedQuestions.find(({ kind }) => kind === "unsupported");
    if (answerable === undefined || unsupported === undefined) {throw new Error("missing V4 cases");}
    replaceOutcome(outcomes, answerable.id, (outcome) => ({ ...outcome,
      adjudications: [], citationEntailments: [], locallyRehydratedEvidence: [],
      answer: { claims: [], status: "timeout" }, retrieval: { ...outcome.retrieval,
        expandedNeighborLocators: [], rankedSeedLocators: [], status: "timeout" } }));
    replaceOutcome(outcomes, unsupported.id, (outcome) => ({ ...outcome,
      adjudications: [], citationEntailments: [], answer: { claims: [], status: "failure" }, retrieval: { ...outcome.retrieval,
        status: "failure" } }));
    const metrics = evaluateSemanticQualityV4({ outcomes });
    expect(metrics.completeQuestionRecallAt5).toEqual({ denominator: 120, numerator: 117 });
    expect(metrics.finalAnswerRecall.numerator).toBeLessThan(metrics.finalAnswerRecall.denominator);
    expect(metrics.abstentionRecall).toEqual({ denominator: 120, numerator: 119 });
    expect(metrics.timeoutCount).toBe(1);
    expect(metrics.failureCount).toBe(1);
    expect(metrics.answerableCoverageFailureCount).toBe(1);
    expect(metrics.answerableExecutionFailureCount).toBe(1);
    expect(metrics.resources.retrievalLatencyP95Us).toBe(200_000);
  });

  it("detects foreign locators, citation drift, unsupported claims, latency, and input excess", () => {
    const corpus = frozenSemanticQualityCorpusV4();
    const outcomes = perfectOutcomes(corpus);
    const crossScope = corpus.automatedQuestions
      .find(({ forbiddenLocatorIds }) => forbiddenLocatorIds.length === 0);
    const answerable = corpus.automatedQuestions.find(({ kind }) => kind === "answerable");
    const unsupported = corpus.automatedQuestions.find(({ kind }) => kind === "unsupported");
    if (crossScope === undefined || answerable === undefined || unsupported === undefined) {
      throw new Error("missing V4 adversarial cases");
    }
    replaceOutcome(outcomes, crossScope.id, (outcome) => ({ ...outcome, retrieval: {
      ...outcome.retrieval,
      rankedSeedLocators: [{ locatorId: corpus.globalForbiddenLocatorIds.at(-1) ?? "" }],
    } }));
    replaceOutcome(outcomes, answerable.id, (outcome) => {
      const claim = outcome.answer.claims[0];
      const citation = claim?.citationRefs[0];
      if (claim === undefined || citation === undefined) {throw new Error("missing citation");}
      return withReidentifiedClaims({ ...outcome, locallyRehydratedEvidence: [],
        prompt: corpus.primaryMeeting.humanTurns.map(({ text }) => text).join("\n"),
        answerMeasurement: { ...outcome.answerMeasurement,
          repairInput: { ...outcome.answerMeasurement.repairInput,
            fullInputBytes: 16_001,
            systemPromptBytes: 16_001 -
              outcome.answerMeasurement.repairInput.outputSchemaBytes -
              outcome.answerMeasurement.repairInput.userPromptBytes - 2 } },
        answer: { ...outcome.answer, claims: [{ ...claim, citationRefs: [{ ...citation,
          endMs: citation.endMs + 1, speakerId: "wrong-speaker" }] },
          ...outcome.answer.claims.slice(1)] } });
    });
    const unsupportedCitation = corpus.primaryMeeting.humanTurns[0];
    if (unsupportedCitation === undefined) {throw new Error("missing canonical turn");}
    replaceOutcome(outcomes, unsupported.id, (outcome) => {
      const citationRefs = [{ endMs: unsupportedCitation.endMs,
        speakerId: unsupportedCitation.speakerId, startMs: unsupportedCitation.startMs,
        turnId: unsupportedCitation.turnId }];
      const text = `Synthetic unsupported claim for ${outcome.queryId}`;
      const claimPayloadSha256 = canonicalSha256({ factual: true, text });
      const claimId = createV4GeneratedClaimId({ citationRefs, claimOrdinal: 0,
        claimPayloadSha256, factual: true, queryId: outcome.queryId });
      return { ...outcome, adjudications: [{ claimId, factuality: "factual",
        matchedGoldClaimId: null,
        status: "finalized", verdict: "unsupported" }],
      citationEntailments: [{ claimId, status: "finalized", turnId: unsupportedCitation.turnId,
        verdict: "entails" }],
      locallyRehydratedEvidence: [{ ...unsupportedCitation,
        sourceLocatorId: unsupportedCitation.turnId }],
      retrieval: { ...outcome.retrieval, expandedNeighborLocators: [
        ...outcome.retrieval.expandedNeighborLocators,
        { locatorId: unsupportedCitation.turnId },
      ] },
      answer: { status: "answered", claims: [{ citationRefs, claimId,
        claimPayloadSha256, factual: true, text }] } };
    });
    for (let index = 0; index < 8; index += 1) {
      const current = outcomes[index];
      if (current !== undefined) {outcomes[index] = withReidentifiedClaims({ ...current,
        locallyRehydratedEvidence: [],
        answer: { ...current.answer, claims: current.answer.claims.map((claim) => ({ ...claim,
          citationRefs: claim.citationRefs.map((citation) => ({ ...citation,
            endMs: citation.endMs + 1, speakerId: "wrong-speaker" })) })) } });}
    }
    for (let index = 0; index < 13; index += 1) {
      const current = outcomes[index];
      if (current !== undefined) {outcomes[index] = { ...current,
        retrieval: { ...current.retrieval, latencyUs: 3_000_001 } };}
    }
    const metrics = evaluateSemanticQualityV4({ outcomes });
    const decision = evaluateV4Thresholds(metrics);
    expect(metrics.crossScopeLeakageCount).toBe(1);
    expect(metrics.unsupportedFactualClaimCount).toBe(1);
    expect(metrics.resources.retrievalLatencyP95Us).toBe(3_000_001);
    expect(decision.failedGateIds).toEqual(expect.arrayContaining([
      "bounded_input", "citation_membership", "cross_scope_leakage",
      "retrieval_latency_p95", "speaker_accuracy", "time_accuracy",
      "unsupported_factual_claims", "whole_transcript",
    ]));
  });

  it("fails selective answer coverage even when the one emitted claim is supported", () => {
    const corpus = frozenSemanticQualityCorpusV4();
    const outcomes = perfectOutcomes(corpus);
    const answerableIds = new Set([...corpus.automatedQuestions, ...corpus.humanReviewQuestions]
      .filter(({ kind }) => kind === "answerable").map(({ id }) => id));
    let retained = false;
    for (let index = 0; index < outcomes.length; index += 1) {
      const outcome = outcomes[index];
      if (outcome !== undefined && answerableIds.has(outcome.queryId)) {
        if (!retained) {retained = true; continue;}
        outcomes[index] = { ...outcome, adjudications: [], citationEntailments: [],
          answer: { claims: [], status: "abstained" } };
      }
    }
    const metrics = evaluateSemanticQualityV4({ outcomes });
    expect(metrics.answerableCoverageFailureCount).toBe(119);
    expect(metrics.finalAnswerRecall.numerator).toBeLessThan(metrics.finalAnswerRecall.denominator);
    expect(evaluateV4Thresholds(metrics).failedGateIds)
      .toContain("answerable_execution_coverage");
  });

  it("closes the 113/120 to 133/140 duplicate-citation false-PASS attack", () => {
    const corpus = frozenSemanticQualityCorpusV4();
    const outcomes = oneClaimPerAnswerableOutcomes(corpus);
    for (let index = 0; index < 7; index += 1) {
      const current = outcomes[index];
      if (current === undefined) {throw new Error("missing attack outcome");}
      outcomes[index] = withReidentifiedClaims({ ...current,
        answer: { ...current.answer, claims: current.answer.claims.map((claim) => ({ ...claim,
          citationRefs: claim.citationRefs.map((citation) => ({ ...citation,
            endMs: citation.endMs + 1, speakerId: "wrong-speaker" })) })) } });
    }
    const before = evaluateSemanticQualityV4({ outcomes });
    expect(before.speakerAccuracy).toEqual({ denominator: 120, numerator: 113 });
    expect(before.timeAccuracy).toEqual({ denominator: 120, numerator: 113 });
    const target = outcomes[7];
    const claim = target?.answer.claims[0];
    const citation = claim?.citationRefs[0];
    if (target === undefined || claim === undefined || citation === undefined) {
      throw new Error("missing duplicate citation target");
    }
    outcomes[7] = { ...target, answer: { ...target.answer, claims: [{ ...claim,
      citationRefs: [...claim.citationRefs, ...Array.from({ length: 20 }, () => citation)] }] } };
    const after = evaluateSemanticQualityV4({ outcomes });
    expect(after).toEqual(before);
    expect(evaluateV4Thresholds(after)).toEqual(evaluateV4Thresholds(before));
  });

  it("closes the 120/125 to 170/175 duplicate-claim false-PASS attack", () => {
    const corpus = frozenSemanticQualityCorpusV4();
    const outcomes = oneClaimPerAnswerableOutcomes(corpus);
    for (let index = 0; index < 5; index += 1) {
      const outcome = outcomes[index];
      const turn = corpus.primaryMeeting.humanTurns[400 + index];
      if (outcome === undefined || turn === undefined) {throw new Error("missing attack fixture");}
      outcomes[index] = appendFinalClaim(outcome, turn, "unsupported", null);
    }
    const before = evaluateSemanticQualityV4({ outcomes });
    expect(before.claimPrecision).toEqual({ denominator: 125, numerator: 120 });
    expect(evaluateV4Thresholds(before).failedGateIds).toContain("claim_precision");
    const target = outcomes[5];
    const claim = target?.answer.claims[0];
    const adjudication = target?.adjudications[0];
    if (target === undefined || claim === undefined || adjudication === undefined) {
      throw new Error("missing duplicate claim target");
    }
    const repeatedClaims = Array.from({ length: 50 }, (_, index) => {
      const claimId = createV4GeneratedClaimId({ citationRefs: claim.citationRefs,
        claimOrdinal: index + 1, claimPayloadSha256: claim.claimPayloadSha256,
        factual: claim.factual, queryId: target.queryId });
      return { ...claim, claimId };
    });
    outcomes[5] = { ...target,
      adjudications: [...target.adjudications, ...repeatedClaims.map(({ claimId }) =>
        ({ ...adjudication, claimId }))],
      answer: { ...target.answer, claims: [...target.answer.claims, ...repeatedClaims] } };
    expect(() => evaluateSemanticQualityV4({ outcomes })).toThrow(/exact claim payload/u);
  });
});

describe("meeting-memory V4 scorer input integrity", () => {
  it("allows distinct stable claims to share gold and rejects duplicate claim IDs", () => {
    const corpus = frozenSemanticQualityCorpusV4();
    const outcomes = perfectOutcomes(corpus);
    const answerable = corpus.automatedQuestions.find(({ kind }) => kind === "answerable");
    const turn = corpus.primaryMeeting.humanTurns[410];
    if (answerable === undefined || turn === undefined) {throw new Error("missing claim case");}
    const before = evaluateSemanticQualityV4({ outcomes });
    replaceOutcome(outcomes, answerable.id, (outcome) => appendFinalClaim(outcome, turn,
      "supported", answerable.expectedClaimIds[0] ?? null));
    const after = evaluateSemanticQualityV4({ outcomes });
    expect(after.finalAnswerRecall).toEqual(before.finalAnswerRecall);
    expect(after.claimPrecision).toEqual({ denominator: before.claimPrecision.denominator + 1,
      numerator: before.claimPrecision.numerator + 1 });
    replaceOutcome(outcomes, answerable.id, (outcome) => ({ ...outcome,
      adjudications: [...outcome.adjudications, outcome.adjudications[0]!],
      answer: { ...outcome.answer, claims: [...outcome.answer.claims,
        outcome.answer.claims[0]!] } }));
    expect(() => evaluateSemanticQualityV4({ outcomes })).toThrow(/duplicate or unbound/u);
  });

  it("computes macro per-question nDCG with fixed integer micro semantics", () => {
    const corpus = frozenSemanticQualityCorpusV4();
    const outcomes = perfectOutcomes(corpus);
    const richest = [...corpus.automatedQuestions, ...corpus.humanReviewQuestions]
      .filter(({ kind }) => kind === "answerable")
      .toSorted((left, right) => right.goldLocatorRelevance.length -
        left.goldLocatorRelevance.length)[0];
    if (richest === undefined) {throw new Error("missing nDCG fixture");}
    replaceOutcome(outcomes, richest.id, (outcome) => ({ ...outcome,
      retrieval: { ...outcome.retrieval,
        expandedNeighborLocators: [...outcome.retrieval.expandedNeighborLocators,
          ...outcome.retrieval.rankedSeedLocators], rankedSeedLocators: [] } }));
    expect(evaluateSemanticQualityV4({ outcomes }).ndcgAt10)
      .toEqual({ denominator: 120_000_000, numerator: 119_000_000 });
  });

  it("scores final-answer recall as whole-question recall for partial multi-hop answers", () => {
    const corpus = frozenSemanticQualityCorpusV4();
    const outcomes = perfectOutcomes(corpus);
    const multiHop = corpus.automatedQuestions.find(({ expectedClaimIds, kind }) =>
      kind === "answerable" && expectedClaimIds.length > 1);
    if (multiHop === undefined) {throw new Error("missing multi-hop fixture");}
    replaceOutcome(outcomes, multiHop.id, (outcome) => ({ ...outcome,
      adjudications: outcome.adjudications.slice(0, 1),
      citationEntailments: outcome.citationEntailments.filter(({ claimId }) =>
        claimId === outcome.answer.claims[0]?.claimId),
      answer: { ...outcome.answer, claims: outcome.answer.claims.slice(0, 1) } }));
    expect(evaluateSemanticQualityV4({ outcomes }).finalAnswerRecall)
      .toEqual({ denominator: 120, numerator: 119 });
  });

  it("rejects caller corpus, authority, question, component, override, and manifest substitution", () => {
    const corpus = frozenSemanticQualityCorpusV4();
    const substitutions = [
      { corpus: { ...corpus, globalForbiddenLocatorIds: [] } },
      { corpus: { ...corpus, humanReviewQuestions: [{ ...corpus.humanReviewQuestions[0]!,
        goldTurnIds: [] }, ...corpus.humanReviewQuestions.slice(1)] } },
      { corpus: { ...corpus, automatedQuestions: [{ ...corpus.automatedQuestions[0]!,
        expectedClaimIds: ["forged-gold"] }, ...corpus.automatedQuestions.slice(1)] } },
      { corpus: { ...corpus, auxiliaryTurns: corpus.auxiliaryTurns.slice(1) } },
      { corpus: { ...corpus, fixtureComponents: { ...corpus.fixtureComponents,
        primaryTurnOverrides: corpus.fixtureComponents.primaryTurnOverrides.slice(1) } } },
      { manifest: createSemanticQualityV4Manifest(corpus) },
    ];
    for (const substitution of substitutions) {
      expect(() => evaluateSemanticQualityV4({ outcomes: [], ...substitution }))
        .toThrow(/scorer input.*object shape/u);
    }
  });

  it("runtime-rejects every unknown status, verdict, adjudication kind, and pending final state", () => {
    const corpus = frozenSemanticQualityCorpusV4();
    const answerable = corpus.automatedQuestions.find(({ kind }) => kind === "answerable");
    const unsupported = corpus.automatedQuestions.find(({ kind }) => kind === "unsupported");
    if (answerable === undefined || unsupported === undefined) {throw new Error("missing cases");}
    const mutations: Array<{ readonly queryId: string;
      readonly update: (outcome: V4EvaluationOutcome) => unknown }> = [
      { queryId: answerable.id, update: (outcome) => ({ ...outcome,
        answer: { ...outcome.answer, status: "unknown" } }) },
      { queryId: answerable.id, update: (outcome) => ({ ...outcome,
        retrieval: { ...outcome.retrieval, status: "unknown" } }) },
      { queryId: answerable.id, update: (outcome) => ({ ...outcome,
        adjudicationKind: "unknown" }) },
      { queryId: answerable.id, update: (outcome) => ({ ...outcome,
        adjudications: [{ ...outcome.adjudications[0]!, verdict: "malformed" }],
      }) },
      { queryId: answerable.id, update: (outcome) => ({ ...outcome,
        adjudications: [{ ...outcome.adjudications[0]!, verdict: "pending" }],
      }) },
      { queryId: answerable.id, update: (outcome) => ({ ...outcome,
        adjudications: [{ ...outcome.adjudications[0]!, status: "pending" }],
      }) },
      { queryId: unsupported.id, update: (outcome) => ({ ...outcome,
        answer: { ...outcome.answer, status: "malformed" },
        retrieval: { ...outcome.retrieval, status: "malformed" },
      }) },
    ];
    for (const mutation of mutations) {
      const outcomes = perfectOutcomes(corpus);
      replaceMalformedOutcome(outcomes, mutation.queryId, mutation.update);
      expect(() => evaluateSemanticQualityV4({ outcomes })).toThrow(/invalid/u);
    }
  }, 20_000);

  it("rejects an answerable coverage hit without a supported factual claim", () => {
    const corpus = frozenSemanticQualityCorpusV4();
    const outcomes = perfectOutcomes(corpus);
    const answerable = corpus.automatedQuestions.find(({ kind }) => kind === "answerable");
    if (answerable === undefined) {throw new Error("missing answerable case");}
    replaceOutcome(outcomes, answerable.id, (outcome) => ({ ...outcome,
      adjudications: outcome.adjudications.map((item) => ({ ...item,
        matchedGoldClaimId: null, verdict: "unsupported" })) }));
    expect(() => evaluateSemanticQualityV4({ outcomes })).toThrow(/supported factual claim/u);
  });

  it("rejects supplied gold, unknown or duplicate ranks, missing outcomes, and empty answers", () => {
    const corpus = frozenSemanticQualityCorpusV4();
    const answerable = corpus.automatedQuestions.find(({ kind }) => kind === "answerable");
    if (answerable === undefined) {throw new Error("missing answerable fixture");}
    const supplied = perfectOutcomes(corpus);
    replaceOutcome(supplied, answerable.id, (outcome) => ({ ...outcome, retrieval: {
      ...outcome.retrieval, goldLocatorRelevance: [{ locatorId: "fabricated", relevance: 3 }],
    } } as V4EvaluationOutcome));
    expect(() => evaluateSemanticQualityV4({ outcomes: supplied })).toThrow(/object shape/u);
    const unknown = perfectOutcomes(corpus);
    replaceOutcome(unknown, answerable.id, (outcome) => ({ ...outcome, retrieval: {
      ...outcome.retrieval, rankedSeedLocators: [{ locatorId: "unknown-locator" }],
    } }));
    expect(() => evaluateSemanticQualityV4({ outcomes: unknown })).toThrow(/rank-10/u);
    const duplicate = perfectOutcomes(corpus);
    replaceOutcome(duplicate, answerable.id, (outcome) => ({ ...outcome, retrieval: {
      ...outcome.retrieval, rankedSeedLocators: [outcome.retrieval.rankedSeedLocators[0]!,
        outcome.retrieval.rankedSeedLocators[0]!],
    } }));
    expect(() => evaluateSemanticQualityV4({ outcomes: duplicate })).toThrow(/rank-10/u);
    expect(() => evaluateSemanticQualityV4({
      outcomes: perfectOutcomes(corpus).slice(1) })).toThrow(/all 240/u);
    const empty = perfectOutcomes(corpus);
    replaceOutcome(empty, answerable.id, (outcome) => ({ ...outcome,
      adjudications: [], citationEntailments: [], answer: { claims: [], status: "answered" } }));
    expect(() => evaluateSemanticQualityV4({ outcomes: empty })).toThrow(/factual claim/u);
  }, 20_000);

  it("compares threshold rationals exactly rather than through floats", () => {
    const metrics = perfectMetrics();
    expect(evaluateV4Thresholds({ ...metrics,
      blockLocatorRecallAt5: { denominator: 10, numerator: 9 } }).failedGateIds)
      .not.toContain("block_locator_recall_at_5");
    expect(evaluateV4Thresholds({ ...metrics,
      completeQuestionRecallAt5: { denominator: 100, numerator: 89 } }).failedGateIds)
      .toContain("complete_question_recall_at_5");
    expect(evaluateV4Thresholds({ ...metrics,
      mrrAt10: { denominator: 5, numerator: 4 } }).failedGateIds)
      .not.toContain("mrr_at_10");
  });

});

function perfectOutcomes(corpus: FrozenSemanticQualityCorpusV4): V4EvaluationOutcome[] {
  const turns = new Map(corpus.primaryMeeting.humanTurns.map((turn) => [turn.turnId, turn]));
  return [...corpus.automatedQuestions, ...corpus.humanReviewQuestions]
    .map((question): V4EvaluationOutcome => {
    const claims = question.expectedClaimIds.map((goldClaimId, index) => {
      const turnId = question.goldTurnIds[index] ?? question.goldTurnIds[0];
      if (turnId === undefined) {throw new Error(`missing V4 turn ID for ${question.id}`);}
      const turn = turns.get(turnId);
      if (turn === undefined) {throw new Error(`missing V4 canonical turn for ${question.id}`);}
      const citationRefs = [{ endMs: turn.endMs, speakerId: turn.speakerId,
        startMs: turn.startMs, turnId }];
      const text = `Synthetic answer for ${question.id} claim ${goldClaimId}`;
      const claimPayloadSha256 = canonicalSha256({ factual: true, text });
      return { citationRefs,
        claimId: createV4GeneratedClaimId({ citationRefs, claimOrdinal: index,
          claimPayloadSha256, factual: true, queryId: question.id }),
        claimPayloadSha256, factual: true, text };
    });
    const locallyRehydratedEvidence = claims.flatMap(({ citationRefs }) =>
      citationRefs.map(({ turnId }) => {
        const evidence = turns.get(turnId);
        if (evidence === undefined) {throw new Error(`missing V4 evidence turn ${turnId}`);}
        return { ...evidence, sourceLocatorId: turnId };
      }));
    const prompt = `Answer canonical V4 question ${question.id} from admitted evidence.`;
    const userPromptBytes = new TextEncoder().encode(prompt).byteLength;
    const originalInput = { fullInputBytes: userPromptBytes + 42,
      outputSchemaBytes: 20, systemPromptBytes: 20, userPromptBytes };
    const repairInput = { fullInputBytes: userPromptBytes + 82,
      outputSchemaBytes: 20, systemPromptBytes: 60, userPromptBytes };
    return {
      adjudicationLatencyUs: 100_000,
      adjudicationKind: "synthetic_structural_fixture",
      adjudications: claims.map((claim, index) => ({ claimId: claim.claimId,
        factuality: "factual" as const,
        matchedGoldClaimId: question.expectedClaimIds[index] ?? null,
        status: "finalized" as const, verdict: "supported" as const })),
      citationEntailments: claims.flatMap((claim) => claim.citationRefs.map(({ turnId }) => ({
        claimId: claim.claimId, status: "finalized" as const, turnId, verdict: "entails" as const,
      }))),
      answer: { claims, status: question.kind === "answerable" ? "answered" : "abstained" },
      answerMeasurement: { answerLatencyUs: 300_000, attemptId: `fixture-${question.id}`,
        originalInput,
        originalModelInputSha256: canonicalSha256({ id: question.id, kind: "original-input" }),
        originalProviderRequestSha256: canonicalSha256({ id: question.id, kind: "provider-request" }),
        originalProviderResponseSha256: canonicalSha256({ id: question.id, kind: "provider-response" }),
        repairInput,
        repairModelInputSha256: canonicalSha256({ id: question.id, kind: "repair-input" }),
        repairProviderRequestSha256: null, repairProviderResponseSha256: null,
        responseBytes: 128, runtimeReceiptSha256: canonicalSha256({ id: question.id,
          kind: "runtime" }), responseRuntimeArtifactSha256: canonicalSha256({ id: question.id,
          kind: "response-runtime-artifact" }) },
      evidenceBytes: new TextEncoder().encode(JSON.stringify(locallyRehydratedEvidence)).byteLength,
      fullLatencyUs: 550_000,
      locallyRehydratedEvidence,
      locale: question.locale,
      prompt,
      promptBytes: repairInput.fullInputBytes,
      queryId: question.id,
      questionDigestSha256: canonicalSha256({ id: question.id, locale: question.locale,
        v4EvaluationQuestionText: v4EvaluationQuestionText(question) }),
      retrieval: {
        capabilityAndRetrievalLatencyUs: 200_000,
        capabilityBytes: 512,
        capabilitySha256: canonicalSha256({ id: question.id, kind: "capability" }),
        latencyUs: 200_000,
        expandedNeighborLocators: [],
        rankedSeedLocators: question.goldLocatorRelevance.map(({ locatorId }) => ({ locatorId })),
        requestBytes: 256,
        requestSha256: canonicalSha256({ id: question.id, kind: "request" }),
        requestSnapshotSha256: canonicalSha256({ id: question.id, kind: "request-snapshot" }),
        responseBytes: question.kind === "answerable" ? 128 : 32,
        responseSha256: canonicalSha256({ id: question.id, kind: "response" }),
        routeLatencyUs: 150_000,
        status: "completed" as const,
      },
    };
    });
}

function perfectMetrics(): V4QualityMetrics {
  const corpus = frozenSemanticQualityCorpusV4();
  return evaluateSemanticQualityV4({ outcomes: perfectOutcomes(corpus) });
}

function oneClaimPerAnswerableOutcomes(
  corpus: FrozenSemanticQualityCorpusV4,
): V4EvaluationOutcome[] {
  return perfectOutcomes(corpus).map((outcome) => outcome.answer.claims.length <= 1
    ? outcome
    : { ...outcome, adjudications: outcome.adjudications.slice(0, 1),
      citationEntailments: outcome.citationEntailments.filter(({ claimId }) =>
        claimId === outcome.answer.claims[0]?.claimId),
      answer: { ...outcome.answer, claims: outcome.answer.claims.slice(0, 1) } });
}

function withReidentifiedClaims(outcome: V4EvaluationOutcome): V4EvaluationOutcome {
  const claims = outcome.answer.claims.map((claim, claimOrdinal) => {
    const claimId = createV4GeneratedClaimId({ citationRefs: claim.citationRefs, claimOrdinal,
      claimPayloadSha256: claim.claimPayloadSha256, factual: claim.factual,
      queryId: outcome.queryId });
    return { ...claim, claimId };
  });
  return withRecomputedAccounting({ ...outcome,
    adjudications: claims.map((claim, index) => ({ ...outcome.adjudications[index]!,
      claimId: claim.claimId })),
    citationEntailments: claims.flatMap((claim) => claim.citationRefs.map(({ turnId }) => ({
      claimId: claim.claimId, status: "finalized" as const, turnId,
      verdict: outcome.citationEntailments.find((item) => item.turnId === turnId)?.verdict ??
        "entails" as const,
    }))), answer: { ...outcome.answer, claims } });
}

function appendFinalClaim(
  outcome: V4EvaluationOutcome,
  turn: FrozenSemanticQualityCorpusV4["primaryMeeting"]["humanTurns"][number],
  verdict: "stale" | "supported" | "unsupported",
  matchedGoldClaimId: string | null,
): V4EvaluationOutcome {
  const citationRefs = [{ endMs: turn.endMs, speakerId: turn.speakerId,
    startMs: turn.startMs, turnId: turn.turnId }];
  const text = `Synthetic distinct claim ${outcome.answer.claims.length} for ${outcome.queryId}`;
  const claimPayloadSha256 = canonicalSha256({ factual: true, text });
  const claimId = createV4GeneratedClaimId({ citationRefs,
    claimOrdinal: outcome.answer.claims.length, claimPayloadSha256,
    factual: true, queryId: outcome.queryId });
  return withRecomputedAccounting({ ...outcome,
    adjudications: [...outcome.adjudications, { claimId, factuality: "factual",
      matchedGoldClaimId,
      status: "finalized", verdict }],
    citationEntailments: [...outcome.citationEntailments, { claimId, status: "finalized",
      turnId: turn.turnId, verdict: "entails" }],
    locallyRehydratedEvidence: [...new Map([...outcome.locallyRehydratedEvidence,
      { ...turn, sourceLocatorId: turn.turnId }]
      .map((item) => [item.turnId, item])).values()],
    retrieval: { ...outcome.retrieval, expandedNeighborLocators: [
      ...outcome.retrieval.expandedNeighborLocators,
      ...([...outcome.retrieval.rankedSeedLocators, ...outcome.retrieval.expandedNeighborLocators]
        .some(({ locatorId }) => locatorId === turn.turnId) ? [] : [{ locatorId: turn.turnId }]),
    ] },
    answer: { ...outcome.answer,
      claims: [...outcome.answer.claims, { citationRefs, claimId, claimPayloadSha256,
        factual: true, text }] } });
}

function replaceOutcome(outcomes: V4EvaluationOutcome[], queryId: string,
  update: (outcome: V4EvaluationOutcome) => V4EvaluationOutcome): void {
  const index = outcomes.findIndex((outcome) => outcome.queryId === queryId);
  const current = outcomes[index];
  if (index < 0 || current === undefined) {throw new Error(`missing outcome ${queryId}`);}
  outcomes[index] = withRecomputedAccounting(update(current));
}

function withRecomputedAccounting(outcome: V4EvaluationOutcome): V4EvaluationOutcome {
  return { ...outcome,
    evidenceBytes: new TextEncoder().encode(JSON.stringify(outcome.locallyRehydratedEvidence))
      .byteLength,
    promptBytes: Math.max(outcome.answerMeasurement.originalInput.fullInputBytes,
      outcome.answerMeasurement.repairInput.fullInputBytes) };
}

function replaceMalformedOutcome(outcomes: V4EvaluationOutcome[], queryId: string,
  update: (outcome: V4EvaluationOutcome) => unknown): void {
  const index = outcomes.findIndex((outcome) => outcome.queryId === queryId);
  const current = outcomes[index];
  if (index < 0 || current === undefined) {throw new Error(`missing outcome ${queryId}`);}
  const untrustedOutcomes: unknown[] = outcomes;
  untrustedOutcomes[index] = update(current);
}

function tagCount(questions: readonly V4QualityQuestion[], tag: string): number {
  return questions.filter(({ tags }) => tags.includes(tag)).length;
}

function replaceCorpus(corpus: FrozenSemanticQualityCorpusV4,
  replacement: Partial<FrozenSemanticQualityCorpusV4>): FrozenSemanticQualityCorpusV4 {
  return { ...corpus, ...replacement };
}
