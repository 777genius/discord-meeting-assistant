import {
  InfinityContextLiveFinalizedMemoryAdapter,
} from "@discord-meeting/infinity-context-adapter";
import {
  LiveFinalizedMemoryWorker,
  type LiveFinalizedMemoryLifecyclePort,
  type LiveFinalizedMemoryQueryPort,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { Logger, LiveMemoryProjectionMetrics } from
  "@discord-meeting/observability-adapter";
import {
  PostgresLiveFinalizedMemoryLifecycle,
  PostgresLiveFinalizedMemoryQuery,
  PostgresLiveFinalizedMemoryStore,
  canonicalFinalReplyTurnHash,
} from "@discord-meeting/postgres-adapter";
import type { Pool } from "pg";

import type { PlatformConfig } from "../config.js";
import {
  createDiscordInfinityActorCustody,
  requireHistoricalRuntimeSecrets,
} from "./discord-infinity-actor-custody.js";

const reconciliationIntervalMs = 1_000;
const maximumOperationsPerPass = 128;

export interface PlatformLiveFinalizedMemoryRuntime
  extends LiveFinalizedMemoryLifecyclePort
{
  readonly query: LiveFinalizedMemoryQueryPort;
  close(): Promise<void>;
  start(): void;
  synchronizeMeeting(meetingId: string): Promise<void>;
}

export function createPlatformLiveFinalizedMemory(input: {
  readonly config: PlatformConfig;
  readonly logger: Logger;
  readonly metrics: LiveMemoryProjectionMetrics;
  readonly pool: Pool;
}): PlatformLiveFinalizedMemoryRuntime | undefined {
  if (
    input.config.meetingKnowledge?.localFinalReply !== true &&
    input.config.conversation === undefined
  ) {
    return undefined;
  }
  const lifecycle = new PostgresLiveFinalizedMemoryLifecycle(input.pool);
  const query = new PostgresLiveFinalizedMemoryQuery(input.pool);
  const infinity = input.config.infinityContext;
  const custody = infinity === undefined
    ? undefined
    : createDiscordInfinityActorCustody(
        input.config,
        requireHistoricalRuntimeSecrets(input.config).topologyKey,
      );
  const projection = infinity?.activation.indexingEnabled === true && custody !== undefined
    ? new InfinityContextLiveFinalizedMemoryAdapter({
        actorKeys: custody.actorKeys,
        baseUrl: infinity.baseUrl,
        ids: custody.historicalIds,
        operationTimeoutMs: infinity.operationTimeoutMs,
        requestTimeoutMs: infinity.requestTimeoutMs,
        schemaVersion: 1,
        token: requireHistoricalRuntimeSecrets(input.config).token,
      })
    : undefined;
  const worker = new LiveFinalizedMemoryWorker(
    new PostgresLiveFinalizedMemoryStore(input.pool, custody?.historicalIds),
    { hash: canonicalFinalReplyTurnHash },
    projection,
    undefined,
    {
      observe: ({ ingestToAppliedMs, outcome }) => {
        input.metrics.observeLiveMemoryProjection(outcome, ingestToAppliedMs / 1_000);
      },
    },
  );
  let active: Promise<void> | undefined;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;

  const runPass = async (meetingId?: string): Promise<void> => {
    for (let count = 0; count < maximumOperationsPerPass; count += 1) {
      const result = await worker.executeOnce(
        meetingId === undefined ? {} : { meetingId },
      );
      if (result.status === "idle" || result.status === "retry_wait") {
        return;
      }
      if (result.status === "dead_letter") {
        input.logger.warn("Live finalized memory projection dead-lettered", {
          mutationId: result.mutationId,
        });
        return;
      }
    }
  };
  const schedule = (): void => {
    if (closed || active !== undefined) {
      return;
    }
    active = runPass().catch((error: unknown) => {
      input.logger.warn("Live finalized memory reconciliation failed", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
    }).finally(() => {
      active = undefined;
    });
  };

  return {
    close: async () => {
      closed = true;
      if (timer !== undefined) {
        clearInterval(timer);
      }
      await active;
    },
    finishMeeting: (meetingId) => lifecycle.finishMeeting(meetingId),
    observeHuman: (identity) => lifecycle.observeHuman(identity),
    removeHuman: (identity) => lifecycle.removeHuman(identity),
    query,
    registerMeeting: (identity) => lifecycle.registerMeeting(identity),
    sealMeeting: (identity) => lifecycle.sealMeeting(identity),
    start: () => {
      if (closed || timer !== undefined) {
        return;
      }
      timer = setInterval(schedule, reconciliationIntervalMs);
      timer.unref();
      schedule();
    },
    synchronizeMeeting: (meetingId) => runPass(meetingId),
  };
}
