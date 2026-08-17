import {
  BullMqPostCallEnqueuer,
  NonRetryablePostCallError,
  RetryablePostCallError,
  createRedisPolicyReadiness,
  createPostCallQueue,
  createPostCallQueueEvents,
  createPostCallWorker,
  type PostCallDeadLetterRecorder,
  type PostCallObserver,
  type PostCallWorker,
  type RedisPolicyReadiness,
} from "@discord-meeting/bullmq-adapter";
import {
  type PostCallOutbox,
  type PostCallTerminalFailureSettlement,
  type ProcessMeetingSummary,
} from "@discord-meeting/meeting-core/post-call-workflow";
import type { Logger, PrometheusMetrics } from "@discord-meeting/observability-adapter";
import type { ConnectionOptions } from "bullmq";

import { PostCallOutboxDispatcher } from "../application/post-call-outbox-dispatcher.js";
import type { FinalTranscriptionExecutionBinding } from "./transcription.js";

const postCallQueuePrefix = "discord-meeting-v1";

interface TranscriptionExecutionBindingStore {
  backfillRecoverableUnboundTranscriptionExecutionBindings(binding: string): Promise<number>;
  getTranscriptionExecutionBinding(meetingId: string): Promise<string | undefined>;
  pinTranscriptionExecutionBinding(meetingId: string, binding: string): Promise<string>;
}

interface CloseablePostCallQueue {
  close(): Promise<void>;
}

export interface PlatformPostCallComposition {
  readonly outboxDispatcher: PostCallOutboxDispatcher;
  readonly queue: ReturnType<typeof createPostCallQueue>;
  readonly queueEvents: ReturnType<typeof createPostCallQueueEvents>;
  readonly redisPolicyReadiness: RedisPolicyReadiness;
  readonly worker: PostCallWorker;
}

export async function createPlatformPostCallComposition(input: {
  readonly connection: ConnectionOptions;
  readonly logger: Logger;
  readonly metrics: PrometheusMetrics;
  readonly meetings: PostCallOutbox & PostCallTerminalFailureSettlement;
  readonly observer: PostCallObserver;
  readonly processMeeting: ProcessMeetingSummary;
  readonly legacyTranscriptionExecutionBinding: FinalTranscriptionExecutionBinding;
  readonly selectedTranscriptionExecutionBinding: FinalTranscriptionExecutionBinding;
  readonly supportedTranscriptionExecutionBindings: ReadonlySet<FinalTranscriptionExecutionBinding>;
  readonly transcriptionExecutionBindings: TranscriptionExecutionBindingStore;
}): Promise<PlatformPostCallComposition> {
  let queue: ReturnType<typeof createPostCallQueue> | undefined;
  let queueEvents: ReturnType<typeof createPostCallQueueEvents> | undefined;
  try {
    queue = createPostCallQueue({
      connection: input.connection,
      observer: input.observer,
      prefix: postCallQueuePrefix,
    });
    queueEvents = createPostCallQueueEvents({
      connection: input.connection,
      observer: input.observer,
      prefix: postCallQueuePrefix,
    });
    const deadLetterLedger: PostCallDeadLetterRecorder = {
      record: async (record) => {
        await input.meetings.settlePostCallFailure(record);
      },
    };
    const enqueuer = new BullMqPostCallEnqueuer(queue, {}, input.observer);
    const outboxDispatcher = new PostCallOutboxDispatcher(
      input.meetings,
      enqueuer,
      deadLetterLedger,
      input.logger,
      {
        store: input.transcriptionExecutionBindings,
        values: {
          legacyRecovery: input.legacyTranscriptionExecutionBinding,
          selected: input.selectedTranscriptionExecutionBinding,
          supported: input.supportedTranscriptionExecutionBindings,
        },
      },
    );
    const worker = createPostCallWorker({
      admission: createPostCallBindingAdmission(
        input.transcriptionExecutionBindings,
        input.supportedTranscriptionExecutionBindings,
      ),
      autorun: false,
      connection: input.connection,
      deadLetterRecorder: deadLetterLedger,
      handler: createPostCallHandler(
        input.processMeeting,
        input.meetings,
        input.logger,
        input.metrics,
      ),
      observer: input.observer,
      prefix: postCallQueuePrefix,
    });
    return {
      outboxDispatcher,
      queue,
      queueEvents,
      redisPolicyReadiness: createRedisPolicyReadiness(queue),
      worker,
    };
  } catch (error) {
    return closePartiallyCreatedPostCallQueues(
      error,
      queueEvents,
      queue,
    );
  }
}

export function createPostCallBindingAdmission(
  bindings: Pick<TranscriptionExecutionBindingStore, "getTranscriptionExecutionBinding">,
  supported: ReadonlySet<string>,
) {
  return async ({ meetingId }: { readonly meetingId: string }) => {
    const binding = await bindings.getTranscriptionExecutionBinding(meetingId);
    return binding !== undefined && supported.has(binding)
      ? "accepted" as const
      : "hold" as const;
  };
}

export function createPostCallHandler(
  processMeeting: ProcessMeetingSummary,
  outbox: Pick<PostCallOutbox, "markPostCallProcessed">,
  logger: Logger,
  metrics: PrometheusMetrics,
) {
  return async (
    { meetingId }: { readonly meetingId: string },
    { signal }: { readonly signal?: AbortSignal },
  ): Promise<void> => {
    const result = await processMeeting.execute(
      meetingId,
      signal === undefined ? {} : { signal },
    );
    if (result.status === "published") {
      try {
        await outbox.markPostCallProcessed(meetingId);
      } catch {
        throw new RetryablePostCallError("POST_CALL_PROCESSING_RECEIPT_FAILED");
      }
      metrics.recordDiscordPublication(result.reused ? "duplicate" : "succeeded");
      logger.info("Meeting summary published", {
        meetingId,
        reused: result.reused,
      });
      return;
    }
    if (result.status === "not-found") {
      throw new NonRetryablePostCallError("MEETING_NOT_FOUND");
    }
    throw result.failure.retryable
      ? new RetryablePostCallError(result.failure.code)
      : new NonRetryablePostCallError(result.failure.code);
  };
}

export async function closePartiallyCreatedPostCallQueues(
  startupFailure: unknown,
  queueEvents: CloseablePostCallQueue | undefined,
  queue: CloseablePostCallQueue | undefined,
): Promise<never> {
  const resources = [
    ["post-call queue events", queueEvents],
    ["post-call queue", queue],
  ] as const;
  const failures: unknown[] = [];
  for (const [name, resource] of resources) {
    if (resource === undefined) {
      continue;
    }
    try {
      await resource.close();
    } catch (error) {
      failures.push(new Error(`Could not close ${name}`, { cause: error }));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      [startupFailure, ...failures],
      "Post-call composition failed and cleanup was incomplete",
    );
  }
  throw startupFailure;
}
