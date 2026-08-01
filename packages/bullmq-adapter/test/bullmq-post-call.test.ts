import type { JobsOptions } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import {
  BullMqPostCallDeadLetterRecorder,
  BullMqPostCallEnqueuer,
  NonRetryablePostCallError,
  POST_CALL_DEAD_LETTER_JOB_NAME,
  POST_CALL_JOB_NAME,
  RetryablePostCallError,
  createPostCallProcessor,
  drainActivePostCallJobsAndClose,
  parsePostCallJobPayload,
  postCallDeadLetterJobId,
  postCallJobId,
  postCallJobReference,
  resolvePostCallQueuePolicy,
  resolvePostCallWorkerPolicy,
  type PostCallDeadLetterQueueClient,
  type PostCallDeadLetterRecord,
  type PostCallDeadLetterRecorder,
  type PostCallJobLike,
  type PostCallJobPayload,
  type PostCallObservabilityEvent,
  type PostCallQueueClient,
} from "../src/index.js";

class CapturingPostCallQueue implements PostCallQueueClient {
  public readonly additions: {
    readonly data: PostCallJobPayload;
    readonly name: typeof POST_CALL_JOB_NAME;
    readonly options: JobsOptions;
  }[] = [];

  public async add(
    name: typeof POST_CALL_JOB_NAME,
    data: PostCallJobPayload,
    options: JobsOptions,
  ): Promise<{ readonly id?: string }> {
    this.additions.push({ data, name, options });
    return options.jobId === undefined ? {} : { id: options.jobId };
  }
}

class CapturingDeadLetterQueue implements PostCallDeadLetterQueueClient {
  public readonly additions: {
    readonly data: PostCallDeadLetterRecord;
    readonly name: typeof POST_CALL_DEAD_LETTER_JOB_NAME;
    readonly options: JobsOptions;
  }[] = [];

  public async add(
    name: typeof POST_CALL_DEAD_LETTER_JOB_NAME,
    data: PostCallDeadLetterRecord,
    options: JobsOptions,
  ): Promise<{ readonly id?: string }> {
    this.additions.push({ data, name, options });
    return options.jobId === undefined ? {} : { id: options.jobId };
  }
}

class CapturingDeadLetterRecorder implements PostCallDeadLetterRecorder {
  public readonly records: PostCallDeadLetterRecord[] = [];

  public async record(record: PostCallDeadLetterRecord): Promise<void> {
    this.records.push(record);
  }
}

function postCallJob(
  overrides: Partial<PostCallJobLike> = {},
): PostCallJobLike {
  return {
    attemptsMade: 0,
    data: { meetingId: "meeting-queue-1", schemaVersion: 1 },
    id: postCallJobId("meeting-queue-1"),
    name: POST_CALL_JOB_NAME,
    opts: { attempts: 3 },
    ...overrides,
  };
}

describe("post-call queue contract", () => {
  it("accepts only the exact V1 payload and preserves the meeting identifier", () => {
    expect(
      parsePostCallJobPayload({
        meetingId: "meeting-queue-1",
        schemaVersion: 1,
      }),
    ).toEqual({ meetingId: "meeting-queue-1", schemaVersion: 1 });

    expect(() =>
      parsePostCallJobPayload({
        extra: true,
        meetingId: "meeting-queue-1",
        schemaVersion: 1,
      }),
    ).toThrow();
    expect(() =>
      parsePostCallJobPayload({
        meetingId: " meeting-queue-1 ",
        schemaVersion: 1,
      }),
    ).toThrow();
    expect(() =>
      parsePostCallJobPayload({
        meetingId: "meeting-queue-1",
        schemaVersion: 2,
      }),
    ).toThrow();
  });

  it("derives a stable BullMQ-safe job id", () => {
    const first = postCallJobId("meeting-queue-1");
    expect(first).toBe(postCallJobId("meeting-queue-1"));
    expect(first).not.toBe(postCallJobId("meeting-queue-2"));
    expect(first).not.toContain(":");
    expect(first).toMatch(/^post-call-v1-[a-f0-9]{64}$/u);
  });

  it("enqueues with deterministic id, bounded retries, and durable deduplication", async () => {
    const queue = new CapturingPostCallQueue();
    const events: PostCallObservabilityEvent[] = [];
    const enqueuer = new BullMqPostCallEnqueuer(
      queue,
      { attempts: 3, backoffDelayMs: 250 },
      (event) => {
        events.push(event);
      },
    );

    const receipt = await enqueuer.enqueue({
      meetingId: "meeting-queue-1",
      schemaVersion: 1,
    });

    expect(receipt.jobId).toBe(postCallJobId("meeting-queue-1"));
    expect(queue.additions).toEqual([
      {
        data: { meetingId: "meeting-queue-1", schemaVersion: 1 },
        name: POST_CALL_JOB_NAME,
        options: {
          attempts: 3,
          backoff: { delay: 250, type: "exponential" },
          jobId: receipt.jobId,
          removeOnComplete: false,
          removeOnFail: false,
          sizeLimit: 4_096,
          stackTraceLimit: 5,
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("meeting-queue-1");
  });

  it("records a strict idempotent dead-letter job without raw errors", async () => {
    const queue = new CapturingDeadLetterQueue();
    const recorder = new BullMqPostCallDeadLetterRecorder(queue);
    const sourceJobRef = postCallJobReference(postCallJobId("meeting-queue-1"));
    const record: PostCallDeadLetterRecord = {
      attemptsMade: 3,
      failureCode: "UPSTREAM_UNAVAILABLE",
      meetingId: "meeting-queue-1",
      retryable: true,
      schemaVersion: 1,
      sourceJobRef,
    };

    await recorder.record(record);

    expect(queue.additions[0]).toMatchObject({
      data: record,
      name: POST_CALL_DEAD_LETTER_JOB_NAME,
      options: {
        attempts: 1,
        jobId: postCallDeadLetterJobId(sourceJobRef),
        removeOnComplete: false,
        removeOnFail: false,
      },
    });
  });

  it("rejects retry and concurrency policies outside hard bounds", () => {
    expect(() => resolvePostCallQueuePolicy({ attempts: 9 })).toThrow(
      "attempts must be an integer from 1 to 8",
    );
    expect(() => resolvePostCallQueuePolicy({ backoffDelayMs: 9 })).toThrow(
      "backoffDelayMs must be an integer from 10 to 60000",
    );
    expect(() => resolvePostCallWorkerPolicy({ concurrency: 33 })).toThrow(
      "concurrency must be an integer from 1 to 32",
    );
  });
});

describe("post-call processor", () => {
  it("passes a validated payload and bounded attempt context to the handler", async () => {
    const recorder = new CapturingDeadLetterRecorder();
    const handler = vi.fn(() => Promise.resolve());
    const processor = createPostCallProcessor({
      attempts: 3,
      concurrency: 2,
      deadLetterRecorder: recorder,
      handler,
    });

    const signal = AbortSignal.abort("test-only");
    await processor(postCallJob(), signal);

    expect(handler).toHaveBeenCalledWith(
      { meetingId: "meeting-queue-1", schemaVersion: 1 },
      {
        attempt: 1,
        jobRef: postCallJobReference(postCallJobId("meeting-queue-1")),
        maxAttempts: 3,
        signal,
      },
    );
    expect(recorder.records).toEqual([]);
  });

  it("retries a mapped transient failure without dead-lettering early", async () => {
    const recorder = new CapturingDeadLetterRecorder();
    const processor = createPostCallProcessor({
      attempts: 3,
      deadLetterRecorder: recorder,
      handler: async () => {
        throw new RetryablePostCallError("UPSTREAM_UNAVAILABLE");
      },
    });

    await expect(processor(postCallJob())).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      name: "MappedRetryableWorkerError",
      retryable: true,
    });
    expect(recorder.records).toEqual([]);
  });

  it("dead-letters a retryable failure on its final bounded attempt", async () => {
    const recorder = new CapturingDeadLetterRecorder();
    const processor = createPostCallProcessor({
      attempts: 3,
      deadLetterRecorder: recorder,
      handler: async () => {
        throw new RetryablePostCallError("UPSTREAM_UNAVAILABLE");
      },
    });

    await expect(
      processor(postCallJob({ attemptsMade: 2 })),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE", retryable: true });
    expect(recorder.records).toEqual([
      {
        attemptsMade: 3,
        failureCode: "UPSTREAM_UNAVAILABLE",
        meetingId: "meeting-queue-1",
        retryable: true,
        schemaVersion: 1,
        sourceJobRef: postCallJobReference(postCallJobId("meeting-queue-1")),
      },
    ]);
  });

  it("fails fast and dead-letters a declared permanent failure", async () => {
    const recorder = new CapturingDeadLetterRecorder();
    const processor = createPostCallProcessor({
      deadLetterRecorder: recorder,
      handler: async () => {
        throw new NonRetryablePostCallError("INVALID_RECORDING_REFERENCE");
      },
    });

    await expect(processor(postCallJob())).rejects.toMatchObject({
      code: "INVALID_RECORDING_REFERENCE",
      name: "MappedUnrecoverableWorkerError",
      retryable: false,
    });
    expect(recorder.records[0]).toMatchObject({
      attemptsMade: 1,
      failureCode: "INVALID_RECORDING_REFERENCE",
      retryable: false,
    });
  });

  it("never forwards malformed payload data to the handler or dead letter metadata", async () => {
    const recorder = new CapturingDeadLetterRecorder();
    const handler = vi.fn(() => Promise.resolve());
    const processor = createPostCallProcessor({
      deadLetterRecorder: recorder,
      handler,
    });

    await expect(
      processor(
        postCallJob({
          data: {
            meetingId: "secret-meeting-id",
            schemaVersion: 1,
            token: "do-not-copy",
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_JOB_PAYLOAD",
      retryable: false,
    });
    expect(handler).not.toHaveBeenCalled();
    expect(recorder.records[0]).toMatchObject({
      failureCode: "INVALID_JOB_PAYLOAD",
      meetingId: null,
    });
    expect(JSON.stringify(recorder.records)).not.toContain("do-not-copy");
    expect(JSON.stringify(recorder.records)).not.toContain("secret-meeting-id");
  });

  it("falls back safely when a custom classifier throws or returns an unsafe code", async () => {
    const recorder = new CapturingDeadLetterRecorder();
    const processor = createPostCallProcessor({
      classifyFailure: () => ({ code: "raw secret: value", retryable: false }),
      deadLetterRecorder: recorder,
      handler: async () => {
        throw new Error("provider secret");
      },
    });

    await expect(processor(postCallJob())).rejects.toMatchObject({
      code: "UNEXPECTED_FAILURE",
      retryable: true,
    });
    expect(recorder.records).toEqual([]);
  });

  it("isolates synchronous and asynchronous observer failures", async () => {
    const queue = new CapturingPostCallQueue();
    const synchronous = new BullMqPostCallEnqueuer(queue, {}, () => {
      throw new Error("observer failed");
    });
    const asynchronous = new BullMqPostCallEnqueuer(queue, {}, async () => {
      throw new Error("observer failed asynchronously");
    });

    const synchronousReceipt = await synchronous.enqueue({
      meetingId: "meeting-sync",
      schemaVersion: 1,
    });
    const asynchronousReceipt = await asynchronous.enqueue({
      meetingId: "meeting-async",
      schemaVersion: 1,
    });
    expect(synchronousReceipt.jobId).toMatch(/^post-call-v1-[a-f0-9]{64}$/u);
    expect(asynchronousReceipt.jobId).toMatch(/^post-call-v1-[a-f0-9]{64}$/u);
  });
});

describe("graceful lifecycle", () => {
  it("waits for active work, then closes events and queues", async () => {
    const calls: string[] = [];

    await drainActivePostCallJobsAndClose({
      queueEvents: {
        close: async () => {
          calls.push("events");
        },
      },
      queues: [
        {
          close: async () => {
            calls.push("queue");
          },
        },
      ],
      worker: {
        close: async (force) => {
          calls.push(`worker:${String(force)}`);
        },
      },
    });

    expect(calls[0]).toBe("worker:false");
    expect(calls.slice(1).toSorted()).toEqual(["events", "queue"]);
  });

  it("attempts every close and reports aggregate failure", async () => {
    const queueClose = vi.fn(() => Promise.resolve());

    await expect(
      drainActivePostCallJobsAndClose({
        queues: [{ close: queueClose }],
        worker: {
          close: async () => {
            throw new Error("worker close failed");
          },
        },
      }),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(queueClose).toHaveBeenCalledOnce();
  });
});
