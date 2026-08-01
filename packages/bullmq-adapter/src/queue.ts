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
  parsePostCallJobPayload,
  postCallDeadLetterJobId,
  postCallJobId,
  postCallJobReference,
} from "./contracts.js";
import type { PostCallObserver } from "./observability.js";
import { safelyObserve } from "./observability.js";
import {
  postCallDefaultJobOptions,
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
  ): Promise<{ readonly id?: string }>;
}

export interface PostCallDeadLetterQueueClient {
  add(
    name: typeof POST_CALL_DEAD_LETTER_JOB_NAME,
    data: PostCallDeadLetterRecord,
    options: JobsOptions,
  ): Promise<{ readonly id?: string }>;
}

export interface PostCallEnqueueReceipt {
  readonly jobId: string;
}

export interface PostCallDeadLetterRecorder {
  record(record: PostCallDeadLetterRecord): Promise<void>;
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
      removeOnComplete: false,
      removeOnFail: false,
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
    const job = await this.queue.add(POST_CALL_JOB_NAME, validatedPayload, {
      ...this.#jobOptions,
      jobId,
    });
    if (job.id !== undefined && job.id !== jobId) {
      throw new Error("BullMQ returned an unexpected post-call job identifier");
    }
    safelyObserve(this.observer, {
      component: "producer-queue",
      jobRef: postCallJobReference(jobId),
      kind: "job-enqueued",
    });
    return Object.freeze({ jobId });
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
        removeOnComplete: false,
        removeOnFail: false,
        sizeLimit: 4_096,
        stackTraceLimit: 1,
      },
    );
    if (job.id !== undefined && job.id !== jobId) {
      throw new Error("BullMQ returned an unexpected dead-letter job identifier");
    }
  }
}
