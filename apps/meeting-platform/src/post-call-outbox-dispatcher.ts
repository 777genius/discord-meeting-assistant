interface PendingPostCall {
  readonly meetingId: string;
  readonly schemaVersion: 1;
}

interface PostCallOutboxPort {
  listPendingPostCall(limit?: number): Promise<readonly PendingPostCall[]>;
  markPostCallDispatched(meetingId: string): Promise<void>;
}

interface PostCallEnqueuerPort {
  enqueue(payload: PendingPostCall): Promise<unknown>;
}

interface OutboxLogger {
  warn(message: string, context?: Readonly<Record<string, unknown>>): void;
}

export interface PostCallDispatchResult {
  readonly dispatched: number;
  readonly failed: number;
}

export class PostCallOutboxDispatcher {
  #active: Promise<PostCallDispatchResult> | undefined;

  public constructor(
    private readonly outbox: PostCallOutboxPort,
    private readonly enqueuer: PostCallEnqueuerPort,
    private readonly logger: OutboxLogger,
  ) {}

  public dispatchPending(limit = 100): Promise<PostCallDispatchResult> {
    this.#active ??= this.#dispatch(limit).finally(() => {
      this.#active = undefined;
    });
    return this.#active;
  }

  async #dispatch(limit: number): Promise<PostCallDispatchResult> {
    const pending = await this.outbox.listPendingPostCall(limit);
    let dispatched = 0;
    let failed = 0;
    for (const item of pending) {
      try {
        await this.enqueuer.enqueue(item);
        await this.outbox.markPostCallDispatched(item.meetingId);
        dispatched += 1;
      } catch (error) {
        failed += 1;
        this.logger.warn("Post-call outbox dispatch failed; durable item retained", {
          errorName: error instanceof Error ? error.name : "UNKNOWN_THROWABLE",
          meetingId: item.meetingId,
        });
      }
    }
    return Object.freeze({ dispatched, failed });
  }
}
