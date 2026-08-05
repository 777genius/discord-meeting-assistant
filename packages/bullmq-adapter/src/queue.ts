import {
  Queue,
  type ConnectionOptions,
  type JobsOptions,
} from "bullmq";

import {
  POST_CALL_DEAD_LETTER_JOB_NAME,
  POST_CALL_DEAD_LETTER_QUEUE_NAME,
  POST_CALL_JOB_NAME,
  POST_CALL_QUEUE_NAME,
  type PostCallDeadLetterRecord,
  type PostCallJobPayload,
  parsePostCallDeadLetterRecord,
  parsePostCallFailureCode,
  parsePostCallJobPayload,
  postCallDeadLetterJobId,
  postCallJobId,
  postCallJobReference,
} from "./contracts.js";
import type { PostCallObserver } from "./observability.js";
import { safelyObserve } from "./observability.js";
import {
  postCallDefaultJobOptions,
  POST_CALL_DEAD_LETTER_RETENTION,
  resolvePostCallQueuePolicy,
  type PostCallQueuePolicyInput,
} from "./policy.js";

export interface BullMqConnectionFactoryOptions {
  readonly connection: ConnectionOptions;
  readonly observer?: PostCallObserver;
  readonly prefix?: string;
}

export interface CreatePostCallQueueOptions
  extends BullMqConnectionFactoryOptions,
    PostCallQueuePolicyInput {}

export interface PostCallQueueClient {
  add(
    name: typeof POST_CALL_JOB_NAME,
    data: PostCallJobPayload,
    options: JobsOptions,
  ): Promise<PostCallQueueJob>;
  getJob(jobId: string): Promise<PostCallQueueJob | undefined>;
}

export interface PostCallQueueJob {
  readonly attemptsMade: number;
  readonly data: unknown;
  readonly failedReason: string | undefined;
  readonly id?: string;
  readonly name: string;
  getState(): Promise<string>;
}

export interface PostCallDeadLetterQueueClient {
  add(
    name: typeof POST_CALL_DEAD_LETTER_JOB_NAME,
    data: PostCallDeadLetterRecord,
    options: JobsOptions,
  ): Promise<{ readonly id?: string }>;
}

export type PostCallEnqueueReceipt =
  | {
    readonly jobId: string;
    readonly status: "available";
  }
  | {
    readonly jobId: string;
    readonly status: "completed";
  }
  | {
    readonly deadLetter: PostCallDeadLetterRecord;
    readonly jobId: string;
    readonly status: "failed";
  };

export interface PostCallDeadLetterRecorder {
  record(record: PostCallDeadLetterRecord): Promise<void>;
}

export class PostCallJobConflictError extends Error {
  public constructor() {
    super("Existing BullMQ post-call job conflicts with its stable identity");
    this.name = "PostCallJobConflictError";
  }
}

function observeQueueErrors(
  queue: Queue,
  component: "dead-letter-queue" | "producer-queue",
  observer: PostCallObserver | undefined,
): void {
  queue.on("error", () => {
    safelyObserve(observer, { component, kind: "runtime-error" });
  });
}

export function createPostCallQueue(
  options: CreatePostCallQueueOptions,
): Queue<
  PostCallJobPayload,
  void,
  typeof POST_CALL_JOB_NAME,
  PostCallJobPayload,
  void,
  typeof POST_CALL_JOB_NAME
> {
  const policy = resolvePostCallQueuePolicy(options);
  const queue = new Queue<
    PostCallJobPayload,
    void,
    typeof POST_CALL_JOB_NAME,
    PostCallJobPayload,
    void,
    typeof POST_CALL_JOB_NAME
  >(
    POST_CALL_QUEUE_NAME,
    {
      connection: options.connection,
      defaultJobOptions: postCallDefaultJobOptions(policy),
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      streams: { events: { maxLen: 10_000 } },
    },
  );
  observeQueueErrors(queue, "producer-queue", options.observer);
  return queue;
}

export function createPostCallDeadLetterQueue(
  options: BullMqConnectionFactoryOptions,
): Queue<
  PostCallDeadLetterRecord,
  void,
  typeof POST_CALL_DEAD_LETTER_JOB_NAME,
  PostCallDeadLetterRecord,
  void,
  typeof POST_CALL_DEAD_LETTER_JOB_NAME
> {
  const queue = new Queue<
    PostCallDeadLetterRecord,
    void,
    typeof POST_CALL_DEAD_LETTER_JOB_NAME,
    PostCallDeadLetterRecord,
    void,
    typeof POST_CALL_DEAD_LETTER_JOB_NAME
  >(POST_CALL_DEAD_LETTER_QUEUE_NAME, {
    connection: options.connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: POST_CALL_DEAD_LETTER_RETENTION,
      removeOnFail: POST_CALL_DEAD_LETTER_RETENTION,
      sizeLimit: 4_096,
      stackTraceLimit: 1,
    },
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    streams: { events: { maxLen: 1_000 } },
  });
  observeQueueErrors(queue, "dead-letter-queue", options.observer);
  return queue;
}

export class BullMqPostCallEnqueuer {
  readonly #jobOptions: ReturnType<typeof postCallDefaultJobOptions>;

  public constructor(
    private readonly queue: PostCallQueueClient,
    policyInput: PostCallQueuePolicyInput = {},
    private readonly observer?: PostCallObserver,
  ) {
    this.#jobOptions = postCallDefaultJobOptions(
      resolvePostCallQueuePolicy(policyInput),
    );
  }

  public async enqueue(payload: unknown): Promise<PostCallEnqueueReceipt> {
    const validatedPayload = parsePostCallJobPayload(payload);
    const jobId = postCallJobId(validatedPayload.meetingId);
    const existing = await this.queue.getJob(jobId);
    const receipt =
      existing === undefined
        ? await this.addMissingJob(jobId, validatedPayload)
        : await ensureExistingJob(existing, jobId, validatedPayload);
    if (receipt.status === "available" && existing === undefined) {
      safelyObserve(this.observer, {
        component: "producer-queue",
        jobRef: postCallJobReference(jobId),
        kind: "job-enqueued",
      });
    }
    return receipt;
  }

  private async addMissingJob(
    jobId: string,
    payload: PostCallJobPayload,
  ): Promise<PostCallEnqueueReceipt> {
    const job = await this.queue.add(POST_CALL_JOB_NAME, payload, {
      ...this.#jobOptions,
      jobId,
    });
    assertExpectedPostCallJob(job, jobId, payload);
    return Object.freeze({ jobId, status: "available" });
  }
}

async function ensureExistingJob(
  job: PostCallQueueJob,
  jobId: string,
  payload: PostCallJobPayload,
): Promise<PostCallEnqueueReceipt> {
  assertExpectedPostCallJob(job, jobId, payload);
  const state = await job.getState();
  switch (state) {
    case "waiting":
    case "active":
    case "delayed":
      return Object.freeze({ jobId, status: "available" });
    case "completed":
      return Object.freeze({ jobId, status: "completed" });
    case "failed":
      return Object.freeze({
        deadLetter: terminalDeadLetter(job, payload),
        jobId,
        status: "failed",
      });
    default:
      throw new Error("Existing BullMQ post-call job has an unsupported state");
  }
}

const terminalFailureMessages = [
  {
    prefix: "Post-call job failed permanently: ",
    retryable: false,
  },
  {
    prefix: "Post-call job reached its retry limit: ",
    retryable: true,
  },
] as const;

function terminalDeadLetter(
  job: PostCallQueueJob,
  payload: PostCallJobPayload,
): PostCallDeadLetterRecord {
  const failedReason = job.failedReason ?? "";
  const message = terminalFailureMessages.find(({ prefix }) =>
    failedReason.startsWith(prefix)
  );
  if (message === undefined || !Number.isSafeInteger(job.attemptsMade) || job.attemptsMade < 1) {
    throw new Error("Existing failed BullMQ post-call job has no controlled terminal receipt");
  }
  const failureCode = parsePostCallFailureCode(
    failedReason.slice(message.prefix.length),
  );
  return Object.freeze({
    attemptsMade: job.attemptsMade,
    failureCode,
    meetingId: payload.meetingId,
    retryable: message.retryable,
    schemaVersion: 1,
    sourceJobRef: postCallJobReference(job.id),
  });
}

function assertExpectedPostCallJob(
  job: PostCallQueueJob,
  jobId: string,
  payload: PostCallJobPayload,
): void {
  if (job.id !== jobId || job.name !== POST_CALL_JOB_NAME) {
    throw new PostCallJobConflictError();
  }
  let existingPayload: PostCallJobPayload;
  try {
    existingPayload = parsePostCallJobPayload(job.data);
  } catch {
    throw new PostCallJobConflictError();
  }
  if (existingPayload.meetingId !== payload.meetingId) {
    throw new PostCallJobConflictError();
  }
}

export class BullMqPostCallDeadLetterRecorder
  implements PostCallDeadLetterRecorder
{
  public constructor(private readonly queue: PostCallDeadLetterQueueClient) {}

  public async record(record: PostCallDeadLetterRecord): Promise<void> {
    const validatedRecord = parsePostCallDeadLetterRecord(record);
    const jobId = postCallDeadLetterJobId(validatedRecord.sourceJobRef);
    const job = await this.queue.add(
      POST_CALL_DEAD_LETTER_JOB_NAME,
      validatedRecord,
      {
        attempts: 1,
        jobId,
        removeOnComplete: POST_CALL_DEAD_LETTER_RETENTION,
        removeOnFail: POST_CALL_DEAD_LETTER_RETENTION,
        sizeLimit: 4_096,
        stackTraceLimit: 1,
      },
    );
    if (job.id !== undefined && job.id !== jobId) {
      throw new Error("BullMQ returned an unexpected dead-letter job identifier");
    }
  }
}

/** Writes the authoritative ledger before the operational Redis replica. */
export class CompositePostCallDeadLetterRecorder
  implements PostCallDeadLetterRecorder
{
  public constructor(
    private readonly ledger: PostCallDeadLetterRecorder,
    private readonly redis: PostCallDeadLetterRecorder,
  ) {}

  public async record(record: PostCallDeadLetterRecord): Promise<void> {
    const validatedRecord = parsePostCallDeadLetterRecord(record);
    await this.ledger.record(validatedRecord);
    await this.redis.record(validatedRecord);
  }
}
