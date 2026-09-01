import type { CampaignQuestion } from "./campaign-admission-policy.js";
import type { ExpectedOutcomeInventory } from "./retention.js";
import { QUALIFICATION_THRESHOLDS } from "./qualification-contract.js";

export interface SpeakerTimeCheck {
  readonly canonicalTurnId: string; readonly expectedSpeakerId: string;
  readonly expectedStartMs: number; readonly observedSpeakerId: string;
  readonly observedStartMs: number; readonly toleranceMs: number;
}
export interface CitationCheck {
  readonly citedTurnId: string; readonly claimId: string; readonly entailed: boolean;
}
export interface ClaimCheck {
  readonly claimId: string; readonly factual: boolean; readonly supported: boolean;
}
export interface QualificationOutcome extends ExpectedOutcomeInventory {
  readonly campaignRootSha256: string; readonly citationChecks: readonly CitationCheck[];
  readonly claimChecks: readonly ClaimCheck[]; readonly locale: CampaignQuestion["locale"];
  readonly repetition: 1 | 2 | 3; readonly rootBindingSha256: string;
  readonly source: CampaignQuestion["source"]; readonly speakerTimeChecks: readonly SpeakerTimeCheck[];
}
export interface AbstentionStatistics {
  readonly abstentionPrecision: Readonly<{ denominator: number; numerator: number }>;
  readonly abstentionRecall: Readonly<{ denominator: number; numerator: number }>;
  readonly correctAbstentionCount: number; readonly expectedAbstentionCount: number;
  readonly predictedAbstentionCount: number;
}
export interface QualificationMetricGroup {
  readonly abstentionPrecision: AbstentionStatistics["abstentionPrecision"];
  readonly abstentionRecall: AbstentionStatistics["abstentionRecall"];
  readonly correctAbstentionCount: number; readonly expectedAbstentionCount: number;
  readonly predictedAbstentionCount: number;
  readonly applicableOutcomeCount: number; readonly citationCheckCount: number;
  readonly citationPassedCount: number; readonly completeRecallAt10PassedCount: number;
  readonly completeRecallAt5PassedCount: number;
  readonly factualClaimCount: number; readonly firstRelevantReciprocalRankMillionthsTotal: number;
  readonly group: "automatic" | "independent_review" | "locale:en" | "locale:mixed" |
    "locale:ru" | "overall";
  readonly ndcgAt10MillionthsTotal: number; readonly relevantLocatorCount: number;
  readonly retrievalApplicableOutcomeCount: number; readonly retrievalLatencyP95Us: number;
  readonly retrievedRelevantLocatorCountAt10: number;
  readonly retrievedRelevantLocatorCountAt5: number;
  readonly scopeLeakageCount: number; readonly speakerTimeCheckCount: number;
  readonly speakerTimePassedCount: number; readonly supportedFactualClaimCount: number;
  readonly thresholdPassed: boolean;
}

type Counters = Omit<QualificationMetricGroup, "abstentionPrecision" | "abstentionRecall" |
  "applicableOutcomeCount" | "correctAbstentionCount" | "expectedAbstentionCount" | "group" |
  "predictedAbstentionCount" | "retrievalLatencyP95Us" | "thresholdPassed">;

export function reconstructMetrics(outcomes: readonly QualificationOutcome[]):
readonly QualificationMetricGroup[] {
  const groups: readonly [QualificationMetricGroup["group"],
    (outcome: QualificationOutcome) => boolean][] = [
    ["overall", () => true], ["automatic", ({ source }) => source === "automatic"],
    ["independent_review", ({ source }) => source === "independent_review"],
    ["locale:en", ({ locale }) => locale === "en"],
    ["locale:mixed", ({ locale }) => locale === "mixed"],
    ["locale:ru", ({ locale }) => locale === "ru"],
  ];
  return Object.freeze(groups.flatMap(([group, includes]) => {
    const applicable = outcomes.filter(includes); if (applicable.length === 0) {return [];}
    const counters = applicable.reduce((sum, outcome) => accumulateOutcome(sum, outcome),
      emptyMetricCounters());
    const abstention = calculateAbstentionStatistics(applicable.map(({ abstention: value }) =>
      value));
    const latencies = applicable.map(({ retrievalLatencyUs }) => retrievalLatencyUs)
      .toSorted((left, right) => left - right);
    const retrievalLatencyP95Us = latencies[Math.ceil(latencies.length * 0.95) - 1]!;
    const thresholdPassed = atLeast(counters.completeRecallAt5PassedCount,
      counters.retrievalApplicableOutcomeCount,
      QUALIFICATION_THRESHOLDS.completeQuestionRecallAt5) &&
      atLeast(counters.retrievedRelevantLocatorCountAt5, counters.relevantLocatorCount,
        QUALIFICATION_THRESHOLDS.locatorRecallAt5) &&
      atLeast(counters.firstRelevantReciprocalRankMillionthsTotal,
        counters.retrievalApplicableOutcomeCount * 1_000_000,
        QUALIFICATION_THRESHOLDS.firstRelevantReciprocalRank) &&
      counters.citationPassedCount === counters.citationCheckCount &&
      atLeast(counters.supportedFactualClaimCount, counters.factualClaimCount,
        QUALIFICATION_THRESHOLDS.claimPrecision) &&
      atLeast(counters.speakerTimePassedCount, counters.speakerTimeCheckCount,
        QUALIFICATION_THRESHOLDS.speakerTimeAccuracy) &&
      atLeast(abstention.abstentionPrecision.numerator,
        abstention.abstentionPrecision.denominator,
        QUALIFICATION_THRESHOLDS.abstentionPrecision) &&
      atLeast(abstention.abstentionRecall.numerator,
        abstention.abstentionRecall.denominator,
        QUALIFICATION_THRESHOLDS.abstentionRecall) &&
      counters.scopeLeakageCount <= QUALIFICATION_THRESHOLDS.crossScopeLeakageMaximum &&
      retrievalLatencyP95Us <= QUALIFICATION_THRESHOLDS.maximumRetrievalLatencyP95Us;
    return [Object.freeze({ ...counters, ...abstention, applicableOutcomeCount: applicable.length,
      group, retrievalLatencyP95Us, thresholdPassed })];
  }));
}

export function calculateAbstentionStatistics(
  outcomes: readonly { readonly expected: boolean; readonly observed: boolean }[],
): AbstentionStatistics {
  const correctAbstentionCount = outcomes.filter(({ expected, observed }) =>
    expected && observed).length;
  const expectedAbstentionCount = outcomes.filter(({ expected }) => expected).length;
  const predictedAbstentionCount = outcomes.filter(({ observed }) => observed).length;
  return Object.freeze({
    abstentionPrecision: Object.freeze({ denominator: predictedAbstentionCount,
      numerator: correctAbstentionCount }),
    abstentionRecall: Object.freeze({ denominator: expectedAbstentionCount,
      numerator: correctAbstentionCount }),
    correctAbstentionCount, expectedAbstentionCount, predictedAbstentionCount,
  });
}

function atLeast(numerator: number, denominator: number,
  minimum: { readonly denominator: number; readonly numerator: number }): boolean {
  return denominator > 0 && numerator * minimum.denominator >= denominator * minimum.numerator;
}

function emptyMetricCounters(): Counters {
  return { citationCheckCount: 0, citationPassedCount: 0, completeRecallAt10PassedCount: 0,
    completeRecallAt5PassedCount: 0, factualClaimCount: 0,
    firstRelevantReciprocalRankMillionthsTotal: 0, ndcgAt10MillionthsTotal: 0,
    relevantLocatorCount: 0, retrievalApplicableOutcomeCount: 0,
    retrievedRelevantLocatorCountAt10: 0, retrievedRelevantLocatorCountAt5: 0,
    scopeLeakageCount: 0,
    speakerTimeCheckCount: 0, speakerTimePassedCount: 0, supportedFactualClaimCount: 0 };
}

function accumulateOutcome(sum: Counters, outcome: QualificationOutcome): Counters {
  const relevant = new Set(outcome.relevantLocatorIds); const topFive = outcome.rankedLocatorIds.slice(0, 5);
  const retrievedRelevant = topFive.filter((id) => relevant.has(id)).length;
  const topTen = outcome.rankedLocatorIds.slice(0, 10);
  const retrievedRelevantAt10 = topTen.filter((id) => relevant.has(id)).length;
  const firstRelevantIndex = outcome.rankedLocatorIds.findIndex((id) => relevant.has(id));
  const retrievalApplicable = relevant.size > 0;
  const complete = retrievalApplicable && outcome.relevantLocatorIds.every((id) => topFive.includes(id));
  const completeAt10 = retrievalApplicable && outcome.relevantLocatorIds.every((id) =>
    topTen.includes(id));
  const ideal = NDCG_DISCOUNTS.slice(0, Math.min(relevant.size, 10))
    .reduce((value, score) => value + score, 0);
  const observed = outcome.rankedLocatorIds.slice(0, 10).reduce((value, id, index) =>
    value + (relevant.has(id) ? NDCG_DISCOUNTS[index]! : 0), 0);
  const ndcg = retrievalApplicable ? Math.floor(observed * 1_000_000 / ideal) : 0;
  const speakerPassed = outcome.speakerTimeChecks.filter((check) =>
    check.expectedSpeakerId === check.observedSpeakerId &&
    Math.abs(check.expectedStartMs - check.observedStartMs) <= check.toleranceMs).length;
  const factualClaims = outcome.claimChecks.filter(({ factual }) => factual);
  return { citationCheckCount: sum.citationCheckCount + outcome.citationChecks.length,
    citationPassedCount: sum.citationPassedCount +
      outcome.citationChecks.filter(({ entailed }) => entailed).length,
    completeRecallAt10PassedCount: sum.completeRecallAt10PassedCount + (completeAt10 ? 1 : 0),
    completeRecallAt5PassedCount: sum.completeRecallAt5PassedCount + (complete ? 1 : 0),
    factualClaimCount: sum.factualClaimCount + factualClaims.length,
    firstRelevantReciprocalRankMillionthsTotal: sum.firstRelevantReciprocalRankMillionthsTotal +
      (firstRelevantIndex < 0 ? 0 : Math.floor(1_000_000 / (firstRelevantIndex + 1))),
    ndcgAt10MillionthsTotal: sum.ndcgAt10MillionthsTotal + ndcg,
    relevantLocatorCount: sum.relevantLocatorCount + relevant.size,
    retrievalApplicableOutcomeCount: sum.retrievalApplicableOutcomeCount +
      (retrievalApplicable ? 1 : 0),
    retrievedRelevantLocatorCountAt10: sum.retrievedRelevantLocatorCountAt10 +
      retrievedRelevantAt10,
    retrievedRelevantLocatorCountAt5: sum.retrievedRelevantLocatorCountAt5 + retrievedRelevant,
    scopeLeakageCount: sum.scopeLeakageCount + outcome.scopeViolationLocatorIds.length,
    speakerTimeCheckCount: sum.speakerTimeCheckCount + outcome.speakerTimeChecks.length,
    speakerTimePassedCount: sum.speakerTimePassedCount + speakerPassed,
    supportedFactualClaimCount: sum.supportedFactualClaimCount +
      factualClaims.filter(({ supported }) => supported).length };
}

const NDCG_DISCOUNTS = Object.freeze([1_000_000, 630_930, 500_000, 430_677, 386_853,
  356_207, 333_333, 315_465, 301_030, 289_065]);
