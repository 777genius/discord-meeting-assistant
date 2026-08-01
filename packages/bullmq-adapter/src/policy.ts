export const DEFAULT_POST_CALL_ATTEMPTS = 4;
export const DEFAULT_POST_CALL_BACKOFF_DELAY_MS = 1_000;
export const DEFAULT_POST_CALL_CONCURRENCY = 4;
export const MAX_POST_CALL_ATTEMPTS = 8;
export const MAX_POST_CALL_CONCURRENCY = 32;

const MIN_BACKOFF_DELAY_MS = 10;
const MAX_BACKOFF_DELAY_MS = 60_000;
const MAX_JOB_PAYLOAD_BYTES = 4_096;
const STACK_TRACE_LINE_LIMIT = 5;

export interface PostCallQueuePolicy {
  readonly attempts: number;
  readonly backoffDelayMs: number;
}

export interface PostCallQueuePolicyInput {
  readonly attempts?: number;
  readonly backoffDelayMs?: number;
}

export interface PostCallWorkerPolicyInput extends PostCallQueuePolicyInput {
  readonly concurrency?: number;
}

export interface ResolvedPostCallWorkerPolicy extends PostCallQueuePolicy {
  readonly concurrency: number;
}

function boundedInteger(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function resolvePostCallQueuePolicy(
  input: PostCallQueuePolicyInput = {},
): PostCallQueuePolicy {
  return Object.freeze({
    attempts: boundedInteger(
      "attempts",
      input.attempts ?? DEFAULT_POST_CALL_ATTEMPTS,
      1,
      MAX_POST_CALL_ATTEMPTS,
    ),
    backoffDelayMs: boundedInteger(
      "backoffDelayMs",
      input.backoffDelayMs ?? DEFAULT_POST_CALL_BACKOFF_DELAY_MS,
      MIN_BACKOFF_DELAY_MS,
      MAX_BACKOFF_DELAY_MS,
    ),
  });
}

export function resolvePostCallWorkerPolicy(
  input: PostCallWorkerPolicyInput = {},
): ResolvedPostCallWorkerPolicy {
  const queuePolicy = resolvePostCallQueuePolicy(input);
  return Object.freeze({
    ...queuePolicy,
    concurrency: boundedInteger(
      "concurrency",
      input.concurrency ?? DEFAULT_POST_CALL_CONCURRENCY,
      1,
      MAX_POST_CALL_CONCURRENCY,
    ),
  });
}

export function postCallDefaultJobOptions(policy: PostCallQueuePolicy) {
  return Object.freeze({
    attempts: policy.attempts,
    backoff: Object.freeze({
      delay: policy.backoffDelayMs,
      type: "exponential" as const,
    }),
    removeOnComplete: false as const,
    removeOnFail: false as const,
    sizeLimit: MAX_JOB_PAYLOAD_BYTES,
    stackTraceLimit: STACK_TRACE_LINE_LIMIT,
  });
}
