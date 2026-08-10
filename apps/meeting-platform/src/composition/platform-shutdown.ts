import {
  drainActivePostCallJobsAndClose,
  type PostCallWorker,
} from "@discord-meeting/bullmq-adapter";
import {
  flushLoggers,
  type Logger,
} from "@discord-meeting/observability-adapter";
import type { CraigPlaybackGateway, CraigPlaybackWebSocketServer } from "@discord-meeting/craig-playback-adapter";
import type { DiscordGuildSetupCommandHandler } from "@discord-meeting/discord-adapter";
import type { GrpcPipecatConversationRuntime } from "@discord-meeting/pipecat-runtime-adapter";
import type { Client } from "discord.js";
import type { Pool } from "pg";
import type { S3Client } from "@aws-sdk/client-s3";

import type { GrpcSubscriptionRuntimeTransport } from "../adapters/outbound/subscription-runtime-grpc-transport.js";
import type { PostCallOutboxDispatcher } from "../application/post-call-outbox-dispatcher.js";
import type { PlatformHttpHost } from "../http/platform-http-host.js";
import type { PlatformLiveMeetingRuntime } from "../live-meeting-runtime.js";
import {
  awaitWithinPlatformShutdownTimeout,
  resolvePlatformShutdownTimeoutMilliseconds,
} from "./shutdown-deadline.js";

interface CloseableQueue {
  close(): Promise<void>;
}

interface CloseableRecordingIngress {
  close(): Promise<void>;
}

export interface PostCallShutdownResources {
  readonly outboxDispatcher: Pick<PostCallOutboxDispatcher, "whenIdle">;
  readonly queue: CloseableQueue;
  readonly queueEvents: CloseableQueue;
  readonly shutdownTimeoutMilliseconds?: number;
  readonly worker: PostCallWorker;
}

export interface MeetingPlatformShutdownResources extends PostCallShutdownResources {
  readonly conversationRuntime?: GrpcPipecatConversationRuntime;
  readonly craigPlayback?: {
    readonly gateway: CraigPlaybackGateway;
    readonly webSocket: CraigPlaybackWebSocketServer;
  };
  readonly discord: Client;
  readonly guildSetupHandler?: DiscordGuildSetupCommandHandler;
  readonly logger: Logger;
  readonly live?: PlatformLiveMeetingRuntime;
  readonly pool: Pool;
  readonly recordings: CloseableRecordingIngress;
  readonly runtimeTransport: GrpcSubscriptionRuntimeTransport;
  readonly s3: S3Client;
  readonly server: PlatformHttpHost;
}

export async function closePostCallResources(
  input: PostCallShutdownResources,
): Promise<void> {
  const timeoutMilliseconds = resolvePlatformShutdownTimeoutMilliseconds(
    input.shutdownTimeoutMilliseconds,
  );
  // This call closes worker admission before its first await. Start it before
  // waiting for the outbox so no prefetched job enters processing during exit.
  const workerAndQueues = drainActivePostCallJobsAndClose({
    queueEvents: input.queueEvents,
    queues: [input.queue],
    shutdownTimeoutMs: timeoutMilliseconds,
    worker: input.worker,
  });
  const outboxDrain = startOperation(() => input.outboxDispatcher.whenIdle());
  const failures = await collectFailures([
    awaitBounded("post-call queues", workerAndQueues, timeoutMilliseconds),
    awaitBounded("post-call outbox", outboxDrain, timeoutMilliseconds),
  ]);
  throwIfShutdownIncomplete(failures, "Post-call shutdown was incomplete");
}

export async function closeMeetingPlatformResources(
  input: MeetingPlatformShutdownResources,
): Promise<void> {
  const timeoutMilliseconds = resolvePlatformShutdownTimeoutMilliseconds(
    input.shutdownTimeoutMilliseconds,
  );
  const deadlineAtMilliseconds = Date.now() + timeoutMilliseconds;
  const failures: unknown[] = [];
  const postCallShutdown = observeRejection(closePostCallResources({
    outboxDispatcher: input.outboxDispatcher,
    queue: input.queue,
    queueEvents: input.queueEvents,
    shutdownTimeoutMilliseconds: timeoutMilliseconds,
    worker: input.worker,
  }));
  collectSynchronousCloseFailure(
    failures,
    () => input.craigPlayback?.gateway.close(),
  );
  collectSynchronousCloseFailure(failures, () => input.guildSetupHandler?.close());
  const httpShutdown = startOperation(() => input.server.close());
  // Begin rejecting new ingress as soon as HTTP admission starts closing. The
  // recording runtime drains already-admitted work before removing its marker.
  // Starting this now lets the fsync complete even if post-call shutdown later
  // consumes the shared deadline.
  const recordingSpoolShutdown = observeRejection(
    startOperation(() => input.recordings.close()),
  );
  failures.push(...await collectFailures([
    awaitBounded(
      "platform HTTP host",
      httpShutdown,
      remainingShutdownMilliseconds(deadlineAtMilliseconds),
    ),
  ]));
  // Active post-call processing may still be waiting on the live finalization
  // fence. Drain that consumer before closing the live runtime it depends on.
  failures.push(...await collectFailures([
    awaitBounded(
      "post-call resources",
      postCallShutdown,
      remainingShutdownMilliseconds(deadlineAtMilliseconds),
    ),
  ]));
  failures.push(...await collectFailures([
    awaitBounded(
      "Craig playback WebSocket",
      startOperation(() => input.craigPlayback?.webSocket.close()),
      remainingShutdownMilliseconds(deadlineAtMilliseconds),
    ),
    awaitBounded(
      "derived live runtime",
      startOperation(() => input.live?.close()),
      remainingShutdownMilliseconds(deadlineAtMilliseconds),
    ),
    awaitBounded(
      "recording ingress spool",
      recordingSpoolShutdown,
      remainingShutdownMilliseconds(deadlineAtMilliseconds),
    ),
  ]));
  failures.push(...await collectFailures([
    awaitBounded(
      "Discord client",
      startOperation(() => input.discord.destroy()),
      remainingShutdownMilliseconds(deadlineAtMilliseconds),
    ),
    awaitBounded(
      "Pipecat conversation runtime",
      startOperation(() => input.conversationRuntime?.close()),
      remainingShutdownMilliseconds(deadlineAtMilliseconds),
    ),
    awaitBounded(
      "subscription runtime transport",
      startOperation(() => {
        input.runtimeTransport.close();
      }),
      remainingShutdownMilliseconds(deadlineAtMilliseconds),
    ),
    awaitBounded(
      "S3 client",
      startOperation(() => {
        input.s3.destroy();
      }),
      remainingShutdownMilliseconds(deadlineAtMilliseconds),
    ),
    awaitBounded(
      "PostgreSQL pool",
      startOperation(() => input.pool.end()),
      remainingShutdownMilliseconds(deadlineAtMilliseconds),
    ),
    awaitBounded(
      "logger flush",
      flushLoggers([input.logger]),
      remainingShutdownMilliseconds(deadlineAtMilliseconds),
    ),
  ]));
  throwIfShutdownIncomplete(failures, "Meeting platform shutdown was incomplete");
}

function remainingShutdownMilliseconds(deadlineAtMilliseconds: number): number {
  return Math.max(0, deadlineAtMilliseconds - Date.now());
}

async function awaitBounded(
  resource: string,
  operation: Promise<unknown>,
  timeoutMilliseconds: number,
): Promise<void> {
  try {
    await awaitWithinPlatformShutdownTimeout(operation, timeoutMilliseconds);
  } catch (error) {
    throw new Error(`Could not close ${resource}`, { cause: error });
  }
}

async function collectFailures(
  operations: readonly Promise<void>[],
): Promise<unknown[]> {
  const results = await Promise.allSettled(operations);
  return results.flatMap((result): unknown[] =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
}

function collectSynchronousCloseFailure(
  failures: unknown[],
  close: () => void,
): void {
  try {
    close();
  } catch (error) {
    failures.push(error);
  }
}

function startOperation<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
}

function observeRejection<T>(operation: Promise<T>): Promise<T> {
  void operation.catch(() => {
    // The ordered shutdown phase below still aggregates the original promise.
  });
  return operation;
}

function throwIfShutdownIncomplete(
  failures: readonly unknown[],
  message: string,
): void {
  if (failures.length > 0) {
    throw new AggregateError(failures, message);
  }
}
