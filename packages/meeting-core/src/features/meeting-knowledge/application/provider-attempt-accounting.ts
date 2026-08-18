import type { GroundedAnswerCandidate } from "../domain/grounded-answer.js";
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

export function completeProviderAttempt(
  jobs: QuestionJobStore,
  lease: QuestionJobLease,
  attemptId: string,
  answerCandidate: GroundedAnswerCandidate,
): Promise<boolean> {
  return jobs.completeProviderAttempt({
    answerCandidate,
    attemptId,
    generation: lease.generation,
    jobId: lease.jobId,
  });
}

export function abortProviderAttempt(
  jobs: QuestionJobStore,
  lease: QuestionJobLease,
  attemptId: string,
  reason: string,
): Promise<boolean> {
  return jobs.abortProviderAttempt({
    attemptId,
    generation: lease.generation,
    jobId: lease.jobId,
    reason,
  });
}

export function failProviderAttempt(
  jobs: QuestionJobStore,
  lease: QuestionJobLease,
  policy: LocalFinalReplyPolicy,
  attemptId: string,
  input: {
    readonly reason: string;
    readonly retryable: boolean;
  },
): Promise<"deferred" | "settled" | "stale"> {
  return jobs.failProviderAttempt({
    attemptId,
    generation: lease.generation,
    jobId: lease.jobId,
    maximumProviderAttempts: policy.maximumProviderAttempts,
    reason: input.reason,
    retryable: input.retryable,
  });
}
