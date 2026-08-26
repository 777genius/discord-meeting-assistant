import type { V4QualityQuestion } from "./semantic-quality-v4-corpus.js";

export interface RationalMetric {
  readonly denominator: number; readonly numerator: number;
}

export interface V4QualityMetrics {
  /** Standard micro recall over relevant production block locators. */
  readonly blockLocatorRecallAt5: RationalMetric;
  readonly blockLocatorRecallAt10: RationalMetric;
  /** One hit only when every relevant block for a question occurs within K. */
  readonly completeQuestionRecallAt5: RationalMetric;
  readonly completeQuestionRecallAt10: RationalMetric;
  readonly answerableCoverageFailureCount: number; readonly answerableExecutionFailureCount: number;
  readonly abstentionPrecision: RationalMetric; readonly abstentionRecall: RationalMetric;
  readonly citationMembership: RationalMetric; readonly citationEntailment: RationalMetric;
  readonly claimPrecision: RationalMetric; readonly crossScopeLeakageCount: number;
  readonly externallyAdjudicatedFactualClaimCount: number; readonly failureCount: number;
  readonly finalAnswerRecall: RationalMetric;
  readonly byLocale: Readonly<Record<"en" | "mixed" | "ru", {
    readonly answerableCount: number;
    readonly finalAnswerRecall: RationalMetric;
    readonly blockLocatorRecallAt5: RationalMetric;
    readonly blockLocatorRecallAt10: RationalMetric;
    readonly completeQuestionRecallAt5: RationalMetric;
    readonly completeQuestionRecallAt10: RationalMetric;
  }>>;
  readonly mrrAt10: RationalMetric; readonly ndcgAt10: RationalMetric;
  readonly retrievalStrata: {
    readonly anchorlessRecallAt5: RationalMetric;
    readonly namedAnchorRecallAt5: RationalMetric;
  };
  readonly resources: {
    readonly answerResponseBytesTotal: number;
    readonly capabilityBytesTotal: number;
    readonly evidenceBytesMaximum: number; readonly evidenceBytesTotal: number;
    readonly originalPromptBytesMaximum: number; readonly originalPromptBytesTotal: number;
    readonly promptBytesMaximum: number; readonly promptBytesTotal: number;
    readonly repairPromptBytesMaximum: number; readonly repairPromptBytesTotal: number;
    readonly requestBytesTotal: number; readonly responseBytesTotal: number;
    readonly retrievalLatencyP95Us: number;
    readonly latencyUs: Readonly<Record<"adjudication" | "answer" | "capabilityAndRetrieval" |
      "full" | "route",
      { readonly maximum: number; readonly p50: number; readonly p95: number }>>;
  };
  readonly speakerAccuracy: RationalMetric; readonly timeAccuracy: RationalMetric;
  readonly timeoutCount: number; readonly unsupportedFactualClaimCount: number;
  readonly wholeTranscriptIncludedCount: number;
}

export interface SemanticQualityV4MetricReports {
  readonly automated: V4QualityMetrics;
  readonly overall: V4QualityMetrics;
  readonly real: V4QualityMetrics;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_metric_reports.v1";
}

export type V4ThresholdId =
  | "answerable_execution_coverage" | "abstention_precision" | "abstention_recall"
  | "bounded_input" | "citation_entailment" | "citation_membership" | "claim_precision"
  | "cross_scope_leakage" | "mrr_at_10" | "final_answer_recall"
  | "final_answer_recall_en" | "final_answer_recall_mixed" | "final_answer_recall_ru"
  | "block_locator_recall_at_5" | "complete_question_recall_at_5"
  | "block_locator_recall_at_5_en" | "block_locator_recall_at_5_mixed"
  | "block_locator_recall_at_5_ru" | "complete_question_recall_at_5_en"
  | "complete_question_recall_at_5_mixed" | "complete_question_recall_at_5_ru"
  | "marker_blind_recall_at_5" | "marker_blind_recall_degradation"
  | "retrieval_latency_p95" | "speaker_accuracy" | "time_accuracy"
  | "unsupported_factual_claims" | "whole_transcript";

export interface V4ThresholdDecision {
  readonly failedGateIds: readonly V4ThresholdId[];
  readonly passed: boolean;
  readonly reportedOnlyMetricIds: readonly ["block_locator_recall_at_10",
    "complete_question_recall_at_10", "ndcg_at_10"];
}

export interface V4MetricApplicability {
  readonly automatedRetrievalStrata: boolean;
  readonly locales: readonly ("en" | "mixed" | "ru")[];
}

export interface SemanticQualityV4ScoringAuthority {
  readonly canonicalTurns: readonly CanonicalScoringTurn[];
  readonly globallyForbiddenLocatorIds: readonly string[];
  readonly knownLocatorIds: readonly string[];
  readonly questions: readonly V4ScoringQuestion[];
  readonly wholeTranscriptTurnIdsByQuestionId: Readonly<Record<string, readonly string[]>>;
}

export interface CanonicalScoringTurn {
  readonly endMs: number; readonly speakerId: string; readonly startMs: number;
  readonly text: string; readonly turnId: string;
}

export interface V4ScoringQuestion extends V4QualityQuestion {
  /** Exact execution text; real questions bypass synthetic codename ablation. */
  readonly evaluationQuestionText?: string;
}
