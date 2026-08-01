import { QueueEvents } from "bullmq";

import { POST_CALL_QUEUE_NAME, postCallJobReference } from "./contracts.js";
import { safelyObserve } from "./observability.js";
import type { BullMqConnectionFactoryOptions } from "./queue.js";

export function createPostCallQueueEvents(
  options: BullMqConnectionFactoryOptions,
): QueueEvents {
  const events = new QueueEvents(POST_CALL_QUEUE_NAME, {
    connection: options.connection,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
  });
  const observeJobState = (
    kind: "job-active" | "job-completed" | "job-stalled",
    jobId: string,
  ): void => {
    safelyObserve(options.observer, {
      component: "queue-events",
      jobRef: postCallJobReference(jobId),
      kind,
    });
  };

  events.on("active", ({ jobId }) => {
    observeJobState("job-active", jobId);
  });
  events.on("completed", ({ jobId }) => {
    observeJobState("job-completed", jobId);
  });
  events.on("stalled", ({ jobId }) => {
    observeJobState("job-stalled", jobId);
  });
  events.on("drained", () => {
    safelyObserve(options.observer, {
      component: "queue-events",
      kind: "drained",
    });
  });
  events.on("failed", ({ jobId }) => {
    safelyObserve(options.observer, {
      component: "queue-events",
      jobRef: postCallJobReference(jobId),
      kind: "job-failed",
    });
  });
  events.on("retries-exhausted", ({ attemptsMade, jobId }) => {
    const parsedAttempts = Number.parseInt(attemptsMade, 10);
    safelyObserve(options.observer, {
      attemptsMade: Number.isSafeInteger(parsedAttempts) ? parsedAttempts : 0,
      component: "queue-events",
      jobRef: postCallJobReference(jobId),
      kind: "job-failed",
      terminal: true,
    });
  });
  events.on("error", () => {
    safelyObserve(options.observer, {
      component: "queue-events",
      kind: "runtime-error",
    });
  });
  return events;
}
