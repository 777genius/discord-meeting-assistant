import {
  UnrecoverableError,
  WaitingError,
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

interface ActivePostCallJobLease {
  readonly signal: AbortSignal;
  release(): void;
}

class ActivePostCallJobs {
  readonly #active = new Map<string, {
    readonly controller: AbortController;
    removeWorkerAbortListener?: () => void;
  }>();
  readonly #idleWaiters = new Set<() => void>();
  readonly #terminalEffects = new Set<Promise<void>>();
  #shutdownReason: string | undefined;

  public markActive(jobId: string): void {
    this.active(jobId);
  }

  public begin(
    jobId: string,
    workerSignal: AbortSignal | undefined,
  ): ActivePostCallJobLease {
    const active = this.active(jobId);
    const { controller } = active;
    const abortFromWorker = (): void => {
      if (!controller.signal.aborted) {
        controller.abort(workerSignal?.reason);
      }
    };
    if (workerSignal?.aborted === true) {
      abortFromWorker();
    } else {
      workerSignal?.addEventListener("abort", abortFromWorker, { once: true });
    }
    active.removeWorkerAbortListener = () =>
      workerSignal?.removeEventListener("abort", abortFromWorker);
    let released = false;
    return {
      signal: controller.signal,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        const current = this.#active.get(jobId);
        if (current !== active) {
          return;
        }
        this.release(jobId, current);
      },
    };
  }

  public complete(jobId: string): void {
    const active = this.#active.get(jobId);
    if (active !== undefined) {
      this.release(jobId, active);
    }
  }

  public trackTerminalEffect(effect: Promise<void>): void {
    this.#terminalEffects.add(effect);
    void effect.then(
      () => {
        this.#terminalEffects.delete(effect);
        this.notifyIfIdle();
        return null;
      },
      () => {
        this.#terminalEffects.delete(effect);
        this.notifyIfIdle();
        return null;
      },
    );
  }

  public cancelAll(reason: string): void {
    this.#shutdownReason ??= reason;
    for (const { controller } of this.#active.values()) {
      if (!controller.signal.aborted) {
        controller.abort(reason);
      }
    }
  }

  public isAdmissionClosed(): boolean {
    return this.#shutdownReason !== undefined;
  }

  public waitForIdle(): Promise<void> {
    if (this.isIdle()) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#idleWaiters.add(resolve);
    });
  }

  private active(jobId: string): {
    readonly controller: AbortController;
    removeWorkerAbortListener?: () => void;
  } {
    const existing = this.#active.get(jobId);
    if (existing !== undefined) {
      return existing;
    }
    const active = { controller: new AbortController() };
    if (this.#shutdownReason !== undefined) {
      active.controller.abort(this.#shutdownReason);
    }
    this.#active.set(jobId, active);
    return active;
  }

  private release(
    jobId: string,
    active: {
      readonly controller: AbortController;
      readonly removeWorkerAbortListener?: () => void;
    },
  ): void {
    active.removeWorkerAbortListener?.();
    this.#active.delete(jobId);
    this.notifyIfIdle();
  }

  private isIdle(): boolean {
    return this.#active.size === 0 && this.#terminalEffects.size === 0;
  }

  private notifyIfIdle(): void {
    if (!this.isIdle()) {
      return;
    }
    for (const resolve of this.#idleWaiters) {
      resolve();
    }
    this.#idleWaiters.clear();
  }
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

class PostCallCancellationError extends Error {
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

function classificationFromWorkerError(
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

async function moveCancelledJobToWait(
  job: PostCallBullMqJob,
  token: string | undefined,
  observer: PostCallObserver | undefined,
): Promise<boolean> {
  try {
    await job.moveToWait(requiredWorkerToken(token));
    safelyObserve(observer, {
      component: "worker",
      jobRef: postCallJobReference(job.id),
      kind: "job-requeued",
    });
    return true;
  } catch {
    // A cancellation must never become a normal BullMQ failure merely because
    // this worker could not confirm active -> wait. If the transition did not
    // reach Redis, the active job remains owned by BullMQ's stalled recovery.
    safelyObserve(observer, {
      component: "worker",
      kind: "runtime-error",
    });
    return false;
  }
}

function requiredActiveJobId(job: PostCallBullMqJob): string {
  if (job.id === undefined) {
    throw new Error("BullMQ active post-call job has no identifier");
  }
  return job.id;
}

function requiredWorkerToken(token: string | undefined): string {
  if (token === undefined) {
    throw new Error("BullMQ active post-call job has no lock token");
  }
  return token;
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
          attempt: attemptNumber(job),
          jobRef: postCallJobReference(job.id),
          maxAttempts: effectiveMaxAttempts(job, policy),
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
      attemptNumber(job) >= effectiveMaxAttempts(job, policy),
    );
  };
}

export function createPostCallWorker(
  options: CreatePostCallWorkerOptions,
): PostCallWorker {
  const policy = resolvePostCallWorkerPolicy(options);
  const processor = createPostCallProcessor(options);
  const activeJobs = new ActivePostCallJobs();
  const shouldAutorun = options.autorun ?? true;
  const worker = new Worker<
    PostCallJobPayload,
    void,
    typeof POST_CALL_JOB_NAME
  >(
    POST_CALL_QUEUE_NAME,
    async (job, token, signal) => {
      const activeJob = activeJobs.begin(requiredActiveJobId(job), signal);
      let releaseAfterProcessor = true;
      try {
        // A local Worker pause can race with BullMQ's optimized fetch-next
        // path. Once shutdown admission is closed, any such reactivation must
        // requeue before user code is allowed to observe the job.
        if (activeJobs.isAdmissionClosed()) {
          throw new PostCallCancellationError(activeJob.signal.reason);
        }
        await processor(job, activeJob.signal);
        // Keep the lease until BullMQ commits active -> completed and emits its
        // event. Shutdown must not force-close between user work and the state
        // transition that makes it durable.
        releaseAfterProcessor = false;
        return;
      } catch (error) {
        if (!(error instanceof PostCallCancellationError)) {
          // The `failed` event owns release after BullMQ commits retry/failure
          // state and, for terminal jobs, starts the one DLQ side effect.
          releaseAfterProcessor = false;
          throw error;
        }
        const requeued = await moveCancelledJobToWait(job, token, options.observer);
        // If Redis did not confirm the transition, retain the lease until
        // BullMQ emits stalled/terminal state. This makes shutdown fail loudly
        // instead of claiming a cancellation that may still be active.
        releaseAfterProcessor = requeued;
        throw new WaitingError();
      } finally {
        if (releaseAfterProcessor) {
          activeJob.release();
        }
      }
    },
    {
      // Attach lifecycle and lock-loss listeners before starting. This also
      // prevents a startup race from escaping active-job cancellation tracking.
      autorun: false,
      concurrency: policy.concurrency,
      connection: options.connection,
      maxStalledCount: 1,
      // INVARIANT: attemptsStarted is incremented for every active transition,
      // including an intentional active -> wait requeue and stalled recovery.
      // Only attemptsMade may bound post-call retry exhaustion.
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    },
  );

  const postCallWorker = Object.assign(worker, {
    cancelActivePostCallJobs: (reason = "shutdown") => {
      activeJobs.cancelAll(reason);
      worker.cancelAllJobs(reason);
    },
    waitForActivePostCallJobs: () => activeJobs.waitForIdle(),
  });

  postCallWorker.on("active", (job) => {
    if (job.id !== undefined) {
      activeJobs.markActive(job.id);
    }
    safelyObserve(options.observer, {
      component: "worker",
      jobRef: postCallJobReference(job.id),
      kind: "job-active",
    });
  });
  postCallWorker.on("completed", (job) => {
    if (job.id !== undefined) {
      activeJobs.complete(job.id);
    }
    safelyObserve(options.observer, {
      component: "worker",
      jobRef: postCallJobReference(job.id),
      kind: "job-completed",
    });
  });
  postCallWorker.on("drained", () => {
    safelyObserve(options.observer, { component: "worker", kind: "drained" });
  });
  postCallWorker.on("stalled", (jobId) => {
    activeJobs.complete(jobId);
    safelyObserve(options.observer, {
      component: "worker",
      jobRef: postCallJobReference(jobId),
      kind: "job-stalled",
    });
  });
  postCallWorker.on("lockRenewalFailed", (jobIds) => {
    for (const jobId of jobIds) {
      postCallWorker.cancelJob(jobId, "lock-renewal-failed");
    }
  });
  postCallWorker.on("error", () => {
    safelyObserve(options.observer, {
      component: "worker",
      kind: "runtime-error",
    });
  });
  postCallWorker.on("failed", (job, error) => {
    const failure = classificationFromWorkerError(error);
    const cancelled = error instanceof PostCallCancellationError;
    const isTerminal = !cancelled && (
      job === undefined || terminalFailureAfterBullMqUpdate(job, failure, policy)
    );
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
      activeJobs.trackTerminalEffect(recordDeadLetter(
        options.deadLetterRecorder,
        job,
        failure,
        options.observer,
        Math.max(1, job.attemptsMade),
      ));
    }
    if (job?.id !== undefined) {
      activeJobs.complete(job.id);
    }
  });

  if (shouldAutorun) {
    void postCallWorker.run().catch((error: unknown) => {
      postCallWorker.emit(
        "error",
        error instanceof Error ? error : new Error("BullMQ worker failed to start"),
      );
    });
  }

  return postCallWorker;
}

export type PostCallBullMqJob = Job<
  PostCallJobPayload,
  void,
  typeof POST_CALL_JOB_NAME
>;

export type PostCallWorker = Worker<
  PostCallJobPayload,
  void,
  typeof POST_CALL_JOB_NAME
> & {
  cancelActivePostCallJobs(reason?: string): void;
  waitForActivePostCallJobs(): Promise<void>;
};
