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

describe("BullMQ shutdown persistence with disposable Redis", () => {
  it("reconstructs a terminal admission failure when dead-letter persistence also fails", async (context) => {
    const redis = redisOrSkip(context);
    const connection = {
      host: redis.getHost(),
      port: redis.getMappedPort(REDIS_PORT),
    };
    const prefix = "bullmq-post-call-admission-terminal-recovery";
    const queue = createPostCallQueue({ attempts: 1, connection, prefix });
    const queueEvents = createPostCallQueueEvents({ connection, prefix });
    const handler = vi.fn(() => Promise.resolve());
    const worker = createPostCallWorker({
      admission: async () => {
        throw new RetryablePostCallError("ADMISSION_STORE_UNAVAILABLE");
      },
      attempts: 1,
      connection,
      deadLetterRecorder: {
        record: async () => {
          throw new Error("synthetic terminal settlement outage");
        },
      },
      handler,
      prefix,
    });

    try {
      await Promise.all([
        queue.waitUntilReady(),
        queueEvents.waitUntilReady(),
        worker.waitUntilReady(),
      ]);
      const enqueuer = new BullMqPostCallEnqueuer(queue, { attempts: 1 });
      const payload = {
        meetingId: "meeting-admission-terminal-recovery",
        schemaVersion: 1 as const,
      };
      const receipt = await enqueuer.enqueue(payload);
      const job = await queue.getJob(receipt.jobId);
      expect(job).toBeDefined();
      await expect(job!.waitUntilFinished(queueEvents, 10_000)).rejects.toThrow(
        "ADMISSION_STORE_UNAVAILABLE",
      );
      await expect(worker.waitForActivePostCallJobs()).rejects.toThrow(
        "post-call terminal durability effects failed",
      );

      await expect(enqueuer.enqueue(payload)).resolves.toEqual({
        deadLetter: {
          attemptsMade: 1,
          failureCode: "ADMISSION_STORE_UNAVAILABLE",
          meetingId: payload.meetingId,
          retryable: true,
          schemaVersion: 1,
          sourceJobRef: postCallJobReference(receipt.jobId),
        },
        jobId: receipt.jobId,
        status: "failed",
      });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await Promise.allSettled([
        worker.close(false),
        queueEvents.close(),
        queue.close(),
      ]);
    }
  }, 30_000);

  it("waits for terminal DLQ persistence before shutdown closes its queues", async (context) => {
    const redis = redisOrSkip(context);
    const connection = {
      host: redis.getHost(),
      port: redis.getMappedPort(REDIS_PORT),
    };
    const prefix = "bullmq-post-call-delayed-dlq-shutdown";
    const queue = createPostCallQueue({
      attempts: 1,
      connection,
      prefix,
    });
    const deadLetterQueue = createPostCallDeadLetterQueue({ connection, prefix });
    const queueEvents = createPostCallQueueEvents({ connection, prefix });
    let recordingStarted!: () => void;
    const recorderStarted = new Promise<void>((resolve) => {
      recordingStarted = resolve;
    });
    let releaseRecording!: () => void;
    const recordingRelease = new Promise<void>((resolve) => {
      releaseRecording = resolve;
    });
    const records: PostCallDeadLetterRecord[] = [];
    const storedRecorder = new BullMqPostCallDeadLetterRecorder(deadLetterQueue);
    const recorder: PostCallDeadLetterRecorder = {
      record: async (record) => {
        records.push(record);
        recordingStarted();
        await recordingRelease;
        await storedRecorder.record(record);
      },
    };
    await Promise.all([
      queue.waitUntilReady(),
      deadLetterQueue.waitUntilReady(),
      queueEvents.waitUntilReady(),
    ]);

    const worker = createPostCallWorker({
      attempts: 1,
      connection,
      deadLetterRecorder: recorder,
      handler: async () => {
        throw new RetryablePostCallError("SYNTHETIC_DELAYED_DLQ_FAILURE");
      },
      prefix,
    });
    const closedResources: string[] = [];
    let shutdownFinished = false;

    try {
      await worker.waitUntilReady();
      const receipt = await new BullMqPostCallEnqueuer(queue, { attempts: 1 }).enqueue({
        meetingId: "meeting-delayed-dlq-shutdown",
        schemaVersion: 1,
      });
      const job = await queue.getJob(receipt.jobId);
      expect(job).toBeDefined();
      await expect(job!.waitUntilFinished(queueEvents, 10_000)).rejects.toThrow(
        "SYNTHETIC_DELAYED_DLQ_FAILURE",
      );
      await recorderStarted;

      const shutdown = drainActivePostCallJobsAndClose({
        queueEvents: {
          close: async () => {
            closedResources.push("events");
            await queueEvents.close();
          },
          disconnect: () => queueEvents.disconnect(),
        },
        queues: [{
          close: async () => {
            closedResources.push("queue");
            await queue.close();
          },
          disconnect: () => queue.disconnect(),
        }, {
          close: async () => {
            closedResources.push("dead-letter");
            await deadLetterQueue.close();
          },
          disconnect: () => deadLetterQueue.disconnect(),
        }],
        worker,
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(closedResources).toEqual([]);

      releaseRecording();
      await shutdown;
      shutdownFinished = true;
      expect(records).toEqual([
        {
          attemptsMade: 1,
          failureCode: "SYNTHETIC_DELAYED_DLQ_FAILURE",
          meetingId: "meeting-delayed-dlq-shutdown",
          retryable: true,
          schemaVersion: 1,
          sourceJobRef: postCallJobReference(receipt.jobId),
        },
      ]);
      expect(closedResources.toSorted()).toEqual(["dead-letter", "events", "queue"]);
    } finally {
      releaseRecording();
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

  it("fails bounded shutdown loudly when an active handler ignores cancellation", async (context) => {
    const redis = redisOrSkip(context);
    const connection = {
      host: redis.getHost(),
      port: redis.getMappedPort(REDIS_PORT),
    };
    const prefix = "bullmq-post-call-shutdown-timeout";
    const queue = createPostCallQueue({ connection, prefix });
    const deadLetterQueue = createPostCallDeadLetterQueue({ connection, prefix });
    const queueEvents = createPostCallQueueEvents({ connection, prefix });
    const observerEvents: PostCallObservabilityEvent[] = [];
    await Promise.all([
      queue.waitUntilReady(),
      deadLetterQueue.waitUntilReady(),
      queueEvents.waitUntilReady(),
    ]);

    let notifyHandlerStart: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      notifyHandlerStart = resolve;
    });
    let releaseHandler!: () => void;
    const handlerRelease = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const worker = createPostCallWorker({
      connection,
      deadLetterRecorder: new BullMqPostCallDeadLetterRecorder(deadLetterQueue),
      handler: async () => {
        notifyHandlerStart();
        await handlerRelease;
      },
      prefix,
    });

    try {
      await worker.waitUntilReady();
      await new BullMqPostCallEnqueuer(queue).enqueue({
        meetingId: "meeting-shutdown-timeout",
        schemaVersion: 1,
      });
      await handlerStarted;

      await expect(
        drainActivePostCallJobsAndClose({
          observer: (event) => {
            observerEvents.push(event);
          },
          queueEvents,
          queues: [queue, deadLetterQueue],
          shutdownTimeoutMs: 25,
          worker,
        }),
      ).rejects.toBeInstanceOf(AggregateError);
      expect(observerEvents).toContainEqual({
        component: "lifecycle",
        kind: "runtime-error",
      });
    } finally {
      releaseHandler();
    }
  }, 30_000);
});
