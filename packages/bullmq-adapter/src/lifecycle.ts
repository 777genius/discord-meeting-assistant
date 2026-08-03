import type { PostCallObserver } from "./observability.js";
import { safelyObserve } from "./observability.js";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 300_000;

export interface CloseClient {
  close(): Promise<void>;
  disconnect?(): Promise<void> | void;
}

export interface GracefulWorkerCloseClient extends CloseClient {
  cancelActivePostCallJobs(reason?: string): void;
  close(force?: boolean): Promise<void>;
  pause(doNotWaitActive?: boolean): Promise<void>;
  waitForActivePostCallJobs(): Promise<void>;
}

export interface DrainActiveAndCloseOptions {
  readonly observer?: PostCallObserver;
  readonly queueEvents?: CloseClient;
  readonly queues?: readonly CloseClient[];
  readonly shutdownTimeoutMs?: number;
  readonly worker: GracefulWorkerCloseClient;
}

class PostCallShutdownTimeoutError extends Error {
  public constructor(timeoutMs: number) {
    super(`Post-call shutdown did not complete within ${String(timeoutMs)}ms`);
    this.name = "PostCallShutdownTimeoutError";
  }
}

function shutdownTimeoutMilliseconds(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > MAX_SHUTDOWN_TIMEOUT_MS
  ) {
    throw new RangeError(
      `shutdownTimeoutMs must be an integer from 1 to ${String(MAX_SHUTDOWN_TIMEOUT_MS)}`,
    );
  }
  return timeoutMs;
}

async function awaitWithinShutdownDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new PostCallShutdownTimeoutError(timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function remainingShutdownDeadline(
  deadline: number,
  configuredTimeoutMs: number,
): number {
  const remaining = Math.ceil(deadline - performance.now());
  if (remaining < 1) {
    throw new PostCallShutdownTimeoutError(configuredTimeoutMs);
  }
  return remaining;
}

function forceDisconnect(
  resource: Pick<CloseClient, "disconnect">,
  observer: PostCallObserver | undefined,
): void {
  if (resource.disconnect === undefined) {
    return;
  }
  try {
    void Promise.resolve(resource.disconnect()).catch(() => {
      safelyObserve(observer, {
        component: "lifecycle",
        kind: "runtime-error",
      });
    });
  } catch {
    safelyObserve(observer, {
      component: "lifecycle",
      kind: "runtime-error",
    });
  }
}

async function forceCloseWorkerWithinDeadline(
  worker: GracefulWorkerCloseClient,
  deadline: number,
  timeoutMs: number,
  observer: PostCallObserver | undefined,
): Promise<void> {
  let close: Promise<void>;
  try {
    close = worker.close(true);
    // If the total deadline has already elapsed, this first force-close still
    // starts (BullMQ caches it), while the attached rejection handler keeps the
    // bounded caller from creating an unhandled late rejection.
    void close.catch(() => null);
    const remainingMs = remainingShutdownDeadline(deadline, timeoutMs);
    await awaitWithinShutdownDeadline(
      close,
      remainingMs,
    );
  } catch (error) {
    forceDisconnect(worker, observer);
    throw error;
  }
}

async function closeRemainingResourcesWithinDeadline(
  resources: readonly CloseClient[],
  deadline: number,
  timeoutMs: number,
  observer: PostCallObserver | undefined,
): Promise<readonly unknown[]> {
  if (resources.length === 0) {
    return [];
  }

  let remainingMs: number;
  try {
    remainingMs = remainingShutdownDeadline(deadline, timeoutMs);
  } catch (error) {
    for (const resource of resources) {
      forceDisconnect(resource, observer);
    }
    return [error];
  }

  const pending = resources.map((resource) => {
    const state = { settled: false };
    return {
      operation: Promise.resolve()
        .then(async () => resource.close())
        .finally(() => {
          state.settled = true;
        }),
      resource,
      state,
    };
  });

  try {
    const results = await awaitWithinShutdownDeadline(
      Promise.allSettled(pending.map(({ operation }) => operation)),
      remainingMs,
    );
    const failures: unknown[] = [];
    for (const result of results) {
      if (result.status === "rejected") {
        failures.push(result.reason);
      }
    }
    return failures;
  } catch (error) {
    for (const { resource, state } of pending) {
      if (!state.settled) {
        forceDisconnect(resource, observer);
      }
    }
    return [error];
  }
}

function recordFailure(
  failures: unknown[],
  error: unknown,
  observer: PostCallObserver | undefined,
): void {
  failures.push(error);
  safelyObserve(observer, {
    component: "lifecycle",
    kind: "runtime-error",
  });
}

export async function drainActivePostCallJobsAndClose(
  options: DrainActiveAndCloseOptions,
): Promise<void> {
  const failures: unknown[] = [];
  const timeoutMs = shutdownTimeoutMilliseconds(options.shutdownTimeoutMs);
  const deadline = performance.now() + timeoutMs;
  let workerCloseStarted = false;

  try {
    let pause: Promise<void>;
    try {
      // `pause(true)` is asynchronous. Close adapter admission in the same
      // turn, before awaiting it, so a prefetched job cannot enter user code.
      pause = options.worker.pause(true);
    } finally {
      options.worker.cancelActivePostCallJobs("shutdown");
    }
    await awaitWithinShutdownDeadline(
      pause,
      remainingShutdownDeadline(deadline, timeoutMs),
    );
    await awaitWithinShutdownDeadline(
      options.worker.waitForActivePostCallJobs(),
      remainingShutdownDeadline(deadline, timeoutMs),
    );
    // BullMQ 5.81.3 caches the first close promise. Once active work is
    // confirmed requeued, force-close directly instead of starting a
    // close(false) that cannot later be escalated.
    workerCloseStarted = true;
    await forceCloseWorkerWithinDeadline(
      options.worker,
      deadline,
      timeoutMs,
      options.observer,
    );
  } catch (error) {
    recordFailure(failures, error, options.observer);
    if (!workerCloseStarted) {
      workerCloseStarted = true;
      try {
        // This remains the first close call, so BullMQ can enforce force=true.
        // Do not extend the configured deadline when active work is unconfirmed.
        await forceCloseWorkerWithinDeadline(
          options.worker,
          deadline,
          timeoutMs,
          options.observer,
        );
      } catch (forceCloseError) {
        recordFailure(failures, forceCloseError, options.observer);
      }
    }
  }

  const remainingResources = [
    ...(options.queueEvents === undefined ? [] : [options.queueEvents]),
    ...(options.queues ?? []),
  ];
  const resourceFailures = await closeRemainingResourcesWithinDeadline(
    remainingResources,
    deadline,
    timeoutMs,
    options.observer,
  );
  for (const resourceFailure of resourceFailures) {
    recordFailure(failures, resourceFailure, options.observer);
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "One or more BullMQ resources failed to close gracefully",
    );
  }
  safelyObserve(options.observer, { component: "lifecycle", kind: "closed" });
}
