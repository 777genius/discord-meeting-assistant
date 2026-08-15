const timeoutError = (message: string): DOMException =>
  new DOMException(message, "TimeoutError");

interface LinkedDeadline {
  readonly cleanup: () => void;
  readonly signal: AbortSignal;
}

function linkedDeadline(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  message: string,
): LinkedDeadline {
  const controller = new AbortController();
  const abortFromParent = (): void => {
    controller.abort(parent?.reason);
  };
  if (parent?.aborted === true) {
    abortFromParent();
  } else {
    parent?.addEventListener("abort", abortFromParent, { once: true });
  }
  const timer = globalThis.setTimeout(() => {
    controller.abort(timeoutError(message));
  }, timeoutMs);
  let cleaned = false;
  return {
    cleanup: () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      globalThis.clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
    signal: controller.signal,
  };
}

/**
 * One bounded, resumable provider attempt containing independently bounded SDK
 * requests. Every timer and parent listener is released at the narrowest scope.
 */
export class InfinityOperationDeadline {
  readonly #overall: LinkedDeadline;

  public constructor(
    overallTimeoutMs: number,
    callerSignal?: AbortSignal,
  ) {
    this.#overall = linkedDeadline(
      callerSignal,
      overallTimeoutMs,
      "Infinity operation deadline exceeded",
    );
  }

  public async request<T>(
    requestTimeoutMs: number,
    execute: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.#overall.signal.throwIfAborted();
    const request = linkedDeadline(
      this.#overall.signal,
      requestTimeoutMs,
      "Infinity SDK request deadline exceeded",
    );
    try {
      return await execute(request.signal);
    } finally {
      request.cleanup();
    }
  }

  public close(): void {
    this.#overall.cleanup();
  }

  public throwIfAborted(): void {
    this.#overall.signal.throwIfAborted();
  }
}
