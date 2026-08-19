import {
  DelayedError,
  WaitingError,
  Worker,
  type ConnectionOptions,
  type Job,
} from "bullmq";

import { ActivePostCallJobs } from "./active-post-call-jobs.js";
import {
  POST_CALL_JOB_NAME,
  POST_CALL_QUEUE_NAME,
  type PostCallDeadLetterRecord,
  type PostCallJobPayload,
  parsePostCallJobPayload,
  postCallJobReference,
} from "./contracts.js";
import {
  RetryablePostCallError,
  type PostCallFailureClassification,
} from "./errors.js";
import type { PostCallObserver } from "./observability.js";
import { safelyObserve } from "./observability.js";
import {
  PostCallCancellationError,
  classifyPostCallWorkerError,
  createPostCallProcessor,
  effectivePostCallMaxAttempts,
  mapPostCallFailureToWorkerError,
  postCallAttemptNumber,
  type CreatePostCallProcessorOptions,
  type PostCallJobLike,
} from "./post-call-processor.js";
import type { PostCallDeadLetterRecorder } from "./queue.js";
import {
  type ResolvedPostCallWorkerPolicy,
  resolvePostCallWorkerPolicy,
} from "./policy.js";

export {
  createPostCallProcessor,
  type CreatePostCallProcessorOptions,
  type PostCallHandler,
  type PostCallHandlerContext,
  type PostCallJobLike,
} from "./post-call-processor.js";

export interface CreatePostCallWorkerOptions
  extends CreatePostCallProcessorOptions {
  readonly admission?: (
    payload: PostCallJobPayload,
    signal: AbortSignal,
  ) => Promise<"accepted" | "hold">;
  readonly admissionTimeoutMilliseconds?: number;
  readonly autorun?: boolean;
  readonly connection: ConnectionOptions;
  readonly prefix?: string;
}

const unsupportedRuntimeHoldMilliseconds = 60_000;
const defaultAdmissionTimeoutMilliseconds = 5_000;
const maximumAdmissionTimeoutMilliseconds = 60_000;

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
    !failure.retryable || job.attemptsMade >= effectivePostCallMaxAttempts(job, policy)
  );
}

async function recordDeadLetter(
  recorder: PostCallDeadLetterRecorder,
  job: PostCallJobLike,
  failure: PostCallFailureClassification,
  observer: PostCallObserver | undefined,
  attemptsMade = postCallAttemptNumber(job),
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
  await recorder.record(record);
  safelyObserve(observer, {
    component: "worker",
    failureCode: failure.code,
    jobRef: sourceJobRef,
    kind: "dead-letter-recorded",
  });
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

async function moveUnsupportedJobToDelayed(
  job: PostCallBullMqJob,
  token: string | undefined,
  observer: PostCallObserver | undefined,
): Promise<boolean> {
  try {
    await job.moveToDelayed(
      Date.now() + unsupportedRuntimeHoldMilliseconds,
      requiredWorkerToken(token),
    );
    safelyObserve(observer, {
      component: "worker",
      jobRef: postCallJobReference(job.id),
      kind: "job-held",
    });
    return true;
  } catch {
    safelyObserve(observer, { component: "worker", kind: "runtime-error" });
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

async function resolvePostCallAdmission(
  options: CreatePostCallWorkerOptions,
  payload: PostCallJobPayload | null,
  job: PostCallBullMqJob,
  policy: ResolvedPostCallWorkerPolicy,
  timeoutMilliseconds: number,
): Promise<"accepted" | "hold"> {
  if (payload === null || options.admission === undefined) {
    return "accepted";
  }
  try {
    return await withAdmissionTimeout(
      (signal) => options.admission!(payload, signal),
      timeoutMilliseconds,
    );
  } catch (error) {
    // Admission is part of durable post-call processing. Map its failures
    // through the same bounded retry contract as the handler, so a terminal
    // Redis job remains reconstructable if dead-letter persistence also fails.
    throw mapPostCallFailureToWorkerError(
      error,
      job,
      policy,
      options.classifyFailure,
    );
  }
}

async function withAdmissionTimeout(
  admission: (signal: AbortSignal) => Promise<"accepted" | "hold">,
  timeoutMilliseconds: number,
): Promise<"accepted" | "hold"> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new RetryablePostCallError("ADMISSION_TIMEOUT");
      controller.abort(error);
      reject(error);
    }, timeoutMilliseconds);
    timer.unref();
  });
  try {
    return await Promise.race([admission(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function resolveAdmissionTimeoutMilliseconds(
  configured: number | undefined,
): number {
  const value = configured ?? defaultAdmissionTimeoutMilliseconds;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximumAdmissionTimeoutMilliseconds
  ) {
    throw new RangeError("post-call admission timeout is outside its bound");
  }
  return value;
}

export function createPostCallWorker(
  options: CreatePostCallWorkerOptions,
): PostCallWorker {
  const policy = resolvePostCallWorkerPolicy(options);
  const admissionTimeoutMilliseconds = resolveAdmissionTimeoutMilliseconds(options.admissionTimeoutMilliseconds);
  const processor = createPostCallProcessor(options);
  const activeJobs = new ActivePostCallJobs();
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
        const payload = parsePostCallPayloadSafely(job.data);
        if (await resolvePostCallAdmission(
          options,
          payload,
          job,
          policy,
          admissionTimeoutMilliseconds,
        ) === "hold") {
          const held = await moveUnsupportedJobToDelayed(job, token, options.observer);
          releaseAfterProcessor = held;
          throw new DelayedError();
        }
        await processor(job, activeJob.signal);
        // Keep the lease until BullMQ commits active -> completed and emits its
        // event. Shutdown must not force-close between user work and the state
        // transition that makes it durable.
        releaseAfterProcessor = false;
        return;
      } catch (error) {
        if (error instanceof DelayedError) {
          throw error;
        }
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
    assertPostCallDurability: () => {
      activeJobs.assertTerminalEffectsSucceeded();
    },
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
    const failure = classifyPostCallWorkerError(error);
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

  if (options.autorun ?? true) {
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
  assertPostCallDurability(): void;
  cancelActivePostCallJobs(reason?: string): void;
  waitForActivePostCallJobs(): Promise<void>;
};
