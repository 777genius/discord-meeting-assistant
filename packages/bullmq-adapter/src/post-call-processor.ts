import { UnrecoverableError } from "bullmq";

import {
  POST_CALL_JOB_NAME,
  type PostCallJobPayload,
  parsePostCallJobPayload,
  postCallJobReference,
} from "./contracts.js";
import {
  type PostCallFailureClassification,
  type PostCallFailureClassifier,
  classifyPostCallFailure,
  safelyClassifyPostCallFailure,
} from "./errors.js";
import type { PostCallObserver } from "./observability.js";
import type { PostCallDeadLetterRecorder } from "./queue.js";
import {
  type ResolvedPostCallWorkerPolicy,
  type PostCallWorkerPolicyInput,
  resolvePostCallWorkerPolicy,
} from "./policy.js";

export interface PostCallHandlerContext {
  readonly attempt: number;
  readonly jobRef: string;
  readonly maxAttempts: number;
  readonly signal?: AbortSignal;
}

export type PostCallHandler = (
  payload: PostCallJobPayload,
  context: PostCallHandlerContext,
) => Promise<void>;

export interface PostCallJobLike {
  readonly attemptsMade: number;
  readonly data: unknown;
  readonly id?: string;
  readonly name: string;
  readonly opts: { readonly attempts?: number };
}

export interface CreatePostCallProcessorOptions extends PostCallWorkerPolicyInput {
  readonly classifyFailure?: PostCallFailureClassifier;
  readonly deadLetterRecorder: PostCallDeadLetterRecorder;
  readonly handler: PostCallHandler;
  readonly observer?: PostCallObserver;
}

class MappedRetryableWorkerError extends Error {
  public readonly retryable = true;

  public constructor(public readonly code: string) {
    super(`Post-call job failed: ${code}`);
    this.name = "MappedRetryableWorkerError";
  }
}

class MappedUnrecoverableWorkerError extends UnrecoverableError {
  public readonly retryable = false;

  public constructor(public readonly code: string) {
    super(`Post-call job failed permanently: ${code}`);
    this.name = "MappedUnrecoverableWorkerError";
  }
}

class CappedRetryableWorkerError extends UnrecoverableError {
  public readonly retryable = true;

  public constructor(public readonly code: string) {
    super(`Post-call job reached its retry limit: ${code}`);
    this.name = "CappedRetryableWorkerError";
  }
}

export class PostCallCancellationError extends Error {
  public readonly code = "JOB_CANCELLED";
  public readonly retryable = true;

  public constructor(reason: unknown) {
    super(
      "Post-call job was cancelled",
      reason === undefined ? {} : { cause: reason },
    );
    this.name = "PostCallCancellationError";
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new PostCallCancellationError(signal.reason);
  }
}

export function effectivePostCallMaxAttempts(
  job: PostCallJobLike,
  policy: ResolvedPostCallWorkerPolicy,
): number {
  const configuredAttempts = job.opts.attempts;
  if (
    configuredAttempts === undefined ||
    !Number.isSafeInteger(configuredAttempts) ||
    configuredAttempts < 1
  ) {
    return policy.attempts;
  }
  return Math.min(configuredAttempts, policy.attempts);
}

export function postCallAttemptNumber(job: PostCallJobLike): number {
  return Math.max(1, job.attemptsMade + 1);
}

function toWorkerError(
  failure: PostCallFailureClassification,
  terminal: boolean,
): Error {
  if (!failure.retryable) {
    return new MappedUnrecoverableWorkerError(failure.code);
  }
  return terminal
    ? new CappedRetryableWorkerError(failure.code)
    : new MappedRetryableWorkerError(failure.code);
}

export function classifyPostCallWorkerError(
  error: Error,
): PostCallFailureClassification {
  if (error instanceof PostCallCancellationError) {
    return Object.freeze({ code: error.code, retryable: error.retryable });
  }
  if (
    error instanceof MappedRetryableWorkerError ||
    error instanceof MappedUnrecoverableWorkerError ||
    error instanceof CappedRetryableWorkerError
  ) {
    return Object.freeze({ code: error.code, retryable: error.retryable });
  }
  if (error instanceof UnrecoverableError) {
    return Object.freeze({ code: "UNRECOVERABLE_FAILURE", retryable: false });
  }
  return classifyPostCallFailure(error);
}

export function createPostCallProcessor(
  options: CreatePostCallProcessorOptions,
): (job: PostCallJobLike, signal?: AbortSignal) => Promise<void> {
  const policy = resolvePostCallWorkerPolicy(options);
  const classifier = options.classifyFailure ?? classifyPostCallFailure;

  return async (job, signal) => {
    let payload: PostCallJobPayload;
    let failure: PostCallFailureClassification | undefined;

    if (job.name !== POST_CALL_JOB_NAME) {
      failure = Object.freeze({
        code: "UNSUPPORTED_JOB_NAME",
        retryable: false,
      });
    } else {
      try {
        payload = parsePostCallJobPayload(job.data);
      } catch {
        failure = Object.freeze({ code: "INVALID_JOB_PAYLOAD", retryable: false });
      }
    }

    if (failure === undefined) {
      try {
        throwIfCancelled(signal);
        await options.handler(payload!, {
          attempt: postCallAttemptNumber(job),
          jobRef: postCallJobReference(job.id),
          maxAttempts: effectivePostCallMaxAttempts(job, policy),
          ...(signal === undefined ? {} : { signal }),
        });
        throwIfCancelled(signal);
        return;
      } catch (error) {
        throwIfCancelled(signal);
        failure = safelyClassifyPostCallFailure(error, classifier);
      }
    }

    throw toWorkerError(
      failure,
      postCallAttemptNumber(job) >= effectivePostCallMaxAttempts(job, policy),
    );
  };
}
