/** Durable work item whose processing receipt is independent of Redis. */
export interface PostCallWorkItem {
  readonly meetingId: string;
  readonly recoveryGeneration: number;
  readonly schemaVersion: 1;
}

/**
 * Delivery remains recoverable until `markPostCallProcessed` is called after a
 * durable terminal receipt from the worker. Queue submission is only an
 * observation and cannot remove an item from this outbox.
 */
export interface PostCallOutbox {
  listRecoverablePostCall(limit?: number): Promise<readonly PostCallWorkItem[]>;

  markPostCallEnqueued(meetingId: string): Promise<void>;

  markPostCallProcessed(meetingId: string): Promise<void>;
}

/** Provider-neutral terminal failure evidence for the post-call worker. */
export interface PostCallDeadLetterRecord {
  readonly attemptsMade: number;
  readonly failureCode: string;
  readonly meetingId: string | null;
  readonly retryable: boolean;
  readonly schemaVersion: 1;
  readonly sourceJobRef: string;
}

export type PostCallDeadLetterAppendResult = "recorded" | "reused";

export interface PostCallDeadLetterEvidence extends PostCallDeadLetterRecord {
  readonly recordedAt: string;
}

/** Independent of a Redis DLQ so a terminal failure remains health-readable. */
export interface PostCallDeadLetterLedger {
  recordPostCallDeadLetter(
    record: PostCallDeadLetterRecord,
  ): Promise<PostCallDeadLetterAppendResult>;

  listPostCallDeadLetters(limit?: number): Promise<readonly PostCallDeadLetterEvidence[]>;
}

/**
 * Atomically records an exhausted delivery generation. Non-retryable failures
 * become terminal; retryable failures schedule the next recovery generation.
 */
export interface PostCallTerminalFailureSettlement {
  settlePostCallFailure(
    record: PostCallDeadLetterRecord,
  ): Promise<PostCallDeadLetterAppendResult>;
}
