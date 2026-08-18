import { Job } from "bullmq";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
  type TestContext,
} from "vitest";

import {
  BullMqPostCallDeadLetterRecorder,
  BullMqPostCallEnqueuer,
  RetryablePostCallError,
  createPostCallDeadLetterQueue,
  createPostCallQueue,
  createPostCallQueueEvents,
  createPostCallWorker,
  drainActivePostCallJobsAndClose,
  postCallDeadLetterJobId,
  postCallJobReference,
  type PostCallDeadLetterRecord,
  type PostCallDeadLetterRecorder,
  type PostCallObservabilityEvent,
} from "../src/index.js";

const REDIS_IMAGE =
  "redis:8.8.1-alpine@sha256:8096655e437712b07503796fb64d81359256cfcff0ab29d95a7da72863786efb";
const REDIS_PORT = 6_379;

let container: StartedTestContainer | undefined;
let dockerUnavailableReason: string | undefined;

function errorChain(error: unknown): string {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(" | ");
}

function isDockerUnavailable(error: unknown): boolean {
  const message = errorChain(error).toLowerCase();
  return (
    message.includes("could not find a working container runtime strategy") ||
    message.includes("cannot connect to the docker daemon") ||
    (message.includes("docker.sock") &&
      (message.includes("enoent") ||
        message.includes("econnrefused") ||
        message.includes("eacces")))
  );
}

function redisOrSkip(context: TestContext): StartedTestContainer {
  if (container !== undefined) {
    return container;
  }
  context.skip(
    `Docker unavailable; disposable Redis integration test skipped: ${dockerUnavailableReason ?? "container runtime not initialized"}`,
  );
}

function waitForActiveToWait(
  queueEvents: ReturnType<typeof createPostCallQueueEvents>,
  jobId: string,
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      queueEvents.off("waiting", listener);
      reject(new Error(`Job ${jobId} did not move from active to waiting`));
    }, timeoutMs);
    const listener = ({
      jobId: observedJobId,
      prev,
    }: {
      readonly jobId: string;
      readonly prev?: string;
    }): void => {
      if (observedJobId !== jobId || prev !== "active") {
        return;
      }
      clearTimeout(timeout);
      queueEvents.off("waiting", listener);
      resolve();
    };
    queueEvents.on("waiting", listener);
  });
}

beforeAll(async () => {
  try {
    container = await new GenericContainer(REDIS_IMAGE)
      .withCommand([
        "redis-server",
        "--appendonly",
        "no",
        "--save",
        "",
        "--maxmemory-policy",
        "noeviction",
      ])
      .withExposedPorts(REDIS_PORT)
      .withStartupTimeout(120_000)
      .start();
  } catch (error) {
    if (!isDockerUnavailable(error)) {
      throw error;
    }
    dockerUnavailableReason = errorChain(error).slice(0, 300);
  }
}, 150_000);

afterAll(async () => {
  await container?.stop();
});

describe("BullMQ post-call adapter with disposable Redis", () => {
  it("holds an unsupported job before business handling and lets a newer runtime resume it", async (context) => {
    const redis = redisOrSkip(context);
    const connection = {
      host: redis.getHost(),
      port: redis.getMappedPort(REDIS_PORT),
    };
    const prefix = "bullmq-post-call-runtime-binding-hold";
    const queue = createPostCallQueue({ connection, prefix });
    const queueEvents = createPostCallQueueEvents({ connection, prefix });
    const deadLetters: PostCallDeadLetterRecord[] = [];
    let handlerCalls = 0;
    const rollbackWorker = createPostCallWorker({
      admission: async () => "hold",
      connection,
      deadLetterRecorder: { record: async (record) => void deadLetters.push(record) },
      handler: async () => {
        handlerCalls += 1;
      },
      prefix,
    });
    let newerWorker: ReturnType<typeof createPostCallWorker> | undefined;
    try {
      await Promise.all([queue.waitUntilReady(), queueEvents.waitUntilReady(), rollbackWorker.waitUntilReady()]);
      const receipt = await new BullMqPostCallEnqueuer(queue).enqueue({
        meetingId: "meeting-newer-binding",
        schemaVersion: 1,
      });
      const job = await queue.getJob(receipt.jobId);
      await vi.waitFor(async () => {
        expect(await job?.getState()).toBe("delayed");
      });
      expect(job?.attemptsMade).toBe(0);
      expect(handlerCalls).toBe(0);
      expect(deadLetters).toEqual([]);

      await rollbackWorker.close(false);
      await job?.promote();
      newerWorker = createPostCallWorker({
        admission: async () => "accepted",
        connection,
        deadLetterRecorder: { record: async (record) => void deadLetters.push(record) },
        handler: async () => {
          handlerCalls += 1;
        },
        prefix,
      });
      await newerWorker.waitUntilReady();
      await expect(job!.waitUntilFinished(queueEvents, 10_000)).resolves.toBeNull();
      expect(handlerCalls).toBe(1);
      expect(deadLetters).toEqual([]);
    } finally {
      await Promise.allSettled([
        rollbackWorker.close(false),
        newerWorker?.close(false) ?? Promise.resolve(),
        queueEvents.close(),
        queue.close(),
      ]);
    }
  }, 30_000);

});

describe("BullMQ post-call adapter with disposable Redis", () => {
  it("deduplicates success and explicitly dead-letters retry exhaustion", async (context) => {
    const redis = redisOrSkip(context);
    const connection = {
      host: redis.getHost(),
      port: redis.getMappedPort(REDIS_PORT),
    };
    const prefix = "bullmq-post-call-integration";
    const queue = createPostCallQueue({
      attempts: 2,
      backoffDelayMs: 10,
      connection,
      prefix,
    });
    const deadLetterQueue = createPostCallDeadLetterQueue({
      connection,
      prefix,
    });
    const queueEvents = createPostCallQueueEvents({ connection, prefix });
    const deadLetterRecords: PostCallDeadLetterRecord[] = [];
    const storedRecorder = new BullMqPostCallDeadLetterRecorder(deadLetterQueue);
    const recorder: PostCallDeadLetterRecorder = {
      record: async (record) => {
        deadLetterRecords.push(record);
        await storedRecorder.record(record);
      },
    };
    await Promise.all([
      queue.waitUntilReady(),
      deadLetterQueue.waitUntilReady(),
      queueEvents.waitUntilReady(),
    ]);

    const observerEvents: PostCallObservabilityEvent[] = [];
    let worker = createPostCallWorker({
      attempts: 2,
      backoffDelayMs: 10,
      concurrency: 2,
      connection,
      deadLetterRecorder: recorder,
      handler: () => Promise.resolve(),
      observer: (event) => {
        observerEvents.push(event);
      },
      prefix,
    });

    try {
      await worker.waitUntilReady();
      const enqueuer = new BullMqPostCallEnqueuer(queue, {
        attempts: 2,
        backoffDelayMs: 10,
      });
      const first = await enqueuer.enqueue({
        meetingId: "meeting-integration-success",
        schemaVersion: 1,
      });
      const second = await enqueuer.enqueue({
        meetingId: "meeting-integration-success",
        schemaVersion: 1,
      });
      expect(second.jobId).toBe(first.jobId);

      const successfulJob = await queue.getJob(first.jobId);
      expect(successfulJob).toBeDefined();
      await expect(
        successfulJob!.waitUntilFinished(queueEvents, 10_000),
      ).resolves.toBeNull();
      expect(await queue.getJobCounts("completed", "waiting", "active")).toMatchObject(
        { active: 0, completed: 1, waiting: 0 },
      );

      await worker.close(false);
      let attempts = 0;
      worker = createPostCallWorker({
        attempts: 2,
        backoffDelayMs: 10,
        concurrency: 1,
        connection,
        deadLetterRecorder: recorder,
        handler: async () => {
          attempts += 1;
          throw new RetryablePostCallError("SYNTHETIC_TRANSIENT_FAILURE");
        },
        observer: (event) => {
          observerEvents.push(event);
        },
        prefix,
      });
      await worker.waitUntilReady();

      const failed = await enqueuer.enqueue({
        meetingId: "meeting-integration-failure",
        schemaVersion: 1,
      });
      const failedJob = await queue.getJob(failed.jobId);
      expect(failedJob).toBeDefined();
      await expect(
        failedJob!.waitUntilFinished(queueEvents, 10_000),
      ).rejects.toThrow("SYNTHETIC_TRANSIENT_FAILURE");
      await worker.waitForActivePostCallJobs();

      const deadLetterId = postCallDeadLetterJobId(
        postCallJobReference(failed.jobId),
      );
      const deadLetterJob = await deadLetterQueue.getJob(deadLetterId);
      expect(deadLetterJob?.data).toEqual({
        attemptsMade: 2,
        failureCode: "SYNTHETIC_TRANSIENT_FAILURE",
        meetingId: "meeting-integration-failure",
        retryable: true,
        schemaVersion: 1,
        sourceJobRef: postCallJobReference(failed.jobId),
      });
      expect(attempts).toBe(2);
      expect(deadLetterRecords).toEqual([
        {
          attemptsMade: 2,
          failureCode: "SYNTHETIC_TRANSIENT_FAILURE",
          meetingId: "meeting-integration-failure",
          retryable: true,
          schemaVersion: 1,
          sourceJobRef: postCallJobReference(failed.jobId),
        },
      ]);
      expect(observerEvents.filter((event) => event.kind === "dead-letter-recorded")).toHaveLength(1);
      expect(await queue.getJobCounts("completed", "failed")).toMatchObject({
        completed: 1,
        failed: 1,
      });
      expect(await deadLetterQueue.getJobCounts("waiting")).toMatchObject({
        waiting: 1,
      });
    } finally {
      await drainActivePostCallJobsAndClose({
        queueEvents,
        queues: [queue, deadLetterQueue],
        worker,
      });
    }
  }, 30_000);

  it("treats the worker retry policy as terminal when job options allow more attempts", async (context) => {
    const redis = redisOrSkip(context);
    const connection = {
      host: redis.getHost(),
      port: redis.getMappedPort(REDIS_PORT),
    };
    const prefix = "bullmq-post-call-worker-policy-cap";
    const queue = createPostCallQueue({
      attempts: 4,
      backoffDelayMs: 10,
      connection,
      prefix,
    });
    const deadLetterQueue = createPostCallDeadLetterQueue({ connection, prefix });
    const queueEvents = createPostCallQueueEvents({ connection, prefix });
    const deadLetterRecords: PostCallDeadLetterRecord[] = [];
    const storedRecorder = new BullMqPostCallDeadLetterRecorder(deadLetterQueue);
    const recorder: PostCallDeadLetterRecorder = {
      record: async (record) => {
        deadLetterRecords.push(record);
        await storedRecorder.record(record);
      },
    };
    await Promise.all([
      queue.waitUntilReady(),
      deadLetterQueue.waitUntilReady(),
      queueEvents.waitUntilReady(),
    ]);

    let handlerCalls = 0;
    const worker = createPostCallWorker({
      attempts: 1,
      connection,
      deadLetterRecorder: recorder,
      handler: async () => {
        handlerCalls += 1;
        if (handlerCalls === 1) {
          throw new RetryablePostCallError("SYNTHETIC_POLICY_CAP_FAILURE");
        }
      },
      prefix,
    });

    try {
      await worker.waitUntilReady();
      const receipt = await new BullMqPostCallEnqueuer(queue, {
        attempts: 4,
        backoffDelayMs: 10,
      }).enqueue({
        meetingId: "meeting-worker-policy-cap",
        schemaVersion: 1,
      });
      const job = await queue.getJob(receipt.jobId);
      expect(job).toBeDefined();
      await expect(job!.waitUntilFinished(queueEvents, 10_000)).rejects.toThrow(
        "SYNTHETIC_POLICY_CAP_FAILURE",
      );
      await worker.waitForActivePostCallJobs();

      const failed = await queue.getJob(receipt.jobId);
      expect(await failed?.getState()).toBe("failed");
      expect(failed?.attemptsMade).toBe(1);
      expect(handlerCalls).toBe(1);
      expect(deadLetterRecords).toEqual([
        {
          attemptsMade: 1,
          failureCode: "SYNTHETIC_POLICY_CAP_FAILURE",
          meetingId: "meeting-worker-policy-cap",
          retryable: true,
          schemaVersion: 1,
          sourceJobRef: postCallJobReference(receipt.jobId),
        },
      ]);
    } finally {
      await drainActivePostCallJobsAndClose({
        queueEvents,
        queues: [queue, deadLetterQueue],
        worker,
      });
    }
  }, 30_000);
});

describe("BullMQ cancellation with disposable Redis", () => {
  it("requeues a lock-renewal cancellation from the configured final start without a dead letter", async (context) => {
    const redis = redisOrSkip(context);
    const connection = {
      host: redis.getHost(),
      port: redis.getMappedPort(REDIS_PORT),
    };
    const prefix = "bullmq-post-call-cancellation-final-start";
    const queue = createPostCallQueue({
      attempts: 1,
      backoffDelayMs: 10,
      connection,
      prefix,
    });
    const deadLetterQueue = createPostCallDeadLetterQueue({ connection, prefix });
    const queueEvents = createPostCallQueueEvents({ connection, prefix });
    const observerEvents: PostCallObservabilityEvent[] = [];
    const recorder = new BullMqPostCallDeadLetterRecorder(deadLetterQueue);
    await Promise.all([
      queue.waitUntilReady(),
      deadLetterQueue.waitUntilReady(),
      queueEvents.waitUntilReady(),
    ]);

    let starts = 0;
    let notifyFirstStart: () => void;
    const firstStart = new Promise<void>((resolve) => {
      notifyFirstStart = resolve;
    });
    let notifySecondStart: () => void;
    const secondStart = new Promise<void>((resolve) => {
      notifySecondStart = resolve;
    });
    let releaseSecondStart!: () => void;
    const secondCompletion = new Promise<void>((resolve) => {
      releaseSecondStart = resolve;
    });
    const worker = createPostCallWorker({
      attempts: 1,
      autorun: false,
      connection,
      deadLetterRecorder: recorder,
      handler: async (_payload, { signal }) => {
        starts += 1;
        if (starts === 1) {
          notifyFirstStart();
          if (signal === undefined) {
            throw new Error("expected a cancellation signal");
          }
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => {
              resolve();
            }, { once: true });
          });
          return;
        }
        notifySecondStart();
        await secondCompletion;
      },
      observer: (event) => {
        observerEvents.push(event);
      },
      prefix,
    });

    try {
      await worker.waitUntilReady();
      const enqueuer = new BullMqPostCallEnqueuer(queue, {
        attempts: 1,
        backoffDelayMs: 10,
      });
      const receipt = await enqueuer.enqueue({
        meetingId: "meeting-cancelled-final-start",
        schemaVersion: 1,
      });
      const transition = waitForActiveToWait(queueEvents, receipt.jobId);
      void worker.run();
      await firstStart;

      // This is BullMQ's public lock-renewal failure event. The job still owns
      // its token in this test, so the processor can prove the atomic requeue.
      worker.emit("lockRenewalFailed", [receipt.jobId]);
      await transition;
      await secondStart;

      const replay = await queue.getJob(receipt.jobId);
      expect(await replay?.getState()).toBe("active");
      expect(replay?.attemptsMade).toBe(0);
      expect(replay?.attemptsStarted).toBe(2);
      expect(await deadLetterQueue.getJobCounts("waiting", "active", "completed", "failed")).toMatchObject({
        active: 0,
        completed: 0,
        failed: 0,
        waiting: 0,
      });
      expect(observerEvents).toContainEqual({
        component: "worker",
        jobRef: postCallJobReference(receipt.jobId),
        kind: "job-requeued",
      });
      expect(observerEvents.some((event) => event.kind === "job-failed")).toBe(false);

      releaseSecondStart();
      await expect(replay!.waitUntilFinished(queueEvents, 10_000)).resolves.toBeNull();
      const completed = await queue.getJob(receipt.jobId);
      expect(await completed?.getState()).toBe("completed");
      expect(completed?.attemptsMade).toBe(1);
      expect(completed?.attemptsStarted).toBe(2);
      expect(starts).toBe(2);
      expect(await deadLetterQueue.getJobCounts("waiting", "active", "completed", "failed")).toMatchObject({
        active: 0,
        completed: 0,
        failed: 0,
        waiting: 0,
      });
    } finally {
      releaseSecondStart();
      await drainActivePostCallJobsAndClose({
        queueEvents,
        queues: [queue, deadLetterQueue],
        worker,
      });
    }
  }, 30_000);

  it("keeps a final-attempt cancellation out of failed when requeue confirmation is lost", async (context) => {
    const redis = redisOrSkip(context);
    const connection = {
      host: redis.getHost(),
      port: redis.getMappedPort(REDIS_PORT),
    };
    const prefix = "bullmq-post-call-requeue-confirmation-loss";
    const queue = createPostCallQueue({
      attempts: 1,
      backoffDelayMs: 10,
      connection,
      prefix,
    });
    const deadLetterQueue = createPostCallDeadLetterQueue({ connection, prefix });
    const queueEvents = createPostCallQueueEvents({ connection, prefix });
    const observerEvents: PostCallObservabilityEvent[] = [];
    await Promise.all([
      queue.waitUntilReady(),
      deadLetterQueue.waitUntilReady(),
      queueEvents.waitUntilReady(),
    ]);

    const moveToWait = vi.spyOn(Job.prototype, "moveToWait");
    moveToWait.mockImplementationOnce(
      async function (this: Job, token?: string) {
        moveToWait.mockRestore();
        await this.moveToWait(token);
        throw new Error("simulated Redis response loss after moveToWait");
      },
    );
    let starts = 0;
    let notifyFirstStart!: () => void;
    const firstStart = new Promise<void>((resolve) => {
      notifyFirstStart = resolve;
    });
    let notifySecondStart!: () => void;
    const secondStart = new Promise<void>((resolve) => {
      notifySecondStart = resolve;
    });
    let releaseSecondStart!: () => void;
    const secondCompletion = new Promise<void>((resolve) => {
      releaseSecondStart = resolve;
    });
    const worker = createPostCallWorker({
      attempts: 1,
      autorun: false,
      connection,
      deadLetterRecorder: new BullMqPostCallDeadLetterRecorder(deadLetterQueue),
      handler: async (_payload, { signal }) => {
        starts += 1;
        if (starts === 1) {
          notifyFirstStart();
          if (signal === undefined) {
            throw new Error("expected a cancellation signal");
          }
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => {
              resolve();
            }, { once: true });
          });
          return;
        }
        notifySecondStart();
        await secondCompletion;
      },
      observer: (event) => {
        observerEvents.push(event);
      },
      prefix,
    });

    try {
      await worker.waitUntilReady();
      const receipt = await new BullMqPostCallEnqueuer(queue, {
        attempts: 1,
        backoffDelayMs: 10,
      }).enqueue({
        meetingId: "meeting-requeue-confirmation-loss",
        schemaVersion: 1,
      });
      const transition = waitForActiveToWait(queueEvents, receipt.jobId);
      void worker.run();
      await firstStart;

      worker.emit("lockRenewalFailed", [receipt.jobId]);
      await transition;
      await secondStart;

      const replay = await queue.getJob(receipt.jobId);
      expect(await replay?.getState()).toBe("active");
      expect(replay?.attemptsMade).toBe(0);
      expect(replay?.attemptsStarted).toBe(3);
      expect(starts).toBe(2);
      expect(observerEvents.some((event) => event.kind === "job-failed")).toBe(false);
      expect(observerEvents).toContainEqual({ component: "worker", kind: "runtime-error" });
      expect(await deadLetterQueue.getJobCounts("waiting", "active", "completed", "failed")).toMatchObject({
        active: 0,
        completed: 0,
        failed: 0,
        waiting: 0,
      });

      releaseSecondStart();
      await expect(replay!.waitUntilFinished(queueEvents, 10_000)).resolves.toBeNull();
      const completed = await queue.getJob(receipt.jobId);
      expect(await completed?.getState()).toBe("completed");
      expect(completed?.attemptsMade).toBe(1);
    } finally {
      moveToWait.mockRestore();
      releaseSecondStart();
      await drainActivePostCallJobsAndClose({
        queueEvents,
        queues: [queue, deadLetterQueue],
        worker,
      });
    }
  }, 30_000);
});

describe("BullMQ bounded shutdown with disposable Redis", () => {
  it("cancels and requeues active work during bounded shutdown before a replacement worker completes it", async (context) => {
    const redis = redisOrSkip(context);
    const connection = {
      host: redis.getHost(),
      port: redis.getMappedPort(REDIS_PORT),
    };
    const prefix = "bullmq-post-call-shutdown-requeue";
    const queue = createPostCallQueue({
      attempts: 1,
      backoffDelayMs: 10,
      connection,
      prefix,
    });
    const verificationQueue = createPostCallQueue({ connection, prefix });
    const deadLetterQueue = createPostCallDeadLetterQueue({ connection, prefix });
    const queueEvents = createPostCallQueueEvents({ connection, prefix });
    const verificationEvents = createPostCallQueueEvents({ connection, prefix });
    const recorder = new BullMqPostCallDeadLetterRecorder(deadLetterQueue);
    await Promise.all([
      queue.waitUntilReady(),
      verificationQueue.waitUntilReady(),
      deadLetterQueue.waitUntilReady(),
      queueEvents.waitUntilReady(),
      verificationEvents.waitUntilReady(),
    ]);

    let notifyFirstStart: () => void;
    const firstStart = new Promise<void>((resolve) => {
      notifyFirstStart = resolve;
    });
    const worker = createPostCallWorker({
      attempts: 1,
      connection,
      deadLetterRecorder: recorder,
      handler: async (_payload, { signal }) => {
        notifyFirstStart();
        if (signal === undefined) {
          throw new Error("expected a shutdown cancellation signal");
        }
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            resolve();
          }, { once: true });
        });
      },
      prefix,
    });

    let replacementWorker: ReturnType<typeof createPostCallWorker> | undefined;
    try {
      await worker.waitUntilReady();
      const enqueuer = new BullMqPostCallEnqueuer(queue, {
        attempts: 1,
        backoffDelayMs: 10,
      });
      const receipt = await enqueuer.enqueue({
        meetingId: "meeting-shutdown-requeue",
        schemaVersion: 1,
      });
      await firstStart;

      await drainActivePostCallJobsAndClose({
        queueEvents,
        queues: [queue, deadLetterQueue],
        shutdownTimeoutMs: 10_000,
        worker,
      });

      const requeued = await verificationQueue.getJob(receipt.jobId);
      expect(await requeued?.getState()).toBe("waiting");
      expect(requeued?.attemptsMade).toBe(0);
      expect(requeued?.attemptsStarted).toBe(1);

      replacementWorker = createPostCallWorker({
        attempts: 1,
        connection,
        deadLetterRecorder: {
          record: async () => {
            throw new Error("shutdown cancellation must not dead-letter");
          },
        },
        handler: () => Promise.resolve(),
        prefix,
      });
      await replacementWorker.waitUntilReady();
      await expect(requeued!.waitUntilFinished(verificationEvents, 10_000)).resolves.toBeNull();
      const completed = await verificationQueue.getJob(receipt.jobId);
      expect(await completed?.getState()).toBe("completed");
      expect(completed?.attemptsMade).toBe(1);
      expect(completed?.attemptsStarted).toBe(2);
    } finally {
      if (replacementWorker !== undefined) {
        await replacementWorker.close(false);
      }
      await Promise.allSettled([
        verificationEvents.close(),
        verificationQueue.close(),
      ]);
    }
  }, 30_000);

  it("keeps shutdown from force-closing between handler return and BullMQ completion", async (context) => {
    const redis = redisOrSkip(context);
    const connection = {
      host: redis.getHost(),
      port: redis.getMappedPort(REDIS_PORT),
    };
    const prefix = "bullmq-post-call-completion-commit-shutdown";
    const queue = createPostCallQueue({ connection, prefix });
    const deadLetterQueue = createPostCallDeadLetterQueue({ connection, prefix });
    const queueEvents = createPostCallQueueEvents({ connection, prefix });
    await Promise.all([
      queue.waitUntilReady(),
      deadLetterQueue.waitUntilReady(),
      queueEvents.waitUntilReady(),
    ]);

    let notifyMoveStarted!: () => void;
    const moveStarted = new Promise<void>((resolve) => {
      notifyMoveStarted = resolve;
    });
    let releaseMove!: () => void;
    const moveRelease = new Promise<void>((resolve) => {
      releaseMove = resolve;
    });
    const moveToCompleted = vi.spyOn(
      Job.prototype,
      "moveToCompleted",
    );
    moveToCompleted.mockImplementationOnce(
      async function (
        this: Job,
        ...args: Parameters<Job["moveToCompleted"]>
      ) {
        moveToCompleted.mockRestore();
        notifyMoveStarted();
        await moveRelease;
        return this.moveToCompleted(...args);
      },
    );
    const worker = createPostCallWorker({
      connection,
      deadLetterRecorder: new BullMqPostCallDeadLetterRecorder(deadLetterQueue),
      handler: async () => {},
      prefix,
    });
    let closeStarted = false;
    worker.once("closing", () => {
      closeStarted = true;
    });
    let shutdownFinished = false;

    try {
      await worker.waitUntilReady();
      await new BullMqPostCallEnqueuer(queue).enqueue({
        meetingId: "meeting-completion-commit-shutdown",
        schemaVersion: 1,
      });
      await moveStarted;

      const shutdown = drainActivePostCallJobsAndClose({
        queueEvents,
        queues: [queue, deadLetterQueue],
        worker,
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(closeStarted).toBe(false);

      releaseMove();
      await shutdown;
      shutdownFinished = true;
      expect(closeStarted).toBe(true);
    } finally {
      moveToCompleted.mockRestore();
      releaseMove();
      if (!shutdownFinished) {
        await Promise.allSettled([
          worker.close(true),
          queueEvents.close(),
          queue.close(),
          deadLetterQueue.close(),
        ]);
      }
    }
  }, 30_000);
});
