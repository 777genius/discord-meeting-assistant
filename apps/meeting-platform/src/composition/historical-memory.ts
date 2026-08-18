import {
  HmacHistoricalOpaqueIds,
  InfinityContextHistoricalMemoryAdapter,
  assertInfinityContextActivation,
  assertInfinityContextSearchActivation,
} from "@discord-meeting/infinity-context-adapter";
import {
  DEFAULT_HISTORICAL_SYNC_POLICY,
  DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE,
  DeterministicCoverageReducer,
  ExhaustiveCoverage,
  HistoricalFocusedRetrieval,
  HistoricalSyncWorker,
  historicalSyncLeaseDurationMs,
  RequestHistoricalMeetingDeletion,
  type HistoricalAuthorizationPort,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  PostgresHistoricalEvidenceAuthority,
  PostgresExhaustiveCoverageStore,
  PostgresHistoricalMemoryStore,
} from "@discord-meeting/postgres-adapter";
import type { Logger } from "@discord-meeting/observability-adapter";
import {
  SubscriptionRuntimeCoverageExtractorAdapter,
  subscriptionRuntimeCliEngine,
  type SubscriptionRuntimeTransportPort,
} from "@discord-meeting/subscription-runtime-adapter";
import type { Pool } from "pg";

import type { PlatformConfig } from "../config.js";

const reconciliationIntervalMs = 5_000;
const maximumOperationsPerPass = 25;
const shutdownDrainTimeoutMs = 5_000;

export { historicalSyncLeaseDurationMs } from
  "@discord-meeting/meeting-core/meeting-knowledge";

async function awaitBoundedPass(pass: Promise<void> | undefined): Promise<void> {
  if (pass === undefined) {
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, shutdownDrainTimeoutMs);
    timer.unref();
  });
  await Promise.race([pass, timeout]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
}

export function createHistoricalReconciliationLifecycle(input: {
  readonly executePass: (signal: AbortSignal) => Promise<void>;
  readonly logger: Logger;
}): Pick<PlatformHistoricalMemoryRuntime, "close" | "start"> {
  let active: Promise<void> | undefined;
  let activeController: AbortController | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const beginPass = (): Promise<void> => {
    if (closed || active !== undefined) {
      return active ?? Promise.resolve();
    }
    const controller = new AbortController();
    activeController = controller;
    const pass = Promise.resolve()
      .then(() => input.executePass(controller.signal))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          input.logger.warn("Historical memory reconciliation failed", {
            errorType: error instanceof Error ? error.name : "unknown",
          });
        }
      })
      .finally(() => {
        if (active === pass) {
          active = undefined;
          activeController = undefined;
        }
      });
    active = pass;
    return pass;
  };
  const schedule = (): void => {
    void beginPass();
  };
  return {
    close: async () => {
      closed = true;
      if (timer !== undefined) {
        clearInterval(timer);
      }
      activeController?.abort(new DOMException(
        "Historical memory runtime is closing",
        "AbortError",
      ));
      await awaitBoundedPass(active);
    },
    start: async () => {
      if (closed || timer !== undefined) {
        return;
      }
      timer = setInterval(schedule, reconciliationIntervalMs);
      timer.unref();
      schedule();
    },
  };
}

function semanticSearchQualified(
  activation: NonNullable<PlatformConfig["infinityContext"]>["activation"],
  currentReleaseRevision: string | undefined,
  logger: Logger,
): boolean {
  try {
    assertInfinityContextSearchActivation(activation, currentReleaseRevision);
    return true;
  } catch (error) {
    logger.warn(
      "Infinity semantic search qualification unavailable; deletion drain remains active",
      { errorType: error instanceof Error ? error.name : "unknown" },
    );
    return false;
  }
}

export interface PlatformHistoricalMemoryRuntime {
  assertReady(): Promise<void>;
  close(): Promise<void>;
  createExhaustiveCoverage(
    authorization: HistoricalAuthorizationPort,
  ): ExhaustiveCoverage;
  createFocusedRetrieval(
    authorization: HistoricalAuthorizationPort,
  ): HistoricalFocusedRetrieval;
  searchEnabled(): boolean;
  servingAuthorized(): boolean;
  requestMeetingDeletion(meetingId: string): Promise<void>;
  start(): Promise<void>;
}

export function createPlatformHistoricalMemory(input: {
  readonly config: PlatformConfig;
  readonly logger: Logger;
  readonly pool: Pool;
  readonly runtimeTransport: SubscriptionRuntimeTransportPort;
}): PlatformHistoricalMemoryRuntime | undefined {
  const config = input.config.infinityContext;
  if (config === undefined) {
    return undefined;
  }
  if (config.activation.environment !== input.config.nodeEnvironment) {
    throw new Error("Infinity activation environment does not match Meeting Platform");
  }
  const token = input.config.secrets.infinityContextToken;
  const topologyKey = input.config.secrets.infinityContextTopologyKey;
  if (token === undefined || topologyKey === undefined) {
    throw new Error("Infinity runtime secrets are missing after configuration validation");
  }
  const memory = new InfinityContextHistoricalMemoryAdapter({
    baseUrl: config.baseUrl,
    operationTimeoutMs: config.operationTimeoutMs,
    requestTimeoutMs: config.requestTimeoutMs,
    schemaVersion: 1,
    token: () => token,
  });
  const store = new PostgresHistoricalMemoryStore(input.pool);
  const checkpoints = new PostgresExhaustiveCoverageStore(input.pool);
  const worker = new HistoricalSyncWorker({
    authority: new PostgresHistoricalEvidenceAuthority(input.pool),
    ids: new HmacHistoricalOpaqueIds(topologyKey),
    memory,
    store,
  }, {
    ...DEFAULT_HISTORICAL_SYNC_POLICY,
    leaseDurationMs: historicalSyncLeaseDurationMs(config.operationTimeoutMs),
  });
  let transportQualified = false;
  let searchQualified = false;
  const deletion = new RequestHistoricalMeetingDeletion(store);
  const twoHourProfile = Object.freeze({
    ...DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE,
    enabled:
      input.config.meetingKnowledge?.twoHourHistoricalRetrieval === true,
  });

  const refreshQualification = async (signal?: AbortSignal): Promise<void> => {
    transportQualified = false;
    searchQualified = false;
    if (!config.activation.indexingEnabled && !config.activation.searchEnabled) {
      return;
    }
    const capabilities = await memory.qualifyCapabilities(
      signal === undefined ? {} : { signal },
    );
    assertInfinityContextActivation(config.activation, capabilities);
    transportQualified = true;
    searchQualified = semanticSearchQualified(
      config.activation,
      input.config.sourceRevision,
      input.logger,
    );
  };

  const refreshQualificationForReconciliation = async (
    signal?: AbortSignal,
  ): Promise<void> => {
    try {
      await refreshQualification(signal);
    } catch (error) {
      signal?.throwIfAborted();
      transportQualified = false;
      searchQualified = false;
      input.logger.warn("Historical memory qualification unavailable; external indexing is disabled", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
    }
  };

  const runPass = async (signal?: AbortSignal): Promise<void> => {
    for (let count = 0; count < maximumOperationsPerPass; count += 1) {
      signal?.throwIfAborted();
      const result = await worker.executeOnce({
        indexingEnabled: config.activation.indexingEnabled && transportQualified,
        ...(signal === undefined ? {} : { signal }),
      });
      if (result.status === "idle") {
        break;
      }
      input.logger.info("Historical memory reconciliation settled", {
        operation: result.operation,
        state: result.status,
      });
    }
    signal?.throwIfAborted();
    await checkpoints.scrubExpired(100, signal === undefined ? {} : { signal });
  };
  const reconciliation = createHistoricalReconciliationLifecycle({
    executePass: async (signal) => {
      await refreshQualificationForReconciliation(signal);
      await runPass(signal);
    },
    logger: input.logger,
  });

  return {
    // Static provenance/configuration already failed closed during config
    // decoding. A transient endpoint or capability response only disables the
    // derived memory slice; it must not block recording/transcription startup.
    assertReady: refreshQualificationForReconciliation,
    close: reconciliation.close,
    createExhaustiveCoverage: (authorization) => {
      const extraction = new SubscriptionRuntimeCoverageExtractorAdapter(
        input.runtimeTransport,
        {
          expectedLauncherSha256: input.config.subscriptionRuntime.launcherSha256,
          expectedRuntimeEngine: subscriptionRuntimeCliEngine,
        },
      );
      return new ExhaustiveCoverage({
        authority: new PostgresHistoricalEvidenceAuthority(input.pool),
        authorization,
        checkpoints,
        extractor: extraction,
        ids: new HmacHistoricalOpaqueIds(topologyKey),
        reducer: new DeterministicCoverageReducer(64, 256),
        sync: new PostgresHistoricalMemoryStore(input.pool),
      }, undefined, twoHourProfile);
    },
    createFocusedRetrieval: (authorization) => new HistoricalFocusedRetrieval({
      authority: new PostgresHistoricalEvidenceAuthority(input.pool),
      authorization,
      ids: new HmacHistoricalOpaqueIds(topologyKey),
      memory,
      store: new PostgresHistoricalMemoryStore(input.pool),
    }, undefined, twoHourProfile),
    searchEnabled: () =>
      config.activation.searchEnabled && transportQualified && searchQualified,
    servingAuthorized: () => config.activation.searchEnabled && searchQualified,
    requestMeetingDeletion: (meetingId) => deletion.execute(meetingId),
    start: reconciliation.start,
  };
}
