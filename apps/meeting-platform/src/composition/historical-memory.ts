import {
  HmacHistoricalOpaqueIds,
  InfinityContextHistoricalMemoryAdapter,
  assertInfinityContextActivation,
} from "@discord-meeting/infinity-context-adapter";
import {
  DEFAULT_HISTORICAL_SYNC_POLICY,
  DeterministicCoverageReducer,
  ExhaustiveCoverage,
  HistoricalFocusedRetrieval,
  HistoricalSyncWorker,
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
    leaseDurationMs: Math.max(
      DEFAULT_HISTORICAL_SYNC_POLICY.leaseDurationMs,
      config.requestTimeoutMs + 5_000,
    ),
  });
  let active: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let indexingQualified = false;
  const deletion = new RequestHistoricalMeetingDeletion(store);

  const refreshQualification = async (): Promise<void> => {
    indexingQualified = false;
    if (!config.activation.indexingEnabled && !config.activation.searchEnabled) {
      return;
    }
    const capabilities = await memory.qualifyCapabilities();
    assertInfinityContextActivation(config.activation, {
      apiVersion: capabilities.api_version ?? null,
      enabledAdapters: capabilities.enabled_adapters ?? [],
      serviceName: capabilities.service_name ?? null,
      supportsQdrant: capabilities.supports_qdrant === true,
    });
    indexingQualified = true;
  };

  const refreshQualificationForReconciliation = async (): Promise<void> => {
    try {
      await refreshQualification();
    } catch (error) {
      indexingQualified = false;
      input.logger.warn("Historical memory qualification unavailable; external indexing is disabled", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
    }
  };

  const runPass = async (): Promise<void> => {
    for (let count = 0; count < maximumOperationsPerPass; count += 1) {
      const result = await worker.executeOnce({
        indexingEnabled: config.activation.indexingEnabled && indexingQualified,
      });
      if (result.status === "idle") {
        break;
      }
      input.logger.info("Historical memory reconciliation settled", {
        operation: result.operation,
        state: result.status,
      });
    }
    await checkpoints.scrubExpired(100);
  };
  const schedule = (): void => {
    if (closed || active !== undefined) {
      return;
    }
    active = refreshQualificationForReconciliation().then(runPass).catch((error: unknown) => {
      input.logger.warn("Historical memory reconciliation failed", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
    }).finally(() => {
      active = undefined;
    });
  };

  return {
    // Static provenance/configuration already failed closed during config
    // decoding. A transient endpoint or capability response only disables the
    // derived memory slice; it must not block recording/transcription startup.
    assertReady: refreshQualificationForReconciliation,
    close: async () => {
      closed = true;
      if (timer !== undefined) {
        clearInterval(timer);
      }
      await active;
    },
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
      });
    },
    createFocusedRetrieval: (authorization) => new HistoricalFocusedRetrieval({
      authority: new PostgresHistoricalEvidenceAuthority(input.pool),
      authorization,
      ids: new HmacHistoricalOpaqueIds(topologyKey),
      memory,
      store: new PostgresHistoricalMemoryStore(input.pool),
    }),
    searchEnabled: () =>
      config.activation.searchEnabled && indexingQualified,
    servingAuthorized: () => config.activation.searchEnabled,
    requestMeetingDeletion: (meetingId) => deletion.execute(meetingId),
    start: async () => {
      if (closed || timer !== undefined) {
        return;
      }
      await runPass();
      timer = setInterval(schedule, reconciliationIntervalMs);
      timer.unref();
    },
  };
}
