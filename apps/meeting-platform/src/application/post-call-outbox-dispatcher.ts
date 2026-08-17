import {
  type PostCallDeadLetterRecord,
  type PostCallOutbox,
  type PostCallWorkItem,
} from "@discord-meeting/meeting-core/post-call-workflow";

type PostCallOutboxPort = Pick<
  PostCallOutbox,
  "listRecoverablePostCall" | "markPostCallEnqueued" | "markPostCallProcessed"
>;

type PostCallEnqueueOutcome =
  | { readonly status: "available" }
  | { readonly status: "completed" }
  | {
    readonly deadLetter: PostCallDeadLetterRecord;
    readonly status: "failed";
  };

interface PostCallEnqueuerPort {
  enqueue(payload: PostCallWorkItem): Promise<PostCallEnqueueOutcome>;
}

interface PostCallTerminalRecorderPort {
  record(record: PostCallDeadLetterRecord): Promise<void>;
}

interface OutboxLogger {
  warn(message: string, context?: Readonly<Record<string, unknown>>): void;
}

interface TranscriptionExecutionBindingStore {
  backfillRecoverableUnboundTranscriptionExecutionBindings(binding: string): Promise<number>;
  pinTranscriptionExecutionBinding(meetingId: string, binding: string): Promise<string>;
}

interface TranscriptionExecutionBindings {
  readonly legacyRecovery: string;
  readonly selected: string;
  readonly supported: ReadonlySet<string>;
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
    private readonly terminalRecorder: PostCallTerminalRecorderPort,
    private readonly logger: OutboxLogger,
    private readonly binding?: {
      readonly store: TranscriptionExecutionBindingStore;
      readonly values: TranscriptionExecutionBindings;
    },
  ) {}

  public async prepareLegacyBindings(): Promise<number> {
    if (this.binding === undefined) {
      return 0;
    }
    return this.binding.store.backfillRecoverableUnboundTranscriptionExecutionBindings(
      this.binding.values.legacyRecovery,
    );
  }

  public dispatchPending(limit = 100): Promise<PostCallDispatchResult> {
    this.#active ??= this.#dispatch(limit).finally(() => {
      this.#active = undefined;
    });
    return this.#active;
  }

  public async whenIdle(): Promise<void> {
    await this.#active;
  }

  async #dispatch(limit: number): Promise<PostCallDispatchResult> {
    let pending: readonly PostCallWorkItem[];
    try {
      pending = await this.outbox.listRecoverablePostCall(limit);
    } catch (error) {
      this.logger.warn("Post-call outbox reconciliation failed before dispatch", {
        errorName: error instanceof Error ? error.name : "UNKNOWN_THROWABLE",
      });
      return Object.freeze({ dispatched: 0, failed: 1 });
    }
    let dispatched = 0;
    let failed = 0;
    for (const item of pending) {
      try {
        if (this.binding !== undefined) {
          const pinned = await this.binding.store.pinTranscriptionExecutionBinding(
            item.meetingId,
            this.binding.values.selected,
          );
          if (!this.binding.values.supported.has(pinned)) {
            throw new Error("transcription execution binding is unsupported by this runtime");
          }
        }
        const receipt = await this.enqueuer.enqueue(item);
        await this.applyReceipt(item, receipt);
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

  async applyReceipt(
    item: PostCallWorkItem,
    receipt: PostCallEnqueueOutcome,
  ): Promise<void> {
    switch (receipt.status) {
      case "available":
        await this.outbox.markPostCallEnqueued(item.meetingId);
        return;
      case "completed":
        await this.outbox.markPostCallProcessed(item.meetingId);
        return;
      case "failed":
        await this.terminalRecorder.record(receipt.deadLetter);
    }
  }
}
