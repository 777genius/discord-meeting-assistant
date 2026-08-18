import type {
  LocalFinalReplyPolicy,
  QuestionJobLease,
  QuestionJobStore,
} from "./ports/final-reply.js";

export function nextProviderAttemptId(lease: QuestionJobLease): string {
  return `${lease.jobId}:generation:${lease.generation}:attempt:${lease.attempts + 1}`;
}

export function providerAttemptAvailable(
  lease: QuestionJobLease,
  policy: LocalFinalReplyPolicy,
): boolean {
  return lease.attempts < policy.maximumProviderAttempts;
}

export function reserveProviderAttempt(
  jobs: QuestionJobStore,
  lease: QuestionJobLease,
  policy: LocalFinalReplyPolicy,
  attemptId: string,
): Promise<boolean> {
  return jobs.reserveProviderAttempt({
    attemptId,
    generation: lease.generation,
    jobId: lease.jobId,
    leaseSeconds: policy.jobLeaseSeconds,
    maximumProviderAttempts: policy.maximumProviderAttempts,
  });
}

export function recordProviderAttemptOutcome(
  jobs: QuestionJobStore,
  lease: QuestionJobLease,
  attemptId: string,
  outcome: "completed" | "failed",
): Promise<boolean> {
  return jobs.recordProviderAttemptOutcome({
    attemptId,
    generation: lease.generation,
    jobId: lease.jobId,
    outcome,
  });
}

export function providerAttemptCanRetry(
  lease: QuestionJobLease,
  policy: LocalFinalReplyPolicy,
): boolean {
  return lease.attempts + 1 < policy.maximumProviderAttempts;
}
