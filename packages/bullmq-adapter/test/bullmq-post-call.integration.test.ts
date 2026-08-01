import { GenericContainer, type StartedTestContainer } from "testcontainers";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
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
    const recorder = new BullMqPostCallDeadLetterRecorder(deadLetterQueue);
    await Promise.all([
      queue.waitUntilReady(),
      deadLetterQueue.waitUntilReady(),
      queueEvents.waitUntilReady(),
    ]);

    let worker = createPostCallWorker({
      attempts: 2,
      backoffDelayMs: 10,
      concurrency: 2,
      connection,
      deadLetterRecorder: recorder,
      handler: () => Promise.resolve(),
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
});
