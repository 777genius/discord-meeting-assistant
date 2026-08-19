import {
  LiveFinalizedMemoryWorker,
  type LiveFinalizedMemoryLifecyclePort,
  type LiveFinalizedMemoryQueryPort,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { Logger } from "@discord-meeting/observability-adapter";
import {
  PostgresLiveFinalizedMemoryLifecycle,
  PostgresLiveFinalizedMemoryQuery,
  PostgresLiveFinalizedMemoryStore,
  canonicalFinalReplyTurnHash,
} from "@discord-meeting/postgres-adapter";
import type { Pool } from "pg";

import type { PlatformConfig } from "../config.js";

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
  const worker = new LiveFinalizedMemoryWorker(
    new PostgresLiveFinalizedMemoryStore(input.pool),
    { hash: canonicalFinalReplyTurnHash },
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
