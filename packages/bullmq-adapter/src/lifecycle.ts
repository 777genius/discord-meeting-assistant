import type { PostCallObserver } from "./observability.js";
import { safelyObserve } from "./observability.js";

export interface GracefulWorkerCloseClient {
  close(force?: boolean): Promise<void>;
}

export interface CloseClient {
  close(): Promise<void>;
}

export interface DrainActiveAndCloseOptions {
  readonly observer?: PostCallObserver;
  readonly queueEvents?: CloseClient;
  readonly queues?: readonly CloseClient[];
  readonly worker: GracefulWorkerCloseClient;
}

export async function drainActivePostCallJobsAndClose(
  options: DrainActiveAndCloseOptions,
): Promise<void> {
  const failures: unknown[] = [];

  try {
    await options.worker.close(false);
  } catch (error) {
    failures.push(error);
    safelyObserve(options.observer, {
      component: "lifecycle",
      kind: "runtime-error",
    });
  }

  const remainingResources = [
    ...(options.queueEvents === undefined ? [] : [options.queueEvents]),
    ...(options.queues ?? []),
  ];
  const closeResults = await Promise.allSettled(
    remainingResources.map(async (resource) => resource.close()),
  );
  for (const result of closeResults) {
    if (result.status === "rejected") {
      failures.push(result.reason);
      safelyObserve(options.observer, {
        component: "lifecycle",
        kind: "runtime-error",
      });
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "One or more BullMQ resources failed to close gracefully",
    );
  }
  safelyObserve(options.observer, { component: "lifecycle", kind: "closed" });
}
