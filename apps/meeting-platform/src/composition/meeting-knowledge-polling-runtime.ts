import type { DiscordLocalFinalReplyHandler } from "@discord-meeting/discord-adapter";
import type { MaintainFinalReplies, ProcessFinalReplyJob } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import type { DurableAnswerPublication } from "@discord-meeting/meeting-core/publishing";

const processIntervalMilliseconds = 500;
const reconciliationIntervalMilliseconds = 30_000;
const maximumMaintenanceJobsPerPass = 100;
const shutdownDrainTimeoutMilliseconds = 5_000;

export interface MeetingKnowledgeLocalFinalReplyRuntime {
  close(): Promise<void>;
  processPending(): Promise<void>;
  reconcilePending(): Promise<void>;
  settleIngress(): Promise<void>;
  start(): void;
}

export class MeetingKnowledgeDrainTimeoutError extends Error {
  public constructor(timeoutMilliseconds: number) {
    super(`Meeting Knowledge final reply drain exceeded ${timeoutMilliseconds}ms`);
    this.name = "MeetingKnowledgeDrainTimeoutError";
  }
}

export function createMeetingKnowledgePollingRuntime(input: {
  readonly handler?: Pick<DiscordLocalFinalReplyHandler, "close" | "settle" | "start"> &
    Partial<Pick<DiscordLocalFinalReplyHandler, "reconcilePending">>;
  readonly maintenance: MaintainFinalReplies;
  readonly processor?: Pick<ProcessFinalReplyJob, "executeOnce">;
  readonly publication: Pick<DurableAnswerPublication, "reconcileRetractions" | "reconcileUnknown">;
  readonly reportDuplicateContainment?: (count: number) => void;
  readonly reportError: (error: unknown) => void;
}): MeetingKnowledgeLocalFinalReplyRuntime {
  let processing: Promise<unknown> | undefined;
  let reconciling: Promise<unknown> | undefined;
  let processTimer: NodeJS.Timeout | undefined;
  let reconcileTimer: NodeJS.Timeout | undefined;
  const processOnce = (): void => {
    processing ??= input.maintenance.execute(maximumMaintenanceJobsPerPass)
      .then(async () => await input.processor?.executeOnce())
      .catch(input.reportError)
      .finally(() => { processing = undefined; });
  };
  const reconcile = (): void => {
    reconciling ??= (input.handler?.reconcilePending?.() ?? Promise.resolve())
      .then(async () => await input.publication.reconcileUnknown(100))
      .then((result) => {
        if (result.containedDuplicates > 0) {
          input.reportDuplicateContainment?.(result.containedDuplicates);
        }
        return result;
      })
      .then(async () => await input.publication.reconcileRetractions(100))
      .catch(input.reportError)
      .finally(() => { reconciling = undefined; });
  };
  const processPending = async (): Promise<void> => {
    await processing;
    processOnce();
    await processing;
  };
  const reconcilePending = async (): Promise<void> => {
    await reconciling;
    reconcile();
    await reconciling;
  };
  return {
    close: async () => {
      input.handler?.close();
      clearInterval(processTimer);
      clearInterval(reconcileTimer);
      await awaitBoundedFinalReplyDrain([input.handler?.settle(), processing, reconciling]);
    },
    processPending,
    reconcilePending,
    settleIngress: () => input.handler?.settle() ?? Promise.resolve(),
    start: () => {
      if (processTimer !== undefined) { return; }
      input.handler?.start();
      processTimer = setInterval(processOnce, processIntervalMilliseconds);
      reconcileTimer = setInterval(reconcile, reconciliationIntervalMilliseconds);
      processTimer.unref();
      reconcileTimer.unref();
      processOnce();
      reconcile();
    },
  };
}

async function awaitBoundedFinalReplyDrain(
  operations: readonly (Promise<unknown> | undefined)[],
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const pending = operations.filter(
    (operation): operation is Promise<unknown> => operation !== undefined);
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new MeetingKnowledgeDrainTimeoutError(shutdownDrainTimeoutMilliseconds));
    }, shutdownDrainTimeoutMilliseconds);
    timer.unref();
  });
  try {
    const results = await Promise.race([Promise.allSettled(pending), timeout]);
    const failures = results.flatMap((result): unknown[] =>
      result.status === "rejected" ? [result.reason as unknown] : []);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Meeting Knowledge drain failed");
    }
  } finally {
    if (timer !== undefined) { clearTimeout(timer); }
  }
}
