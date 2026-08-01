export type PostCallAdapterComponent =
  | "dead-letter-queue"
  | "lifecycle"
  | "producer-queue"
  | "queue-events"
  | "worker";

export type PostCallObservabilityEvent =
  | {
      readonly component: PostCallAdapterComponent;
      readonly kind: "runtime-error";
    }
  | {
      readonly component: "producer-queue";
      readonly jobRef: string;
      readonly kind: "job-enqueued";
    }
  | {
      readonly component: "worker" | "queue-events";
      readonly jobRef: string;
      readonly kind: "job-active" | "job-completed" | "job-stalled";
    }
  | {
      readonly attemptsMade?: number;
      readonly component: "worker" | "queue-events";
      readonly failureCode?: string;
      readonly jobRef: string;
      readonly kind: "job-failed";
      readonly retryable?: boolean;
      readonly terminal?: boolean;
    }
  | {
      readonly component: "worker" | "queue-events";
      readonly kind: "drained";
    }
  | {
      readonly component: "worker";
      readonly failureCode: string;
      readonly jobRef: string;
      readonly kind: "dead-letter-recorded";
    }
  | {
      readonly component: "lifecycle";
      readonly kind: "closed";
    };

export type PostCallObserver = (
  event: PostCallObservabilityEvent,
) => Promise<void> | void;

export function safelyObserve(
  observer: PostCallObserver | undefined,
  event: PostCallObservabilityEvent,
): void {
  if (observer === undefined) {
    return;
  }

  try {
    void Promise.resolve(observer(Object.freeze(event))).catch(() => null);
  } catch {
    // Observability must never change queue behavior.
  }
}
