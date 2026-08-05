import type {
  E2eVerificationResult,
  SpeakerAccuracyMetrics,
  VerificationFailure,
} from "./e2e-evidence-verification-types.js";

export function verificationResult(
  failures: readonly VerificationFailure[],
  metrics: readonly SpeakerAccuracyMetrics[],
): E2eVerificationResult {
  return {
    failures: Object.freeze([...failures]),
    metrics: Object.freeze([...metrics]),
    passed: failures.length === 0,
  };
}
