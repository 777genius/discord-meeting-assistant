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
