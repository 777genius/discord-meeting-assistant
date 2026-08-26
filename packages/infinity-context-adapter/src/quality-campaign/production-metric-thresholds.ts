import type { MetricStratum, RatioMetric } from "./production-evidence.js";

const THRESHOLDS = Object.freeze({
  abstentionPrecision: [19, 20], abstentionRecall: [9, 10], answerComplete: [1, 1],
  answerStructure: [1, 1], blockRecallAt5: [9, 10], citationEntailment: [1, 1],
  citationMembership: [1, 1], claimPrecision: [97, 100],
  completeQuestionRecallAt5: [9, 10], finalAnswerRecall: [19, 20],
  speakerAccuracy: [1, 1], timeAccuracy: [1, 1],
} as const);

export function ndcg(ranked: readonly string[], relevant: readonly string[]): number {
  const dcg = ranked.slice(0, 10).reduce((sum, value, index) => sum + (relevant.includes(value) ?
    1 / Math.log2(index + 2) : 0), 0); const ideal = Array.from({ length: Math.min(10,
    relevant.length) }, (_, index) => 1 / Math.log2(index + 2)).reduce((a, b) => a + b, 0);
  return ideal === 0 ? 0 : Math.floor(dcg / ideal * 1_000_000);
}

export function ratio(numerator: number, denominator: number): RatioMetric {
  return Object.freeze({ denominator, numerator });
}

export function assertMetricThresholds(metrics: MetricStratum): void {
  if (metrics.outcomeCount < 1 || metrics.retrievalLatencyP95Us < 0 ||
    metrics.maximumPromptBytes < 1 || metrics.maximumPromptBytes > 16_000) {
    throw new Error("metrics are missing, unknown, or exceed bounded prompt bytes");
  }
  for (const [key, threshold] of Object.entries(THRESHOLDS) as [keyof typeof THRESHOLDS,
    readonly [number, number]][]) {const observed = metrics[key]; if (observed.denominator === 0 &&
      ["abstentionPrecision", "abstentionRecall", "citationEntailment", "citationMembership",
        "claimPrecision", "finalAnswerRecall"].includes(key)) {continue;}
    if (observed.denominator < 1 || observed.numerator * threshold[1] <
      observed.denominator * threshold[0]) {
      throw new Error(`metric threshold failed: ${key} ${observed.numerator}/${observed.denominator}`);}}
  if (metrics.crossScopeLeakageCount !== 0 || metrics.unsupportedFactualClaims !== 0 ||
    metrics.retrievalLatencyP95Us > 3_000_000) {
    throw new Error("metric threshold failed: leakage, unsupported facts, or retrieval p95");
  }
}
