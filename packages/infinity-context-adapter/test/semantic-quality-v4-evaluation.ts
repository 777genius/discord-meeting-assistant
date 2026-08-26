import {
  canonicalSha256,
  createSemanticQualityV4Manifest,
  v4EvaluationBounds,
  v4Thresholds,
} from "./semantic-quality-v4-manifest.js";
import {
  frozenSemanticQualityCorpusV4,
  v4EvaluationQuestionText,
  v4RetrievalStratum,
  type V4QualityQuestion,
} from "./semantic-quality-v4-corpus.js";
import { validateV4OutcomeShape } from "./semantic-quality-v4-outcome-validation.js";
import type { RationalMetric, SemanticQualityV4ScoringAuthority, V4MetricApplicability,
  V4QualityMetrics, V4ScoringQuestion, V4ThresholdDecision, V4ThresholdId } from
  "./semantic-quality-v4-evaluation-contract.js";
export type { RationalMetric, SemanticQualityV4ScoringAuthority, V4QualityMetrics,
  SemanticQualityV4MetricReports, V4ScoringQuestion, V4ThresholdDecision, V4ThresholdId } from
  "./semantic-quality-v4-evaluation-contract.js";

interface RankedOpaqueLocator {
  readonly locatorId: string;
}

export interface LocallyRehydratedEvidenceTurn extends CitationReference {
  readonly sourceLocatorId: string;
  readonly text: string;
}

export interface CitationReference {
  readonly endMs: number; readonly speakerId: string;
  readonly startMs: number; readonly turnId: string;
}

export interface GeneratedClaim {
  readonly claimId: string; readonly claimPayloadSha256: string;
  readonly citationRefs: readonly CitationReference[]; readonly factual: boolean;
  readonly text: string;
}

export interface FinalClaimAdjudication {
  readonly claimId: string; readonly factuality: "factual" | "nonfactual";
  readonly matchedGoldClaimId: string | null;
  readonly status: "finalized"; readonly verdict: "stale" | "supported" | "unsupported";
}

export interface CitationEntailmentAdjudication {
  readonly claimId: string; readonly status: "finalized";
  readonly turnId: string; readonly verdict: "does_not_entail" | "entails";
}

export interface V4EvaluationOutcome {
  readonly adjudicationLatencyUs: number;
  readonly adjudicationKind: "external_independent" | "synthetic_structural_fixture";
  readonly adjudications: readonly FinalClaimAdjudication[];
  readonly answer: {
    readonly claims: readonly GeneratedClaim[];
    readonly status: "abstained" | "answered" | "failure" | "timeout";
  };
  readonly answerMeasurement: {
    readonly answerLatencyUs: number;
    readonly attemptId: string;
    readonly originalInput: V4ModelInputMeasurement;
    readonly originalModelInputSha256: string;
    readonly originalProviderRequestSha256: string;
    readonly originalProviderResponseSha256: string;
    readonly repairInput: V4ModelInputMeasurement;
    readonly repairModelInputSha256: string;
    readonly repairProviderRequestSha256: string | null;
    readonly repairProviderResponseSha256: string | null;
    readonly responseBytes: number;
    readonly responseRuntimeArtifactSha256: string;
    readonly runtimeReceiptSha256: string;
  };
  readonly citationEntailments: readonly CitationEntailmentAdjudication[]; readonly evidenceBytes: number;
  readonly fullLatencyUs: number;
  readonly locallyRehydratedEvidence: readonly LocallyRehydratedEvidenceTurn[];
  readonly locale: "en" | "mixed" | "ru"; readonly prompt: string;
  readonly promptBytes: number; readonly queryId: string; readonly questionDigestSha256: string;
  readonly retrieval: {
    readonly capabilityAndRetrievalLatencyUs: number; readonly capabilityBytes: number;
    readonly capabilitySha256: string;
    readonly expandedNeighborLocators: readonly RankedOpaqueLocator[]; readonly latencyUs: number;
    readonly rankedSeedLocators: readonly RankedOpaqueLocator[]; readonly requestBytes: number;
    readonly requestSha256: string; readonly requestSnapshotSha256: string;
    readonly responseBytes: number; readonly responseSha256: string;
    readonly routeLatencyUs: number;
    readonly status: "completed" | "failure" | "timeout";
  };
}

interface V4ModelInputMeasurement {
  readonly fullInputBytes: number; readonly outputSchemaBytes: number;
  readonly systemPromptBytes: number; readonly userPromptBytes: number;
}

const reciprocalRankScale = 2_520;
const ndcgScoreScale = 1_000_000;
/** Frozen micro-discounts approximate 1/log2(rank + 1), with rank one fixed to 1. */
const ndcgDiscountMicros = Object.freeze([
  1_000_000, 630_930, 500_000, 430_677, 386_853,
  356_207, 333_333, 315_465, 301_030, 289_065,
]);

export function createV4GeneratedClaimId(input: {
  readonly citationRefs: readonly CitationReference[];
  readonly claimPayloadSha256: string;
  readonly claimOrdinal: number;
  readonly factual: boolean;
  readonly queryId: string;
}): string {
  if (input.queryId.trim() === "" || !Number.isSafeInteger(input.claimOrdinal) ||
    input.claimOrdinal < 0 || !/^[a-f0-9]{64}$/u.test(input.claimPayloadSha256)) {
    throw new Error("V4 generated claim identity input is invalid");
  }
  return `v4-claim-${canonicalSha256({
    citationRefs: canonicalCitationRefs(input.citationRefs, input.queryId, "generated"),
    claimPayloadSha256: input.claimPayloadSha256,
    claimOrdinal: input.claimOrdinal,
    factual: input.factual,
    queryId: input.queryId,
    schemaVersion: "meeting_knowledge.generated_claim.v4",
  })}`;
}

/**
 * Scores supplied ordered opaque locators. It does not search, fuse, rerank,
 * normalize provider scores, or infer relevance from locator text.
 */
export function evaluateSemanticQualityV4(input: {
  readonly authority?: SemanticQualityV4ScoringAuthority;
  readonly outcomes: readonly V4EvaluationOutcome[];
}): V4QualityMetrics {
  assertExactRecord(input, input.authority === undefined ? ["outcomes"] : ["authority", "outcomes"],
    "V4 scorer input");
  if (!Array.isArray(input.outcomes)) {throw new Error("V4 scorer outcomes must be an array");}
  const corpus = input.authority === undefined ? frozenSemanticQualityCorpusV4() : null;
  if (corpus !== null) {createSemanticQualityV4Manifest(corpus);}
  const questions = input.authority?.questions ??
    [...corpus!.automatedQuestions, ...corpus!.humanReviewQuestions];
  const outcomes = (input.outcomes as readonly unknown[]).map((outcome) =>
    validateV4OutcomeShape(outcome));
  const outcomeById = new Map(outcomes.map((outcome) => [outcome.queryId, outcome]));
  assertCompleteOutcomeSet(questions, outcomes, outcomeById);
  const authorityTurns = input.authority?.canonicalTurns ??
    [...corpus!.primaryMeeting.humanTurns, ...corpus!.auxiliaryTurns];
  const canonicalTurns = new Map(authorityTurns.map((turn) => [turn.turnId, turn] as const));
  const knownLocators = new Set(input.authority?.knownLocatorIds ?? corpus!.knownLocatorIds);
  const globallyForbiddenLocators = new Set(input.authority?.globallyForbiddenLocatorIds ??
    corpus!.globalForbiddenLocatorIds);
  const counters = evaluationCounters(
    questions.filter(({ kind }) => kind === "answerable").length,
  );
  for (const question of questions) {
    const outcome = outcomeById.get(question.id);
    if (outcome === undefined) {throw new Error(`missing V4 outcome ${question.id}`);}
    const wholeTranscriptTurnIds = input.authority?.wholeTranscriptTurnIdsByQuestionId[question.id];
    const wholeTranscriptTurns = wholeTranscriptTurnIds === undefined
      ? corpus!.primaryMeeting.humanTurns
      : wholeTranscriptTurnIds.map((turnId) => {
          const turn = canonicalTurns.get(turnId);
          if (turn === undefined) {throw new Error("V4 scoring authority turn is unknown");}
          return turn;
        });
    scoreV4Outcome({ canonicalTurns, counters, globallyForbiddenLocators, knownLocators,
      outcome, primaryCanonicalTurns: wholeTranscriptTurns, question });
  }
  return buildV4Metrics(counters);
}

type CanonicalEvidenceTurn = Readonly<{
  endMs: number; speakerId: string; startMs: number; text: string;
  turnId: string;
}>;

interface V4EvaluationCounters {
  adjudicationLatencies: number[];
  abstentionHits: number; abstentions: number; answerableCount: number;
  answerableCoverageFailures: number; answerableExecutionFailures: number;
  answeredQuestionHits: number; citationCount: number; citationEntailmentHits: number;
  citationMemberHits: number; evidenceBytes: number[]; evidenceBytesTotal: number;
  answerLatencies: number[]; answerResponseBytesTotal: number; capabilityBytesTotal: number;
  capabilityLatencies: number[]; externallyAdjudicatedFactualClaims: number;
  factualClaims: number; failureCount: number; fullLatencies: number[];
  latencies: number[]; leakageCount: number; locale: ReturnType<typeof localeMetricCounters>;
  mrrScaledSum: number; ndcgScoreMicros: number; promptBytes: number[];
  originalPromptBytes: number[]; originalPromptBytesTotal: number;
  promptBytesTotal: number; recall10Hits: number; recall5Hits: number;
  blockRecall10Hits: number; blockRecall5Hits: number; relevantBlockCount: number;
  repairPromptBytes: number[]; repairPromptBytesTotal: number; routeLatencies: number[];
  requestBytesTotal: number; responseBytesTotal: number; speakerHits: number;
  strata: Record<"anchorless" | "named_anchor", { denominator: number; numerator: number }>;
  supportedFactualClaims: number; timeHits: number; timeoutCount: number;
  unsupportedCount: number; unsupportedFactualClaims: number; wholeTranscriptCount: number;
}

function evaluationCounters(answerableCount: number): V4EvaluationCounters {
  return {
    abstentionHits: 0, abstentions: 0, adjudicationLatencies: [], answerLatencies: [],
    answerResponseBytesTotal: 0,
    answerableCount, answerableCoverageFailures: 0,
    answerableExecutionFailures: 0, answeredQuestionHits: 0, citationCount: 0,
    citationEntailmentHits: 0, citationMemberHits: 0, evidenceBytes: [], evidenceBytesTotal: 0,
    capabilityBytesTotal: 0, capabilityLatencies: [], externallyAdjudicatedFactualClaims: 0,
    factualClaims: 0, failureCount: 0, fullLatencies: [], latencies: [],
    leakageCount: 0, locale: localeMetricCounters(), mrrScaledSum: 0, ndcgScoreMicros: 0,
    originalPromptBytes: [], originalPromptBytesTotal: 0, promptBytes: [], promptBytesTotal: 0,
    recall10Hits: 0, recall5Hits: 0, blockRecall10Hits: 0, blockRecall5Hits: 0,
    relevantBlockCount: 0, repairPromptBytes: [], repairPromptBytesTotal: 0,
    routeLatencies: [],
    requestBytesTotal: 0, responseBytesTotal: 0, speakerHits: 0,
    strata: { anchorless: { denominator: 0, numerator: 0 },
      named_anchor: { denominator: 0, numerator: 0 } },
    supportedFactualClaims: 0, timeHits: 0, timeoutCount: 0, unsupportedCount: 0,
    unsupportedFactualClaims: 0, wholeTranscriptCount: 0,
  };
}

function assertCompleteOutcomeSet(
  questions: readonly V4ScoringQuestion[],
  outcomes: readonly V4EvaluationOutcome[],
  outcomeById: ReadonlyMap<string, V4EvaluationOutcome>,
): void {
  const questionById = new Map(questions.map((question) => [question.id, question]));
  if (questionById.size !== questions.length || outcomes.length !== questions.length ||
    outcomeById.size !== questions.length || questions.length < 1 || questions.length > 240 ||
    outcomes.some(({ queryId }) => !questionById.has(queryId))) {
    throw new Error("V4 evaluation requires exactly one outcome for all 240 questions");
  }
}

function scoreV4Outcome(input: {
  readonly canonicalTurns: ReadonlyMap<string, CanonicalEvidenceTurn>;
  readonly counters: V4EvaluationCounters;
  readonly globallyForbiddenLocators: ReadonlySet<string>;
  readonly knownLocators: ReadonlySet<string>;
  readonly outcome: V4EvaluationOutcome;
  readonly primaryCanonicalTurns: readonly CanonicalEvidenceTurn[];
  readonly question: V4ScoringQuestion;
}): void {
  const { canonicalTurns, counters, globallyForbiddenLocators, knownLocators, outcome,
    primaryCanonicalTurns, question } = input;
  validateOutcome(outcome, question, knownLocators, canonicalTurns);
  const adjudications = new Map(outcome.adjudications.map((item) => [item.claimId, item]));
  const ranked = outcome.retrieval.rankedSeedLocators.map(({ locatorId }) => locatorId);
  const gold = new Map<string, 1 | 2 | 3>(question.goldLocatorRelevance.map((item) =>
    [item.locatorId, item.relevance]));
  if (question.kind === "answerable") {
    scoreAnswerableRetrieval(counters, question, outcome, ranked, gold, adjudications);
  }
  counters.leakageCount += [...ranked,
    ...outcome.retrieval.expandedNeighborLocators.map(({ locatorId }) => locatorId)]
    .filter((locator) => globallyForbiddenLocators.has(locator)).length;
  const matched = scoreGeneratedClaims(counters, question, outcome, adjudications,
    canonicalTurns);
  scoreAnswerCompletion(counters, question, outcome, matched);
  scoreExecutionAndResources(counters, outcome, primaryCanonicalTurns);
}

function scoreAnswerableRetrieval(
  counters: V4EvaluationCounters,
  question: V4QualityQuestion,
  outcome: V4EvaluationOutcome,
  ranked: readonly string[],
  gold: ReadonlyMap<string, 1 | 2 | 3>,
  adjudications: ReadonlyMap<string, FinalClaimAdjudication>,
): void {
  const completed = outcome.retrieval.status === "completed";
  counters.relevantBlockCount += gold.size;
  if (completed) {
    counters.blockRecall5Hits += [...gold.keys()].filter((locator) =>
      ranked.slice(0, 5).includes(locator)).length;
    counters.blockRecall10Hits += [...gold.keys()].filter((locator) =>
      ranked.slice(0, 10).includes(locator)).length;
  }
  const recallAt5Hit = completed && [...gold.keys()].every((locator) =>
    ranked.slice(0, 5).includes(locator));
  if (recallAt5Hit) {counters.recall5Hits += 1;}
  counters.locale[question.locale].answerableCount += 1;
  if (recallAt5Hit) {counters.locale[question.locale].recallAt5Hits += 1;}
  counters.locale[question.locale].relevantBlockCount += gold.size;
  if (completed) {
    counters.locale[question.locale].blockRecall5Hits += [...gold.keys()].filter((locator) =>
      ranked.slice(0, 5).includes(locator)).length;
    counters.locale[question.locale].blockRecall10Hits += [...gold.keys()].filter((locator) =>
      ranked.slice(0, 10).includes(locator)).length;
  }
  const stratum = v4RetrievalStratum(question);
  if (stratum !== "not_applicable") {
    counters.strata[stratum].denominator += 1;
    if (recallAt5Hit) {counters.strata[stratum].numerator += 1;}
  }
  if (completed && [...gold.keys()].every((locator) => ranked.slice(0, 10).includes(locator))) {
    counters.recall10Hits += 1;
    counters.locale[question.locale].recallAt10Hits += 1;
  }
  const firstRelevantRank = ranked.findIndex((locator) => gold.has(locator));
  if (completed && firstRelevantRank >= 0) {
    counters.mrrScaledSum += reciprocalRankScale / (firstRelevantRank + 1);
  }
  counters.ndcgScoreMicros += ndcgQuestionScoreMicros(ranked, gold);
  const answeredWithFact = outcome.answer.status === "answered" &&
    outcome.answer.claims.some(({ claimId }) => {
      const adjudication = adjudications.get(claimId);
      return adjudication?.factuality === "factual" && adjudication.verdict === "supported";
    });
  if (!answeredWithFact) {counters.answerableCoverageFailures += 1;}
  if (!completed || outcome.answer.status === "failure" || outcome.answer.status === "timeout") {
    counters.answerableExecutionFailures += 1;
  }
}

function scoreGeneratedClaims(
  counters: V4EvaluationCounters,
  question: V4QualityQuestion,
  outcome: V4EvaluationOutcome,
  adjudications: ReadonlyMap<string, FinalClaimAdjudication>,
  canonicalTurns: ReadonlyMap<string, CanonicalEvidenceTurn>,
): ReadonlySet<string> {
  const admitted = new Set(outcome.locallyRehydratedEvidence.map(({ turnId }) => turnId));
  const entailments = new Map(outcome.citationEntailments.map((item) =>
    [`${item.claimId}\u0000${item.turnId}`, item]));
  const matched = new Set<string>();
  for (const claim of outcome.answer.claims) {
    const adjudication = adjudications.get(claim.claimId);
    if (adjudication === undefined) {throw new Error(`missing adjudication ${claim.claimId}`);}
    scoreFactualClaim(counters, question, outcome, claim, adjudication, matched);
    scoreClaimCitations(counters, outcome, claim, admitted, entailments, canonicalTurns);
  }
  return matched;
}

function scoreFactualClaim(
  counters: V4EvaluationCounters,
  question: V4QualityQuestion,
  outcome: V4EvaluationOutcome,
  claim: GeneratedClaim,
  adjudication: FinalClaimAdjudication,
  matched: Set<string>,
): void {
  if (adjudication.factuality !== "factual") {return;}
  counters.factualClaims += 1;
  if (outcome.adjudicationKind === "external_independent") {
    counters.externallyAdjudicatedFactualClaims += 1;
  }
  if (adjudication.verdict === "supported") {counters.supportedFactualClaims += 1;}
  if (adjudication.verdict === "unsupported" || adjudication.verdict === "stale") {
    counters.unsupportedFactualClaims += 1;
  }
  if (adjudication.verdict === "supported" && adjudication.matchedGoldClaimId !== null &&
    question.expectedClaimIds.includes(adjudication.matchedGoldClaimId)) {
    matched.add(adjudication.matchedGoldClaimId);
  }
}

function scoreClaimCitations(
  counters: V4EvaluationCounters,
  outcome: V4EvaluationOutcome,
  claim: GeneratedClaim,
  admitted: ReadonlySet<string>,
  entailments: ReadonlyMap<string, CitationEntailmentAdjudication>,
  canonicalTurns: ReadonlyMap<string, CanonicalEvidenceTurn>,
): void {
  const citations = canonicalCitationRefs(claim.citationRefs, outcome.queryId, claim.claimId);
  if (citations.length === 0) {return;}
  counters.citationCount += 1;
  if (citations.every(({ turnId }) => admitted.has(turnId))) {counters.citationMemberHits += 1;}
  if (citations.every(({ turnId }) =>
    entailments.get(`${claim.claimId}\u0000${turnId}`)?.verdict === "entails")) {
    counters.citationEntailmentHits += 1;
  }
  if (citations.every((citation) =>
    canonicalTurns.get(citation.turnId)?.speakerId === citation.speakerId)) {
    counters.speakerHits += 1;
  }
  if (citations.every((citation) => citationMatchesTime(citation, canonicalTurns))) {
    counters.timeHits += 1;
  }
}

function citationMatchesTime(
  citation: CitationReference,
  canonicalTurns: ReadonlyMap<string, CanonicalEvidenceTurn>,
): boolean {
  const canonical = canonicalTurns.get(citation.turnId);
  return canonical?.startMs === citation.startMs && canonical.endMs === citation.endMs;
}

function scoreAnswerCompletion(counters: V4EvaluationCounters, question: V4QualityQuestion,
  outcome: V4EvaluationOutcome, matched: ReadonlySet<string>): void {
  const expected = new Set(question.expectedClaimIds);
  if (question.kind === "answerable" && expected.size > 0 &&
    [...expected].every((claimId) => matched.has(claimId))) {
    counters.answeredQuestionHits += 1;
    counters.locale[question.locale].finalAnswerHits += 1;
  }
  if (question.kind === "unsupported") {
    counters.unsupportedCount += 1;
    if (outcome.answer.status === "abstained" && outcome.answer.claims.length === 0) {
      counters.abstentionHits += 1;
    }
  }
  if (outcome.answer.status === "abstained") {counters.abstentions += 1;}
}

function scoreExecutionAndResources(counters: V4EvaluationCounters,
  outcome: V4EvaluationOutcome, primaryCanonicalTurns: readonly CanonicalEvidenceTurn[]): void {
  if (outcome.retrieval.status === "timeout" || outcome.answer.status === "timeout") {
    counters.timeoutCount += 1;
  } else if (outcome.retrieval.status === "failure" || outcome.answer.status === "failure") {
    counters.failureCount += 1;
  }
  if (includesWholeTranscript(outcome, primaryCanonicalTurns)) {
    counters.wholeTranscriptCount += 1;
  }
  counters.requestBytesTotal += outcome.retrieval.requestBytes;
  counters.responseBytesTotal += outcome.retrieval.responseBytes;
  counters.answerResponseBytesTotal += outcome.answerMeasurement.responseBytes;
  counters.capabilityBytesTotal += outcome.retrieval.capabilityBytes;
  counters.promptBytesTotal += outcome.promptBytes;
  counters.evidenceBytesTotal += outcome.evidenceBytes;
  counters.promptBytes.push(outcome.promptBytes);
  counters.evidenceBytes.push(outcome.evidenceBytes);
  counters.latencies.push(outcome.retrieval.latencyUs);
  counters.answerLatencies.push(outcome.answerMeasurement.answerLatencyUs);
  counters.adjudicationLatencies.push(outcome.adjudicationLatencyUs);
  counters.capabilityLatencies.push(outcome.retrieval.capabilityAndRetrievalLatencyUs);
  counters.fullLatencies.push(outcome.fullLatencyUs);
  counters.routeLatencies.push(outcome.retrieval.routeLatencyUs);
  counters.originalPromptBytes.push(outcome.answerMeasurement.originalInput.fullInputBytes);
  counters.originalPromptBytesTotal += outcome.answerMeasurement.originalInput.fullInputBytes;
  counters.repairPromptBytes.push(outcome.answerMeasurement.repairInput.fullInputBytes);
  counters.repairPromptBytesTotal += outcome.answerMeasurement.repairInput.fullInputBytes;
}

function includesWholeTranscript(outcome: V4EvaluationOutcome,
  primaryCanonicalTurns: readonly CanonicalEvidenceTurn[]): boolean {
  const evidenceIds = new Set(outcome.locallyRehydratedEvidence.map(({ turnId }) => turnId));
  if (primaryCanonicalTurns.every(({ turnId }) => evidenceIds.has(turnId))) {return true;}
  const normalizedPrompt = outcome.prompt.normalize("NFKC").toLocaleLowerCase();
  return primaryCanonicalTurns.every(({ text }) =>
    normalizedPrompt.includes(text.normalize("NFKC").toLocaleLowerCase()));
}

function buildV4Metrics(counters: V4EvaluationCounters): V4QualityMetrics {
  return Object.freeze({
    blockLocatorRecallAt5: rational(counters.blockRecall5Hits, counters.relevantBlockCount),
    blockLocatorRecallAt10: rational(counters.blockRecall10Hits, counters.relevantBlockCount),
    completeQuestionRecallAt5: rational(counters.recall5Hits, counters.answerableCount),
    completeQuestionRecallAt10: rational(counters.recall10Hits, counters.answerableCount),
    answerableCoverageFailureCount: counters.answerableCoverageFailures,
    answerableExecutionFailureCount: counters.answerableExecutionFailures,
    abstentionPrecision: rational(counters.abstentionHits, counters.abstentions),
    abstentionRecall: rational(counters.abstentionHits, counters.unsupportedCount),
    byLocale: Object.freeze({
      en: frozenLocaleMetrics(counters.locale.en),
      mixed: frozenLocaleMetrics(counters.locale.mixed),
      ru: frozenLocaleMetrics(counters.locale.ru),
    }),
    citationEntailment: rational(counters.citationEntailmentHits, counters.citationCount),
    citationMembership: rational(counters.citationMemberHits, counters.citationCount),
    claimPrecision: rational(counters.supportedFactualClaims, counters.factualClaims),
    crossScopeLeakageCount: counters.leakageCount,
    externallyAdjudicatedFactualClaimCount: counters.externallyAdjudicatedFactualClaims,
    failureCount: counters.failureCount,
    finalAnswerRecall: rational(counters.answeredQuestionHits, counters.answerableCount),
    mrrAt10: rational(counters.mrrScaledSum,
      counters.answerableCount * reciprocalRankScale),
    ndcgAt10: rational(counters.ndcgScoreMicros, counters.answerableCount * ndcgScoreScale),
    retrievalStrata: Object.freeze({
      anchorlessRecallAt5: rational(counters.strata.anchorless.numerator,
        counters.strata.anchorless.denominator),
      namedAnchorRecallAt5: rational(counters.strata.named_anchor.numerator,
        counters.strata.named_anchor.denominator),
    }),
    resources: Object.freeze({
      answerResponseBytesTotal: counters.answerResponseBytesTotal,
      capabilityBytesTotal: counters.capabilityBytesTotal,
      evidenceBytesMaximum: Math.max(...counters.evidenceBytes),
      evidenceBytesTotal: counters.evidenceBytesTotal,
      latencyUs: Object.freeze({
        adjudication: latencySummary(counters.adjudicationLatencies),
        answer: latencySummary(counters.answerLatencies),
        capabilityAndRetrieval: latencySummary(counters.capabilityLatencies),
        full: latencySummary(counters.fullLatencies),
        route: latencySummary(counters.routeLatencies),
      }),
      originalPromptBytesMaximum: Math.max(...counters.originalPromptBytes),
      originalPromptBytesTotal: counters.originalPromptBytesTotal,
      promptBytesMaximum: Math.max(...counters.promptBytes),
      promptBytesTotal: counters.promptBytesTotal,
      repairPromptBytesMaximum: Math.max(...counters.repairPromptBytes),
      repairPromptBytesTotal: counters.repairPromptBytesTotal,
      requestBytesTotal: counters.requestBytesTotal,
      responseBytesTotal: counters.responseBytesTotal,
      retrievalLatencyP95Us: percentile95(counters.latencies),
    }),
    speakerAccuracy: rational(counters.speakerHits, counters.citationCount),
    timeAccuracy: rational(counters.timeHits, counters.citationCount),
    timeoutCount: counters.timeoutCount,
    unsupportedFactualClaimCount: counters.unsupportedFactualClaims,
    wholeTranscriptIncludedCount: counters.wholeTranscriptCount,
  });
}

export function evaluateV4Thresholds(metrics: V4QualityMetrics,
  applicability: V4MetricApplicability = Object.freeze({ automatedRetrievalStrata: true,
    locales: Object.freeze(["en", "ru", "mixed"] as const) })):
V4ThresholdDecision {
  const failures: V4ThresholdId[] = [];
  gate(failures, "answerable_execution_coverage",
    metrics.answerableCoverageFailureCount === 0 &&
    metrics.answerableExecutionFailureCount === 0);
  gate(failures, "block_locator_recall_at_5",
    atLeast(metrics.blockLocatorRecallAt5, v4Thresholds.blockLocatorRecallAt5));
  gate(failures, "complete_question_recall_at_5",
    atLeast(metrics.completeQuestionRecallAt5, v4Thresholds.completeQuestionRecallAt5));
  gate(failures, "final_answer_recall",
    atLeast(metrics.finalAnswerRecall, v4Thresholds.finalAnswerRecall));
  for (const locale of applicability.locales) {
    gate(failures, `block_locator_recall_at_5_${locale}`,
      atLeast(metrics.byLocale[locale].blockLocatorRecallAt5,
        v4Thresholds.blockLocatorRecallAt5));
    gate(failures, `complete_question_recall_at_5_${locale}`,
      atLeast(metrics.byLocale[locale].completeQuestionRecallAt5,
        v4Thresholds.completeQuestionRecallAt5));
    gate(failures, `final_answer_recall_${locale}`,
      atLeast(metrics.byLocale[locale].finalAnswerRecall, v4Thresholds.finalAnswerRecall));
  }
  if (applicability.automatedRetrievalStrata) {
    gate(failures, "marker_blind_recall_at_5", atLeast(
      metrics.retrievalStrata.anchorlessRecallAt5, v4Thresholds.markerBlindRecallAt5));
    gate(failures, "marker_blind_recall_degradation", withinMaximumDegradation(
      metrics.retrievalStrata.anchorlessRecallAt5,
      metrics.retrievalStrata.namedAnchorRecallAt5,
      v4Thresholds.maximumMarkerBlindDegradation));
  }
  gate(failures, "mrr_at_10", atLeast(metrics.mrrAt10, v4Thresholds.mrrAt10));
  gate(failures, "speaker_accuracy", atLeast(metrics.speakerAccuracy,
    v4Thresholds.speakerAccuracy));
  gate(failures, "time_accuracy", atLeast(metrics.timeAccuracy, v4Thresholds.timeAccuracy));
  gate(failures, "citation_membership", atLeast(metrics.citationMembership,
    v4Thresholds.citationMembership));
  gate(failures, "citation_entailment", atLeast(metrics.citationEntailment,
    v4Thresholds.citationEntailment));
  gate(failures, "cross_scope_leakage",
    metrics.crossScopeLeakageCount <= v4Thresholds.crossScopeLeakageMaximum);
  gate(failures, "claim_precision", atLeast(metrics.claimPrecision,
    v4Thresholds.claimPrecision));
  gate(failures, "abstention_precision", atLeast(metrics.abstentionPrecision,
    v4Thresholds.abstentionPrecision));
  gate(failures, "abstention_recall", atLeast(metrics.abstentionRecall,
    v4Thresholds.abstentionRecall));
  gate(failures, "unsupported_factual_claims",
    metrics.unsupportedFactualClaimCount <= v4Thresholds.unsupportedFactualClaimsMaximum);
  gate(failures, "retrieval_latency_p95",
    metrics.resources.retrievalLatencyP95Us <= v4Thresholds.maximumRetrievalLatencyP95Us);
  gate(failures, "whole_transcript",
    metrics.wholeTranscriptIncludedCount <= v4Thresholds.wholeTranscriptIncludedMaximum);
  gate(failures, "bounded_input",
    metrics.resources.promptBytesMaximum <= v4EvaluationBounds.maximumPromptBytes &&
    metrics.resources.evidenceBytesMaximum <= v4EvaluationBounds.maximumEvidenceBytes);
  return Object.freeze({ failedGateIds: Object.freeze(failures), passed: failures.length === 0,
    reportedOnlyMetricIds: Object.freeze(
      ["block_locator_recall_at_10", "complete_question_recall_at_10", "ndcg_at_10"] as const,
    ) });
}

function validateOutcome(outcome: V4EvaluationOutcome, question: V4ScoringQuestion,
  knownLocators: ReadonlySet<string>,
  canonicalTurns: ReadonlyMap<string, CanonicalEvidenceTurn>): void {
  validateBoundedRetrieval(outcome, knownLocators);
  validateQuestionBinding(outcome, question);
  validateStageAndClaimRequirements(outcome, question, canonicalTurns);
  validateClaimBindings(outcome, question);
  validateLocalEvidenceAndEntailment(outcome, canonicalTurns);
}

function validateQuestionBinding(outcome: V4EvaluationOutcome, question: V4ScoringQuestion): void {
  const expectedDigest = canonicalSha256({ id: question.id, locale: question.locale,
    v4EvaluationQuestionText: question.evaluationQuestionText ?? v4EvaluationQuestionText(question) });
  if (outcome.locale !== question.locale || outcome.questionDigestSha256 !== expectedDigest) {
    throw new Error(`V4 outcome ${outcome.queryId} is not bound to its canonical question`);
  }
}

function validateBoundedRetrieval(outcome: V4EvaluationOutcome,
  knownLocators: ReadonlySet<string>): void {
  const integers = [outcome.evidenceBytes, outcome.fullLatencyUs, outcome.promptBytes,
    outcome.retrieval.capabilityAndRetrievalLatencyUs, outcome.retrieval.latencyUs,
    outcome.retrieval.requestBytes, outcome.retrieval.responseBytes,
    outcome.answerMeasurement.answerLatencyUs, outcome.answerMeasurement.responseBytes];
  const recomputedEvidenceBytes = new TextEncoder()
    .encode(JSON.stringify(outcome.locallyRehydratedEvidence)).byteLength;
  const recomputedPromptBytes = Math.max(
    outcome.answerMeasurement.originalInput.fullInputBytes,
    outcome.answerMeasurement.repairInput.fullInputBytes,
  );
  if (integers.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    outcome.evidenceBytes !== recomputedEvidenceBytes ||
    outcome.promptBytes !== recomputedPromptBytes ||
    outcome.retrieval.rankedSeedLocators.length > v4EvaluationBounds.maximumRankedLocators ||
    new Set(outcome.retrieval.rankedSeedLocators.map(({ locatorId }) => locatorId)).size !==
      outcome.retrieval.rankedSeedLocators.length ||
    new Set(outcome.retrieval.expandedNeighborLocators.map(({ locatorId }) => locatorId)).size !==
      outcome.retrieval.expandedNeighborLocators.length ||
    [...outcome.retrieval.rankedSeedLocators, ...outcome.retrieval.expandedNeighborLocators]
      .some(({ locatorId }) => locatorId.trim() === "" || !knownLocators.has(locatorId))) {
    throw new Error(`V4 outcome ${outcome.queryId} has invalid bounded rank-10 evidence`);
  }
  if (!(["external_independent", "synthetic_structural_fixture"] as const)
    .includes(outcome.adjudicationKind)) {
    throw new Error(`V4 outcome ${outcome.queryId} has invalid adjudication provenance`);
  }
  if ("goldLocatorRelevance" in outcome.retrieval) {
    throw new Error(`V4 outcome ${outcome.queryId} cannot supply gold relevance`);
  }
}

function validateStageAndClaimRequirements(
  outcome: V4EvaluationOutcome,
  question: V4QualityQuestion,
  canonicalTurns: ReadonlyMap<string, { readonly endMs: number; readonly speakerId: string;
    readonly startMs: number }>,
): void {
  if (outcome.retrieval.status !== "completed" &&
    (outcome.retrieval.rankedSeedLocators.length > 0 ||
      outcome.retrieval.expandedNeighborLocators.length > 0)) {
    throw new Error(`V4 failed retrieval ${outcome.queryId} cannot return ranked locators`);
  }
  if ((outcome.retrieval.status === "timeout" && outcome.answer.status !== "timeout") ||
    (outcome.retrieval.status === "failure" && outcome.answer.status !== "failure")) {
    throw new Error(`V4 outcome ${outcome.queryId} has inconsistent stage status`);
  }
  if (outcome.answer.status === "abstained" && outcome.answer.claims.length > 0) {
    throw new Error(`V4 abstention ${outcome.queryId} cannot emit claims`);
  }
  if ((outcome.answer.status === "failure" || outcome.answer.status === "timeout") &&
    outcome.answer.claims.length > 0) {
    throw new Error(`V4 failed answer ${outcome.queryId} cannot emit claims`);
  }
  if (question.kind === "answerable" && outcome.answer.status === "answered" &&
    !outcome.answer.claims.some(({ claimId }) =>
      outcome.adjudications.some((item) => item.claimId === claimId &&
        item.factuality === "factual" && item.verdict === "supported"))) {
    throw new Error(`V4 answered outcome ${outcome.queryId} requires a supported factual claim`);
  }
  if (outcome.answer.claims.some((claim) => claim.citationRefs.length === 0 &&
    outcome.adjudications.some((item) => item.claimId === claim.claimId &&
      item.factuality === "factual"))) {
    throw new Error(`V4 factual claim ${outcome.queryId} requires a local citation reference`);
  }
  if (outcome.answer.claims.flatMap(({ citationRefs }) => citationRefs).some((citation) =>
    citation.turnId.trim() === "" || citation.speakerId.trim() === "" ||
    !Number.isSafeInteger(citation.startMs) || citation.startMs < 0 ||
    !Number.isSafeInteger(citation.endMs) || citation.endMs <= citation.startMs ||
    !canonicalTurns.has(citation.turnId))) {
    throw new Error(`V4 outcome ${outcome.queryId} contains a malformed citation`);
  }
}

function validateClaimBindings(outcome: V4EvaluationOutcome,
  question: V4QualityQuestion): void {
  const claimIds = outcome.answer.claims.map(({ claimId }) => claimId);
  const adjudicatedClaimIds = outcome.adjudications.map(({ claimId }) => claimId);
  if (new Set(claimIds).size !== claimIds.length ||
    new Set(adjudicatedClaimIds).size !== adjudicatedClaimIds.length ||
    outcome.adjudications.length !== outcome.answer.claims.length ||
    adjudicatedClaimIds.some((claimId) => !claimIds.includes(claimId))) {
    throw new Error(`V4 outcome ${outcome.queryId} has duplicate or unbound claim identities`);
  }
  const claimPayloads = new Set<string>();
  for (const [index, claim] of outcome.answer.claims.entries()) {
    const canonicalCitations = canonicalCitationRefs(claim.citationRefs, outcome.queryId,
      claim.claimId);
    const expectedClaimId = createV4GeneratedClaimId({ citationRefs: canonicalCitations,
      claimOrdinal: index, claimPayloadSha256: claim.claimPayloadSha256,
      factual: claim.factual, queryId: outcome.queryId });
    if (claim.claimPayloadSha256 !== canonicalSha256({ factual: claim.factual,
      text: claim.text })) {
      throw new Error(`V4 outcome ${outcome.queryId} has a forged generated claim payload digest`);
    }
    if (claim.claimId !== expectedClaimId) {
      throw new Error(`V4 outcome ${outcome.queryId} has an unstable generated claim identity`);
    }
    if (claimPayloads.has(claim.claimPayloadSha256)) {
      throw new Error(`V4 outcome ${outcome.queryId} repeats an exact claim payload`);
    }
    claimPayloads.add(claim.claimPayloadSha256);
  }
  if (outcome.adjudications.some((item) => item.verdict !== "supported" &&
    item.matchedGoldClaimId !== null)) {
    throw new Error(`V4 outcome ${outcome.queryId} maps an unsupported claim to gold`);
  }
  if (outcome.adjudications.some((item) => item.matchedGoldClaimId !== null &&
    !question.expectedClaimIds.includes(item.matchedGoldClaimId))) {
    throw new Error(`V4 outcome ${outcome.queryId} references unknown expected claim`);
  }
}

function validateLocalEvidenceAndEntailment(
  outcome: V4EvaluationOutcome,
  canonicalTurns: ReadonlyMap<string, { readonly endMs: number; readonly speakerId: string;
    readonly startMs: number; readonly text: string }>,
): void {
  const evidenceIds = outcome.locallyRehydratedEvidence.map(({ turnId }) => turnId);
  const retrievedLocatorIds = new Set([
    ...outcome.retrieval.rankedSeedLocators, ...outcome.retrieval.expandedNeighborLocators,
  ].map(({ locatorId }) => locatorId));
  if (new Set(evidenceIds).size !== evidenceIds.length ||
    outcome.locallyRehydratedEvidence.some(({ sourceLocatorId }) =>
      !retrievedLocatorIds.has(sourceLocatorId))) {
    throw new Error(`V4 outcome ${outcome.queryId} has repeated or non-retrieved local evidence`);
  }
  for (const evidence of outcome.locallyRehydratedEvidence) {
    const canonical = canonicalTurns.get(evidence.turnId);
    if (canonical === undefined || canonical.speakerId !== evidence.speakerId ||
      canonical.startMs !== evidence.startMs || canonical.endMs !== evidence.endMs ||
      canonical.text !== evidence.text) {
      throw new Error(`V4 outcome ${outcome.queryId} has non-canonical local evidence`);
    }
  }
  const citations = [...new Set(outcome.answer.claims.flatMap((claim) =>
    canonicalCitationRefs(claim.citationRefs, outcome.queryId, claim.claimId).map((citation) =>
      `${claim.claimId}\u0000${citation.turnId}`)))];
  const entailments = outcome.citationEntailments.map((item) =>
    `${item.claimId}\u0000${item.turnId}`);
  if (new Set(entailments).size !== entailments.length || entailments.length !== citations.length ||
    entailments.some((identity) => !citations.includes(identity))) {
    throw new Error(`V4 outcome ${outcome.queryId} has unbound citation entailment`);
  }
}

function canonicalCitationRefs(values: readonly CitationReference[], queryId: string,
  claimId: string): readonly CitationReference[] {
  const byTurnId = new Map<string, CitationReference>();
  for (const citation of values) {
    const existing = byTurnId.get(citation.turnId);
    if (existing !== undefined && canonicalSha256(existing) !== canonicalSha256(citation)) {
      throw new Error(`V4 outcome ${queryId} claim ${claimId} conflicts on citation turn`);
    }
    byTurnId.set(citation.turnId, citation);
  }
  return [...byTurnId.values()].toSorted((left, right) =>
    left.turnId.localeCompare(right.turnId));
}

interface LocaleMetricCounter {
  answerableCount: number;
  blockRecall10Hits: number;
  blockRecall5Hits: number;
  finalAnswerHits: number;
  relevantBlockCount: number;
  recallAt10Hits: number;
  recallAt5Hits: number;
}

function localeMetricCounters(): Record<"en" | "mixed" | "ru", LocaleMetricCounter> {
  return {
    en: { answerableCount: 0, blockRecall10Hits: 0, blockRecall5Hits: 0,
      finalAnswerHits: 0, recallAt10Hits: 0, recallAt5Hits: 0, relevantBlockCount: 0 },
    mixed: { answerableCount: 0, blockRecall10Hits: 0, blockRecall5Hits: 0,
      finalAnswerHits: 0, recallAt10Hits: 0, recallAt5Hits: 0, relevantBlockCount: 0 },
    ru: { answerableCount: 0, blockRecall10Hits: 0, blockRecall5Hits: 0,
      finalAnswerHits: 0, recallAt10Hits: 0, recallAt5Hits: 0, relevantBlockCount: 0 },
  };
}

function frozenLocaleMetrics(counter: LocaleMetricCounter): {
  readonly answerableCount: number;
  readonly blockLocatorRecallAt5: RationalMetric;
  readonly blockLocatorRecallAt10: RationalMetric;
  readonly completeQuestionRecallAt5: RationalMetric;
  readonly completeQuestionRecallAt10: RationalMetric;
  readonly finalAnswerRecall: RationalMetric;
} {
  return Object.freeze({
    answerableCount: counter.answerableCount,
    blockLocatorRecallAt5: rational(counter.blockRecall5Hits, counter.relevantBlockCount),
    blockLocatorRecallAt10: rational(counter.blockRecall10Hits, counter.relevantBlockCount),
    completeQuestionRecallAt5: rational(counter.recallAt5Hits, counter.answerableCount),
    completeQuestionRecallAt10: rational(counter.recallAt10Hits, counter.answerableCount),
    finalAnswerRecall: rational(counter.finalAnswerHits, counter.answerableCount),
  });
}

function withinMaximumDegradation(
  candidate: RationalMetric,
  reference: RationalMetric,
  maximum: RationalMetric,
): boolean {
  if (candidate.denominator === 0 || reference.denominator === 0 || maximum.denominator === 0) {
    return false;
  }
  const left = (reference.numerator * candidate.denominator -
    candidate.numerator * reference.denominator) * maximum.denominator;
  const right = maximum.numerator * reference.denominator * candidate.denominator;
  return left <= right;
}

function assertExactRecord(value: unknown, keys: readonly string[], label: string):
Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    canonicalSha256(Object.keys(value).toSorted()) !== canonicalSha256([...keys].toSorted())) {
    throw new Error(`${label} has an invalid object shape`);
  }
  return Object.fromEntries(Object.entries(value));
}

function ndcgQuestionScoreMicros(ranked: readonly string[],
  gold: ReadonlyMap<string, 1 | 2 | 3>): number {
  const gains = ranked.slice(0, 10).map((locator) => gain(gold.get(locator) ?? 0));
  const ideal = [...gold.values()].map(gain).toSorted((left, right) => right - left).slice(0, 10);
  const numerator = gains.reduce((sum, value, index) =>
    sum + value * (ndcgDiscountMicros[index] ?? 0), 0);
  const denominator = ideal.reduce((sum, value, index) =>
    sum + value * (ndcgDiscountMicros[index] ?? 0), 0);
  if (denominator === 0) {return 0;}
  return Math.floor(numerator * ndcgScoreScale / denominator);
}

function gain(relevance: number): number {return relevance === 0 ? 0 : (2 ** relevance) - 1;}
function rational(numerator: number, denominator: number): RationalMetric {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) ||
    numerator < 0 || denominator < 0) {throw new Error("V4 metric must be a non-negative rational");}
  return Object.freeze({ denominator, numerator });
}
function percentile95(values: readonly number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 95 / 100) - 1)] ?? 0;
}
function latencySummary(values: readonly number[]) {
  const sorted = values.toSorted((left, right) => left - right);
  const at = (percent: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * percent / 100) - 1)] ?? 0;
  return Object.freeze({ maximum: sorted.at(-1) ?? 0, p50: at(50), p95: at(95) });
}
function atLeast(actual: RationalMetric, threshold: RationalMetric): boolean {
  return actual.denominator > 0 &&
    actual.numerator * threshold.denominator >= threshold.numerator * actual.denominator;
}
function gate(failures: V4ThresholdId[], id: V4ThresholdId, passed: boolean): void {
  if (!passed) {failures.push(id);}
}
