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

    const signal = new AbortController().signal;
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

  it("replays a cancelled final attempt without recording a dead letter", async () => {
    const recorder = new CapturingDeadLetterRecorder();
    const controller = new AbortController();
    let notifyHandlerStarted: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      notifyHandlerStarted = resolve;
    });
    const processor = createPostCallProcessor({
      attempts: 3,
      deadLetterRecorder: recorder,
      handler: async (_payload, context) => {
        notifyHandlerStarted();
        const signal = context.signal;
        if (signal === undefined) {
          throw new Error("expected worker cancellation signal");
        }
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            resolve();
          }, { once: true });
        });
      },
    });

    const processing = processor(postCallJob({ attemptsMade: 2 }), controller.signal);
    await handlerStarted;
    controller.abort(new Error("lock lost"));

    await expect(processing).rejects.toMatchObject({
      code: "JOB_CANCELLED",
      name: "PostCallCancellationError",
      retryable: true,
    });
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

  it("defers a retryable final failure to the confirmed BullMQ failed event", async () => {
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
    expect(recorder.records).toEqual([]);
  });

  it("maps a declared permanent failure without pre-committing a dead letter", async () => {
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
    expect(recorder.records).toEqual([]);
  });

  it("never forwards malformed payload data to the handler", async () => {
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
    expect(recorder.records).toEqual([]);
  });

  it("forces a retryable failure at the worker policy cap to be terminal", async () => {
    const recorder = new CapturingDeadLetterRecorder();
    const processor = createPostCallProcessor({
      attempts: 1,
      deadLetterRecorder: recorder,
      handler: async () => {
        throw new RetryablePostCallError("UPSTREAM_UNAVAILABLE");
      },
    });

    await expect(
      processor(postCallJob({ opts: { attempts: 4 } })),
    ).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      name: "CappedRetryableWorkerError",
      retryable: true,
    });
    expect(recorder.records).toEqual([]);
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
        cancelActivePostCallJobs: (reason) => {
          calls.push(`cancel:${String(reason)}`);
        },
        close: async (force) => {
          calls.push(`worker:${String(force)}`);
        },
        pause: async (doNotWaitActive) => {
          calls.push(`pause:${String(doNotWaitActive)}`);
        },
        waitForActivePostCallJobs: async () => {
          calls.push("wait-active");
        },
      },
    });

    expect(calls.slice(0, 4)).toEqual([
      "pause:true",
      "cancel:shutdown",
      "wait-active",
      "worker:true",
    ]);
    expect(calls.slice(4).toSorted()).toEqual(["events", "queue"]);
  });

  it("closes admission before asynchronous pause settles", async () => {
    const calls: string[] = [];
    let resumePause!: () => void;
    const pause = new Promise<void>((resolve) => {
      resumePause = resolve;
    });

    const shutdown = drainActivePostCallJobsAndClose({
      worker: {
        cancelActivePostCallJobs: (reason) => {
          calls.push(`cancel:${String(reason)}`);
        },
        close: async (force) => {
          calls.push(`worker:${String(force)}`);
        },
        pause: () => {
          calls.push("pause");
          return pause;
        },
        waitForActivePostCallJobs: async () => {
          calls.push("wait-active");
        },
      },
    });

    expect(calls).toEqual(["pause", "cancel:shutdown"]);
    resumePause();
    await shutdown;
    expect(calls).toEqual([
      "pause",
      "cancel:shutdown",
      "wait-active",
      "worker:true",
    ]);
  });

  it("attempts every close and reports aggregate failure", async () => {
    const queueClose = vi.fn(() => Promise.resolve());

    await expect(
      drainActivePostCallJobsAndClose({
        queues: [{ close: queueClose }],
        worker: {
          cancelActivePostCallJobs: () => {},
          close: async () => {
            throw new Error("worker close failed");
          },
          pause: async () => {},
          waitForActivePostCallJobs: async () => {},
        },
      }),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(queueClose).toHaveBeenCalledOnce();
  });

  it("bounds a hung force-close and disconnects the worker", async () => {
    const calls: string[] = [];
    const never = new Promise<void>(() => {});

    await expect(
      drainActivePostCallJobsAndClose({
        queues: [{ close: async () => { calls.push("queue"); } }],
        // Keep this above normal event-loop scheduling noise so the assertion
        // specifically exercises hung close operations, not an overloaded CI turn.
        shutdownTimeoutMs: 250,
        worker: {
          cancelActivePostCallJobs: (reason) => {
            calls.push(`cancel:${String(reason)}`);
          },
          close: (force) => {
            calls.push(`close:${String(force)}`);
            return never;
          },
          disconnect: () => {
            calls.push("worker:disconnect");
          },
          pause: async () => { calls.push("pause"); },
          waitForActivePostCallJobs: async () => { calls.push("wait-active"); },
        },
      }),
    ).rejects.toBeInstanceOf(AggregateError);

    expect(calls.slice(0, 5)).toEqual([
      "pause",
      "cancel:shutdown",
      "wait-active",
      "close:true",
      "worker:disconnect",
    ]);
  });

  it("force-closes once and rejects when active work cannot be confirmed", async () => {
    const calls: string[] = [];
    const never = new Promise<void>(() => {});

    await expect(
      drainActivePostCallJobsAndClose({
        shutdownTimeoutMs: 250,
        worker: {
          cancelActivePostCallJobs: (reason) => {
            calls.push(`cancel:${String(reason)}`);
          },
          close: async (force) => {
            calls.push(`close:${String(force)}`);
          },
          pause: async () => {
            calls.push("pause");
          },
          waitForActivePostCallJobs: () => never,
        },
      }),
    ).rejects.toBeInstanceOf(AggregateError);

    expect(calls).toEqual([
      "pause",
      "cancel:shutdown",
      "close:true",
    ]);
  });

  it("bounds a hung queue close and disconnects that queue", async () => {
    const calls: string[] = [];
    const never = new Promise<void>(() => {});

    await expect(
      drainActivePostCallJobsAndClose({
        queues: [{
          close: () => {
            calls.push("queue:close");
            return never;
          },
          disconnect: () => {
            calls.push("queue:disconnect");
          },
        }],
        shutdownTimeoutMs: 250,
        worker: {
          cancelActivePostCallJobs: () => {},
          close: async () => {},
          pause: async () => {},
          waitForActivePostCallJobs: async () => {},
        },
      }),
    ).rejects.toBeInstanceOf(AggregateError);

    expect(calls).toEqual(["queue:close", "queue:disconnect"]);
  });
});
