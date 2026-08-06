import type { RetainedE2eEvidence } from "./e2e-evidence-schema.js";
import type { VerificationFailureReporter } from "./e2e-evidence-verification-types.js";

const maximumStageDurationMs = {
  publication: 10_000,
  summary: 60_000,
  transcription: 30_000,
} as const;

const expectedSummaryRuntime = {
  model: "gpt-5.6-sol",
  outputSchemaName: "discord_meeting_summary_v4",
  policyVersion: "meeting-summary.subscription-runtime.v14",
  reasoningEffort: "medium",
} as const;

export function verifyProcessingEvidence(
  evidence: RetainedE2eEvidence,
  fail: VerificationFailureReporter,
): void {
  if (evidence.schemaVersion !== 4) {
    return;
  }
  for (const stage of ["transcription", "summary", "publication"] as const) {
    const observations = evidence.processing.stages.filter((item) => item.stage === stage);
    if (observations.length !== 1) {
      fail(
        "STAGE_OBSERVATION_COUNT_MISMATCH",
        `${stage} has ${observations.length} successful latency observations, expected exactly one`,
      );
      continue;
    }
    const observation = observations[0]!;
    if (observation.durationMs > maximumStageDurationMs[stage]) {
      fail(
        "STAGE_LATENCY_EXCEEDED",
        `${stage} took ${observation.durationMs}ms, limit is ${maximumStageDurationMs[stage]}ms`,
      );
    }
  }
  for (const execution of evidence.processing.summaryRuntimeExecutions) {
    for (const [field, expected] of Object.entries(expectedSummaryRuntime)) {
      if (execution[field as keyof typeof expectedSummaryRuntime] !== expected) {
        fail(
          "SUMMARY_RUNTIME_PROFILE_MISMATCH",
          `summary runtime ${field} does not match the E2E release profile`,
        );
      }
    }
  }
}
