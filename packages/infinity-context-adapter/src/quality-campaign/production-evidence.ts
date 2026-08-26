import type { CampaignQuestion } from "./admission.js";
import type { FinalAdjudicationEnvelope } from "./adjudication.js";
import { canonicalJson, digest, exactRecord, safeId, sha256 } from "./canonical.js";
import { attemptIdentity } from "./execution.js";
import { verifyExactRetentionInventory, type RetainedArtifact } from "./retention.js";

export interface ExactOutcomeEvidence {
  readonly answerAbstained: boolean;
  readonly attemptId: string;
  readonly campaignRootSha256: string;
  readonly citationLocatorDigests: readonly string[];
  readonly evidenceLocatorDigests: readonly string[];
  readonly expectedAnswer: "answerable" | "abstain";
  readonly forbiddenLocatorDigests: readonly string[];
  readonly questionDigestSha256: string;
  readonly questionId: string;
  readonly rankedLocatorDigests: readonly string[];
  readonly relevantLocatorDigests: readonly string[];
  readonly repetition: 1 | 2 | 3;
  readonly retrievalLatencyUs: number;
}

export interface ExactAdjudicationEvidence extends FinalAdjudicationEnvelope {
  readonly attemptId: string;
  readonly campaignRootSha256: string;
  readonly questionId: string;
  readonly repetition: 1 | 2 | 3;
}

export interface ExactCampaignEvidence {
  readonly adjudications: readonly ExactAdjudicationEvidence[];
  readonly artifacts: readonly RetainedArtifact[];
  readonly campaignByteCeiling: number;
  readonly outcomes: readonly ExactOutcomeEvidence[];
}

export interface LocallyComputedMetrics {
  readonly abstentionPrecision: Readonly<{ denominator: number; numerator: number }>;
  readonly abstentionRecall: Readonly<{ denominator: number; numerator: number }>;
  readonly citationEntailment: Readonly<{ denominator: number; numerator: number }>;
  readonly citationMembership: Readonly<{ denominator: number; numerator: number }>;
  readonly claimPrecision: Readonly<{ denominator: number; numerator: number }>;
  readonly completeQuestionRecallAt5: Readonly<{ denominator: number; numerator: number }>;
  readonly crossScopeLeakageCount: number;
  readonly outcomeCount: number;
  readonly repetition: 1 | 2 | 3;
  readonly retrievalLatencyP95Us: number;
  readonly unsupportedFactualClaims: number;
}

const RATIO_THRESHOLDS = Object.freeze({
  abstentionPrecision: [19, 20], abstentionRecall: [9, 10],
  citationEntailment: [1, 1], citationMembership: [1, 1],
  claimPrecision: [97, 100], completeQuestionRecallAt5: [9, 10],
} as const);

export function reconstructExactMainEvidence(input: {
  readonly campaignRootSha256: string;
  readonly evidence: ExactCampaignEvidence;
  readonly questions: readonly CampaignQuestion[];
}): { readonly inventorySha256: string; readonly metrics: readonly LocallyComputedMetrics[];
  readonly metricsSha256ByRepetition: Readonly<Record<1 | 2 | 3, string>> } {
  const expected = ([1, 2, 3] as const).flatMap((repetition) => input.questions.map((question) => {
    const attempt = attemptIdentity({ callKind: "answer", callOrdinal: 2,
      campaignRootSha256: input.campaignRootSha256,
      questionDigestSha256: question.questionDigestSha256, questionId: question.questionId,
      repetition });
    return { attempt, question };
  }));
  assertExactMembership(input.campaignRootSha256, expected, input.evidence.outcomes,
    input.evidence.adjudications);
  const adjudicationByAttempt = new Map(input.evidence.adjudications.map((value) =>
    [value.attemptId, value]));
  const retained = verifyExactRetentionInventory({ artifacts: input.evidence.artifacts,
    campaignByteCeiling: input.evidence.campaignByteCeiling,
    expectedOutcomes: expected.map(({ attempt, question }) => ({ attemptId: attempt.attemptId,
      questionId: question.questionId, repetition: attempt.repetition,
      resolverRequired: adjudicationByAttempt.get(attempt.attemptId)?.resolverReceiptSha256 !==
        null })) });
  const metrics = ([1, 2, 3] as const).map((repetition) => computeMetrics({ adjudications:
    input.evidence.adjudications.filter((value) => value.repetition === repetition), outcomes:
    input.evidence.outcomes.filter((value) => value.repetition === repetition), repetition }));
  for (const value of metrics) {assertThresholds(value);}
  return Object.freeze({ inventorySha256: retained.inventorySha256, metrics,
    metricsSha256ByRepetition: Object.freeze({ 1: sha256(metrics[0]), 2: sha256(metrics[1]),
      3: sha256(metrics[2]) }) });
}

export function reconstructExactHoldoutEvidence(input: {
  readonly campaignRootSha256: string; readonly adjudications: readonly ExactAdjudicationEvidence[];
  readonly outcomes: readonly ExactOutcomeEvidence[]; readonly questions: readonly CampaignQuestion[];
}): { readonly metrics: LocallyComputedMetrics; readonly metricsSha256: string } {
  const expected = input.questions.map((question) => ({ question, attempt: attemptIdentity({
    callKind: "answer", callOrdinal: 2, campaignRootSha256: input.campaignRootSha256,
    questionDigestSha256: question.questionDigestSha256, questionId: question.questionId,
    repetition: 1 }) }));
  assertExactMembership(input.campaignRootSha256, expected, input.outcomes,
    input.adjudications);
  const metrics = computeMetrics({ adjudications: input.adjudications, outcomes: input.outcomes,
    repetition: 1 });
  assertThresholds(metrics);
  return Object.freeze({ metrics, metricsSha256: sha256(metrics) });
}

function assertExactMembership(campaignRootSha256: string, expected: readonly {
  readonly attempt: ReturnType<typeof attemptIdentity>; readonly question: CampaignQuestion }[],
  rawOutcomes: readonly ExactOutcomeEvidence[], rawAdjudications:
  readonly ExactAdjudicationEvidence[]): void {
  const expectedIds = expected.map(({ attempt }) => attempt.attemptId).toSorted();
  if (canonicalJson(rawOutcomes.map(({ attemptId }) => attemptId).toSorted()) !==
      canonicalJson(expectedIds) || canonicalJson(rawAdjudications.map(({ attemptId }) =>
        attemptId).toSorted()) !== canonicalJson(expectedIds)) {
    throw new Error("exact evidence is missing, duplicated, or contains orphan attempts");
  }
  const expectedById = new Map(expected.map((value) => [value.attempt.attemptId, value]));
  for (const outcome of rawOutcomes) {
    decodeOutcome(outcome);
    const value = expectedById.get(outcome.attemptId);
    if (value === undefined || outcome.campaignRootSha256 !== campaignRootSha256 ||
      outcome.questionId !== value.question.questionId || outcome.questionDigestSha256 !==
      value.question.questionDigestSha256 || outcome.repetition !== value.attempt.repetition) {
      throw new Error("outcome evidence is not bound to the exact attempt inventory");
    }
  }
  for (const adjudication of rawAdjudications) {
    const value = expectedById.get(adjudication.attemptId);
    if (value === undefined || adjudication.campaignRootSha256 !== campaignRootSha256 ||
      adjudication.questionId !== value.question.questionId || adjudication.repetition !==
      value.attempt.repetition || adjudication.decision.questionId !== value.question.questionId ||
      adjudication.decision.outcomeDigestSha256 !== adjudication.outcomeDigestSha256 ||
      adjudication.decisionDigestSha256 !== sha256(adjudication.decision)) {
      throw new Error("adjudication evidence is not bound to the exact outcome inventory");
    }
    for (const receiptDigest of [adjudication.firstReceiptSha256, adjudication.secondReceiptSha256,
      adjudication.outcomeDigestSha256, ...(adjudication.resolverReceiptSha256 === null ? [] :
        [adjudication.resolverReceiptSha256])]) {digest(receiptDigest, "adjudication evidence");}
  }
}

function decodeOutcome(value: ExactOutcomeEvidence): void {
  exactRecord(value, ["answerAbstained", "attemptId", "campaignRootSha256",
    "citationLocatorDigests", "evidenceLocatorDigests", "expectedAnswer",
    "forbiddenLocatorDigests", "questionDigestSha256", "questionId",
    "rankedLocatorDigests", "relevantLocatorDigests", "repetition", "retrievalLatencyUs"],
  "exact outcome evidence");
  safeId(value.attemptId, "outcome attempt"); safeId(value.questionId, "outcome question");
  digest(value.campaignRootSha256, "outcome root");
  digest(value.questionDigestSha256, "outcome question digest");
  if (typeof value.answerAbstained !== "boolean" ||
    !["answerable", "abstain"].includes(value.expectedAnswer) ||
    !Number.isSafeInteger(value.retrievalLatencyUs) || value.retrievalLatencyUs < 0 ||
    !Array.isArray(value.citationLocatorDigests) ||
    !Array.isArray(value.evidenceLocatorDigests) ||
    !Array.isArray(value.rankedLocatorDigests) || value.rankedLocatorDigests.length > 10 ||
    !Array.isArray(value.relevantLocatorDigests) || !Array.isArray(value.forbiddenLocatorDigests)) {
    throw new Error("outcome contains a missing or unknown metric field");
  }
  for (const item of [...value.citationLocatorDigests, ...value.evidenceLocatorDigests,
    ...value.rankedLocatorDigests, ...value.relevantLocatorDigests,
    ...value.forbiddenLocatorDigests]) {digest(item, "outcome locator");}
}

function computeMetrics(input: { readonly adjudications: readonly ExactAdjudicationEvidence[];
  readonly outcomes: readonly ExactOutcomeEvidence[]; readonly repetition: 1 | 2 | 3 }):
LocallyComputedMetrics {
  const decisions = input.adjudications.flatMap(({ decision }) => decision.claims);
  const factual = decisions.filter(({ claimFactual }) => claimFactual);
  const citations = factual.filter(() => true);
  const expectedAbstentions = input.outcomes.filter(({ expectedAnswer }) =>
    expectedAnswer === "abstain");
  const predictedAbstentions = input.outcomes.filter(({ answerAbstained }) => answerAbstained);
  const correctAbstentions = expectedAbstentions.filter(({ answerAbstained }) => answerAbstained);
  const answerable = input.outcomes.filter(({ expectedAnswer }) => expectedAnswer === "answerable");
  const latencies = input.outcomes.map(({ retrievalLatencyUs }) => retrievalLatencyUs)
    .toSorted((a, b) => a - b);
  return Object.freeze({
    abstentionPrecision: ratio(correctAbstentions.length, predictedAbstentions.length),
    abstentionRecall: ratio(correctAbstentions.length, expectedAbstentions.length),
    citationEntailment: ratio(citations.filter(({ citationEntailed }) => citationEntailed).length,
      citations.length),
    citationMembership: ratio(input.outcomes.reduce((sum, value) => sum +
      value.citationLocatorDigests.filter((locator) =>
        value.evidenceLocatorDigests.includes(locator)).length, 0),
    input.outcomes.reduce((sum, value) => sum + value.citationLocatorDigests.length, 0)),
    claimPrecision: ratio(factual.filter(({ claimSupported }) => claimSupported).length,
      factual.length),
    completeQuestionRecallAt5: ratio(answerable.filter((outcome) =>
      outcome.relevantLocatorDigests.every((locator) =>
        outcome.rankedLocatorDigests.slice(0, 5).includes(locator))).length, answerable.length),
    crossScopeLeakageCount: input.outcomes.reduce((count, outcome) => count +
      outcome.rankedLocatorDigests.filter((locator) =>
        outcome.forbiddenLocatorDigests.includes(locator)).length, 0),
    outcomeCount: input.outcomes.length, repetition: input.repetition,
    retrievalLatencyP95Us: latencies[Math.ceil(latencies.length * 0.95) - 1] ?? -1,
    unsupportedFactualClaims: factual.filter(({ claimSupported }) => !claimSupported).length,
  });
}

function ratio(numerator: number, denominator: number) {
  return Object.freeze({ denominator, numerator });
}

function assertThresholds(metrics: LocallyComputedMetrics): void {
  if (metrics.outcomeCount < 1 || metrics.retrievalLatencyP95Us < 0) {
    throw new Error("metrics are missing or unknown");
  }
  for (const [key, [minimumNumerator, minimumDenominator]] of
    Object.entries(RATIO_THRESHOLDS) as [keyof typeof RATIO_THRESHOLDS,
      readonly [number, number]][]) {
    const observed = metrics[key];
    if (observed.denominator < 1 || observed.numerator * minimumDenominator <
      observed.denominator * minimumNumerator) {throw new Error(`metric threshold failed: ${key}`);}
  }
  if (metrics.crossScopeLeakageCount !== 0 || metrics.unsupportedFactualClaims !== 0 ||
    metrics.retrievalLatencyP95Us > 3_000_000) {
    throw new Error("metric threshold failed: leakage, unsupported facts, or retrieval p95");
  }
}
