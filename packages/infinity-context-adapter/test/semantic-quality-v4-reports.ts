import { evaluateSemanticQualityV4, type V4EvaluationOutcome } from
  "./semantic-quality-v4-evaluation.js";
import type { SemanticQualityV4MetricReports, SemanticQualityV4ScoringAuthority } from
  "./semantic-quality-v4-evaluation-contract.js";

export function evaluateSemanticQualityV4Reports(input: {
  readonly authorities: Readonly<Record<"automated" | "overall" | "real",
    SemanticQualityV4ScoringAuthority>>;
  readonly outcomes: readonly V4EvaluationOutcome[];
}): SemanticQualityV4MetricReports {
  const score = (authority: SemanticQualityV4ScoringAuthority) => {
    const questionIds = new Set(authority.questions.map(({ id }) => id));
    return evaluateSemanticQualityV4({ authority,
      outcomes: input.outcomes.filter(({ queryId }) => questionIds.has(queryId)) });
  };
  return Object.freeze({ automated: score(input.authorities.automated),
    overall: score(input.authorities.overall), real: score(input.authorities.real),
    schemaVersion: "meeting_knowledge.semantic_quality_metric_reports.v1" });
}
