import {
  UnrecoverableError,
  Worker,
  type ConnectionOptions,
  type Job,
} from "bullmq";

import {
  POST_CALL_JOB_NAME,
  POST_CALL_QUEUE_NAME,
  type PostCallDeadLetterRecord,
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
import { safelyObserve } from "./observability.js";
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

export interface CreatePostCallWorkerOptions
  extends CreatePostCallProcessorOptions {
  readonly autorun?: boolean;
  readonly connection: ConnectionOptions;
  readonly prefix?: string;
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

function effectiveMaxAttempts(
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

function attemptNumber(job: PostCallJobLike): number {
  return Math.max(1, job.attemptsMade + 1);
}

function tryMeetingId(data: unknown): string | null {
  const result = parsePostCallPayloadSafely(data);
  return result?.meetingId ?? null;
}

function parsePostCallPayloadSafely(data: unknown): PostCallJobPayload | null {
  try {
    return parsePostCallJobPayload(data);
  } catch {
    return null;
  }
}

function terminalFailure(
  job: PostCallJobLike,
  failure: PostCallFailureClassification,
  policy: ResolvedPostCallWorkerPolicy,
): boolean {
  return (
    !failure.retryable ||
    attemptNumber(job) >= effectiveMaxAttempts(job, policy)
  );
}

function terminalFailureAfterBullMqUpdate(
  job: PostCallJobLike,
  failure: PostCallFailureClassification,
  policy: ResolvedPostCallWorkerPolicy,
): boolean {
  return (
    !failure.retryable || job.attemptsMade >= effectiveMaxAttempts(job, policy)
  );
}

async function recordDeadLetter(
  recorder: PostCallDeadLetterRecorder,
  job: PostCallJobLike,
  failure: PostCallFailureClassification,
  observer: PostCallObserver | undefined,
  attemptsMade = attemptNumber(job),
): Promise<void> {
  const sourceJobRef = postCallJobReference(job.id);
  const record: PostCallDeadLetterRecord = Object.freeze({
    attemptsMade,
    failureCode: failure.code,
    meetingId: tryMeetingId(job.data),
    retryable: failure.retryable,
    schemaVersion: 1,
    sourceJobRef,
  });
  try {
    await recorder.record(record);
    safelyObserve(observer, {
      component: "worker",
      failureCode: failure.code,
      jobRef: sourceJobRef,
      kind: "dead-letter-recorded",
    });
  } catch {
    safelyObserve(observer, { component: "worker", kind: "runtime-error" });
  }
}

function toWorkerError(failure: PostCallFailureClassification): Error {
  return failure.retryable
    ? new MappedRetryableWorkerError(failure.code)
    : new MappedUnrecoverableWorkerError(failure.code);
}

function classificationFromWorkerError(
  error: Error,
): PostCallFailureClassification {
  if (
    error instanceof MappedRetryableWorkerError ||
    error instanceof MappedUnrecoverableWorkerError
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
        await options.handler(payload!, {
          attempt: attemptNumber(job),
          jobRef: postCallJobReference(job.id),
          maxAttempts: effectiveMaxAttempts(job, policy),
          ...(signal === undefined ? {} : { signal }),
        });
        return;
      } catch (error) {
        failure = safelyClassifyPostCallFailure(error, classifier);
      }
    }

    if (terminalFailure(job, failure, policy)) {
      await recordDeadLetter(
        options.deadLetterRecorder,
        job,
        failure,
        options.observer,
      );
    }
    throw toWorkerError(failure);
  };
}

export function createPostCallWorker(
  options: CreatePostCallWorkerOptions,
): Worker<PostCallJobPayload, void, typeof POST_CALL_JOB_NAME> {
  const policy = resolvePostCallWorkerPolicy(options);
  const processor = createPostCallProcessor(options);
  const worker = new Worker<
    PostCallJobPayload,
    void,
    typeof POST_CALL_JOB_NAME
  >(
    POST_CALL_QUEUE_NAME,
    async (job, _token, signal) => processor(job, signal),
    {
      ...(options.autorun === undefined ? {} : { autorun: options.autorun }),
      concurrency: policy.concurrency,
      connection: options.connection,
      maxStalledCount: 1,
      maxStartedAttempts: policy.attempts,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    },
  );

  worker.on("active", (job) => {
    safelyObserve(options.observer, {
      component: "worker",
      jobRef: postCallJobReference(job.id),
      kind: "job-active",
    });
  });
  worker.on("completed", (job) => {
    safelyObserve(options.observer, {
      component: "worker",
      jobRef: postCallJobReference(job.id),
      kind: "job-completed",
    });
  });
  worker.on("drained", () => {
    safelyObserve(options.observer, { component: "worker", kind: "drained" });
  });
  worker.on("stalled", (jobId) => {
    safelyObserve(options.observer, {
      component: "worker",
      jobRef: postCallJobReference(jobId),
      kind: "job-stalled",
    });
  });
  worker.on("error", () => {
    safelyObserve(options.observer, {
      component: "worker",
      kind: "runtime-error",
    });
  });
  worker.on("failed", (job, error) => {
    const failure = classificationFromWorkerError(error);
    const isTerminal =
      job === undefined || terminalFailureAfterBullMqUpdate(job, failure, policy);
    safelyObserve(options.observer, {
      attemptsMade: job?.attemptsMade ?? 0,
      component: "worker",
      failureCode: failure.code,
      jobRef: postCallJobReference(job?.id),
      kind: "job-failed",
      retryable: failure.retryable,
      terminal: isTerminal,
    });

    if (job !== undefined && isTerminal) {
      void recordDeadLetter(
        options.deadLetterRecorder,
        job,
        failure,
        options.observer,
        Math.max(1, job.attemptsMade),
      );
    }
  });

  return worker;
}

export type PostCallBullMqJob = Job<
  PostCallJobPayload,
  void,
  typeof POST_CALL_JOB_NAME
>;
