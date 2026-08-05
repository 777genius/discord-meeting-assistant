import {
  POST_CALL_JOB_NAME,
  createPostCallProcessor,
  type PostCallJobLike,
} from "@discord-meeting/bullmq-adapter";
import type { ProcessMeetingSummary } from "@discord-meeting/meeting-core";
import type {
  Logger,
  PrometheusMetrics,
} from "@discord-meeting/observability-adapter";
import { describe, expect, it, vi } from "vitest";

import {
  PostCallOutboxDispatcher,
} from "../src/application/post-call-outbox-dispatcher.js";
import {
  closePartiallyCreatedPostCallQueues,
  createPostCallHandler,
} from "../src/composition/post-call.js";

describe("PostCallOutboxDispatcher", () => {
  const terminalRecorder = { record: async () => {} };

  it("retains a failed durable item and dispatches it after restart", async () => {
    const pending = [{ meetingId: "meeting-1", schemaVersion: 1 as const }];
    const markPostCallEnqueued = vi.fn(async () => {});
    const markPostCallProcessed = vi.fn(async () => {});
    const outbox = {
      listRecoverablePostCall: async () => [...pending],
      markPostCallEnqueued,
      markPostCallProcessed,
    };
    const failedEnqueue = vi.fn(async () => {
      throw new Error("redis unavailable");
    });
    const warn = vi.fn();

    await expect(
      new PostCallOutboxDispatcher(
        outbox,
        { enqueue: failedEnqueue },
        terminalRecorder,
        { warn },
      )
        .dispatchPending(),
    ).resolves.toEqual({ dispatched: 0, failed: 1 });
    expect(pending).toHaveLength(1);
    expect(markPostCallEnqueued).not.toHaveBeenCalled();

    const recoveredEnqueue = vi.fn(async () => ({ status: "available" as const }));
    await expect(
      new PostCallOutboxDispatcher(
        outbox,
        { enqueue: recoveredEnqueue },
        terminalRecorder,
        { warn },
      )
        .dispatchPending(),
    ).resolves.toEqual({ dispatched: 1, failed: 0 });
    expect(recoveredEnqueue).toHaveBeenCalledWith({
      meetingId: "meeting-1",
      schemaVersion: 1,
    });
    expect(markPostCallEnqueued).toHaveBeenCalledWith("meeting-1");
    expect(markPostCallProcessed).not.toHaveBeenCalled();
    expect(pending).toHaveLength(1);
  });

  it("coalesces concurrent reconciliation runs", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const listRecoverablePostCall = vi.fn(async () => {
      await gate;
      return [];
    });
    const dispatcher = new PostCallOutboxDispatcher(
      {
        listRecoverablePostCall,
        markPostCallEnqueued: async () => {},
        markPostCallProcessed: async () => {},
      },
      { enqueue: async () => ({ status: "available" }) },
      terminalRecorder,
      { warn: vi.fn() },
    );

    const first = dispatcher.dispatchPending();
    const second = dispatcher.dispatchPending();
    release?.();
    await Promise.all([first, second]);
    expect(listRecoverablePostCall).toHaveBeenCalledOnce();
  });

  it("settles completed and terminal failed jobs without retrying business work", async () => {
    const items = [
      { meetingId: "meeting-completed", schemaVersion: 1 as const },
      { meetingId: "meeting-failed", schemaVersion: 1 as const },
    ];
    const markPostCallEnqueued = vi.fn(async () => {});
    const markPostCallProcessed = vi.fn(async () => {});
    const record = vi.fn(async () => {});
    const sourceJobRef = "a".repeat(64);
    const enqueue = vi.fn(async (item: (typeof items)[number]) =>
      item.meetingId === "meeting-completed"
        ? { status: "completed" as const }
        : {
          deadLetter: {
            attemptsMade: 4,
            failureCode: "SUMMARY_PROVIDER_FAILED",
            meetingId: item.meetingId,
            retryable: true,
            schemaVersion: 1 as const,
            sourceJobRef,
          },
          status: "failed" as const,
        }
    );
    const dispatcher = new PostCallOutboxDispatcher(
      {
        listRecoverablePostCall: async () => items,
        markPostCallEnqueued,
        markPostCallProcessed,
      },
      { enqueue },
      { record },
      { warn: vi.fn() },
    );

    await expect(dispatcher.dispatchPending()).resolves.toEqual({
      dispatched: 2,
      failed: 0,
    });
    expect(markPostCallProcessed).toHaveBeenCalledOnce();
    expect(markPostCallProcessed).toHaveBeenCalledWith("meeting-completed");
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      meetingId: "meeting-failed",
      sourceJobRef,
    }));
    expect(markPostCallEnqueued).not.toHaveBeenCalled();
  });

  it("reports an initial outbox read failure without leaking a rejected background task", async () => {
    const cause = new Error("postgres unavailable");
    const warn = vi.fn();
    const dispatcher = new PostCallOutboxDispatcher(
      {
        listRecoverablePostCall: async () => {
          throw cause;
        },
        markPostCallEnqueued: async () => {},
        markPostCallProcessed: async () => {},
      },
      { enqueue: async () => ({ status: "available" }) },
      terminalRecorder,
      { warn },
    );

    await expect(dispatcher.dispatchPending()).resolves.toEqual({
      dispatched: 0,
      failed: 1,
    });
    expect(warn).toHaveBeenCalledWith(
      "Post-call outbox reconciliation failed before dispatch",
      { errorName: "Error" },
    );
  });

  it("waits for an active reconciliation before reporting idle", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatcher = new PostCallOutboxDispatcher(
      {
        listRecoverablePostCall: async () => {
          await gate;
          return [];
        },
        markPostCallEnqueued: async () => {},
        markPostCallProcessed: async () => {},
      },
      { enqueue: async () => ({ status: "available" }) },
      terminalRecorder,
      { warn: vi.fn() },
    );

    void dispatcher.dispatchPending();
    let idle = false;
    const draining = dispatcher.whenIdle().then(() => {
      idle = true;
      return null;
    });
    await Promise.resolve();
    expect(idle).toBe(false);

    release?.();
    await draining;
    expect(idle).toBe(true);
  });

  it("retries when the processing receipt fails after a reused publication", async () => {
    const execute = vi.fn(async () => ({
      externalPublicationId: "publication-1",
      idempotencyKey: "publication-key-1",
      reused: true,
      status: "published" as const,
    }));
    const markPostCallProcessed = vi.fn(async () => {
      throw new Error("postgres receipt unavailable");
    });
    const logger = {
      info: vi.fn(),
    } as unknown as Logger;
    const recordDiscordPublication = vi.fn();
    const metrics = {
      recordDiscordPublication,
    } as unknown as PrometheusMetrics;
    const handler = createPostCallHandler(
      { execute } as unknown as ProcessMeetingSummary,
      { markPostCallProcessed },
      logger,
      metrics,
    );
    const processor = createPostCallProcessor({
      deadLetterRecorder: { record: async () => {} },
      handler,
    });

    await expect(
      processor({
        attemptsMade: 0,
        data: { meetingId: "meeting-1", schemaVersion: 1 },
        id: "post-call-receipt-test",
        name: POST_CALL_JOB_NAME,
        opts: { attempts: 2 },
      } satisfies PostCallJobLike),
    ).rejects.toMatchObject({
      code: "POST_CALL_PROCESSING_RECEIPT_FAILED",
      retryable: true,
    });
    expect(execute).toHaveBeenCalledWith("meeting-1", {});
    expect(markPostCallProcessed).toHaveBeenCalledWith("meeting-1");
    expect(recordDiscordPublication).not.toHaveBeenCalled();
  });
});

describe("post-call composition cleanup", () => {
  it("closes partially created queues sequentially and preserves the creation failure", async () => {
    const calls: string[] = [];
    const startupFailure = new Error("worker construction failed");
    let releaseEvents!: () => void;
    let signalEventsStarted!: () => void;
    const eventsStarted = new Promise<void>((resolve) => {
      signalEventsStarted = resolve;
    });
    const eventsClose = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });
    const queueEvents = {
      close: async () => {
        calls.push("events");
        signalEventsStarted();
        await eventsClose;
      },
    };
    const deadLetterQueue = {
      close: async () => {
        calls.push("dead-letter");
        throw new Error("dead letter close failed");
      },
    };
    const queue = {
      close: async () => {
        calls.push("queue");
      },
    };

    const closing = closePartiallyCreatedPostCallQueues(
      startupFailure,
      queueEvents,
      deadLetterQueue,
      queue,
    );
    await eventsStarted;
    expect(calls).toEqual(["events"]);

    releaseEvents();
    let failure: unknown;
    try {
      await closing;
    } catch (error) {
      failure = error;
    }

    expect(calls).toEqual(["events", "dead-letter", "queue"]);
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors[0]).toBe(startupFailure);
    expect(aggregate.errors[1]).toMatchObject({
      message: "Could not close post-call dead-letter queue",
    });
  });
});
