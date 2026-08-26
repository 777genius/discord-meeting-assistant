import {
  CooperativeHistoricalIndexPlanner, HmacHistoricalOpaqueIds,
  InfinityContextHistoricalMemoryAdapter, INFINITY_CONTEXT_PRODUCTION_QUALIFICATION,
  PINNED_MULTILINGUAL_MINILM_TOKENIZER_PROFILE, PinnedMultilingualMiniLmTokenizer,
  Sha256HistoricalReceiptDigest, assertInfinityContextActivation,
  assertInfinityContextPlanningCompatibility,
  assertInfinityContextTransportCapabilities,
  infinityContextHistoricalIndexProfileId,
  type InfinityContextProductionQualificationPolicyV1,
} from "@discord-meeting/infinity-context-adapter";
import {
  DEFAULT_HISTORICAL_SYNC_POLICY,
  DeterministicCoverageReducer, ExhaustiveCoverage,
  type HistoricalFocusedLocatorRetrievalV2,
  HistoricalSyncWorker, RequestHistoricalMeetingDeletion,
  historicalEmbeddingTokenProfile, historicalSyncLeaseDurationMs,
  prepareQualifiedHistoricalEmbeddingTokenizer, type HistoricalAuthorizationPort,
  type PrepareFocusedLocatorRetrievalV2Request,
  type FocusedLocatorRetrievalV2ProviderBinding,
  type HistoricalEmbeddingTokenizerPort, type HistoricalSyncStore,
  type HistoricalWindowPlanningProfileV1, type TwoHourHistoricalRetrievalProfileV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { PostgresExhaustiveCoverageStore, PostgresHistoricalEvidenceAuthority,
  PostgresHistoricalMemoryStore } from
  "@discord-meeting/postgres-adapter";
import type { Logger } from "@discord-meeting/observability-adapter";
import { SubscriptionRuntimeCoverageExtractorAdapter, subscriptionRuntimeCliEngine,
  type SubscriptionRuntimeTransportPort,
} from "@discord-meeting/subscription-runtime-adapter";
import type { Pool } from "pg";

import type { PlatformConfig } from "../config.js";
import { createInfinityRetrievalV2Composition } from
  "./infinity-retrieval-v2.js";
import { semanticSearchQualified } from
  "./historical-memory-qualification.js";

const reconciliationIntervalMs = 5_000;
const maximumOperationsPerPass = 25;
const shutdownDrainTimeoutMs = 5_000;

export { historicalSyncLeaseDurationMs } from "@discord-meeting/meeting-core/meeting-knowledge";

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

function qualifyEmbeddingTokenizer(
  tokenizer: HistoricalEmbeddingTokenizerPort,
  expected: {
    readonly embeddingProfile: string;
    readonly embeddingProfileDigestSha256: string;
  } | null,
  observed: {
    readonly embeddingProfileDigestSha256: string | null;
    readonly embeddingProfileId: string | null;
  },
): HistoricalEmbeddingTokenizerPort {
  if (expected === null || !isSha256Digest(expected.embeddingProfileDigestSha256)) {
    throw new Error("Infinity dense embedding profile attestation is required");
  }
  return prepareQualifiedHistoricalEmbeddingTokenizer(tokenizer, {
    expectedEmbeddingProfileDigestSha256: expected.embeddingProfileDigestSha256,
    expectedEmbeddingProfileId: expected.embeddingProfile,
    expectedTokenizerProfile: PINNED_MULTILINGUAL_MINILM_TOKENIZER_PROFILE,
    observedEmbeddingProfileDigestSha256:
      observed.embeddingProfileDigestSha256,
    observedEmbeddingProfileId: observed.embeddingProfileId,
  });
}

function isSha256Digest(value: string): value is `sha256:${string}` {
  return /^sha256:[a-f\d]{64}$/u.test(value);
}

function qualifyPlanningProfile(
  profile: HistoricalWindowPlanningProfileV1,
  tokenizer: HistoricalEmbeddingTokenizerPort,
): string {
  if (
    !/^sha256:[a-f0-9]{64}/u.test(profile.digestSha256) ||
    profile.identity !== historicalEmbeddingTokenProfile(tokenizer) ||
    profile.maximumInputTokens !== tokenizer.profile.maxInputTokens
  ) {
    throw new Error("local dense planning profile attestation is required");
  }
  return profile.identity;
}

interface PlatformHistoricalMemoryInput {
  readonly config: PlatformConfig;
  readonly logger: Logger;
  readonly pool: Pool;
  readonly profileMaintenance?: Pick<HistoricalSyncStore, "enqueueAppliedProfileRebuilds">;
  readonly productionQualification?: InfinityContextProductionQualificationPolicyV1;
  readonly runtimeTransport: SubscriptionRuntimeTransportPort;
}

export interface PlatformHistoricalMemoryRuntime {
  assertReady(): Promise<void>;
  close(): Promise<void>;
  createExhaustiveCoverage(
    authorization: HistoricalAuthorizationPort,
  ): ExhaustiveCoverage;
  createFocusedLocatorRetrievalV2(
    authorization: HistoricalAuthorizationPort,
  ): HistoricalFocusedLocatorRetrievalV2;
  createRetrievalV2Admission(
    binding: FocusedLocatorRetrievalV2ProviderBinding,
  ): PrepareFocusedLocatorRetrievalV2Request;
  embeddingTokenizer(): HistoricalEmbeddingTokenizerPort | undefined;
  servingAuthorized(): boolean;
  requestMeetingDeletion(meetingId: string): Promise<void>;
  start(): Promise<void>;
}

interface HistoricalRetrievalFactoryInput {
  readonly authorization: HistoricalAuthorizationPort;
  readonly checkpoints: PostgresExhaustiveCoverageStore;
  readonly input: PlatformHistoricalMemoryInput;
  readonly profile: TwoHourHistoricalRetrievalProfileV1;
  readonly tokenizer: () => HistoricalEmbeddingTokenizerPort | undefined;
  readonly topologyKey: string;
}

function createPlatformExhaustiveCoverage(
  factory: HistoricalRetrievalFactoryInput,
): ExhaustiveCoverage {
  const extraction = new SubscriptionRuntimeCoverageExtractorAdapter(
    factory.input.runtimeTransport,
    {
      expectedLauncherSha256: factory.input.config.subscriptionRuntime.launcherSha256,
      expectedRuntimeEngine: subscriptionRuntimeCliEngine,
    },
  );
  return new ExhaustiveCoverage({
    authority: new PostgresHistoricalEvidenceAuthority(factory.input.pool),
    authorization: factory.authorization,
    checkpoints: factory.checkpoints,
    extractor: extraction,
    ids: new HmacHistoricalOpaqueIds(factory.topologyKey),
    reducer: new DeterministicCoverageReducer(64, 256),
    sync: new PostgresHistoricalMemoryStore(factory.input.pool),
    tokenizer: factory.tokenizer,
  }, undefined, factory.profile);
}

async function executeHistoricalPass(input: {
  readonly checkpoints: PostgresExhaustiveCoverageStore;
  readonly indexingEnabled: () => boolean;
  readonly logger: Logger;
  readonly worker: HistoricalSyncWorker;
}, signal?: AbortSignal): Promise<void> {
  for (let count = 0; count < maximumOperationsPerPass; count += 1) {
    signal?.throwIfAborted();
    const result = await input.worker.executeOnce({
      indexingEnabled: input.indexingEnabled(),
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
  await input.checkpoints.scrubExpired(100, signal === undefined ? {} : { signal });
}

function requireHistoricalRuntimeSecrets(config: PlatformConfig): {
  readonly token: string;
  readonly topologyKey: string;
} {
  const token = config.secrets.infinityContextToken;
  const topologyKey = config.secrets.infinityContextTopologyKey;
  if (token === undefined || topologyKey === undefined) {
    throw new Error("Infinity runtime secrets are missing after configuration validation");
  }
  return { token, topologyKey };
}

function configuredHistoricalIndexProfileId(
  activation: NonNullable<PlatformConfig["infinityContext"]>["activation"],
): string {
  const digest = activation.embeddingProfileAttestation
    ?.embeddingProfileDigestSha256 ?? "sha256:" + "0".repeat(64);
  return infinityContextHistoricalIndexProfileId(digest);
}

export function createPlatformHistoricalMemory(
  input: PlatformHistoricalMemoryInput,
): PlatformHistoricalMemoryRuntime | undefined {
  const config = input.config.infinityContext;
  if (config === undefined) {
    return undefined;
  }
  if (config.activation.environment !== input.config.nodeEnvironment) {
    throw new Error("Infinity activation environment does not match Meeting Platform");
  }
  const { token, topologyKey } = requireHistoricalRuntimeSecrets(input.config);
  const productionQualification = input.productionQualification ??
    INFINITY_CONTEXT_PRODUCTION_QUALIFICATION;
  let qualifiedTokenProfile: string | undefined;
  let qualifiedTokenizer: HistoricalEmbeddingTokenizerPort | undefined;
  const { retrievalV2, twoHourProfile } = createInfinityRetrievalV2Composition(
    input.config, input.pool, token, topologyKey,
  );
  const memory = new InfinityContextHistoricalMemoryAdapter({
    baseUrl: config.baseUrl,
    operationTimeoutMs: config.operationTimeoutMs,
    requestTimeoutMs: config.requestTimeoutMs,
    schemaVersion: 1,
    token: () => token,
    embeddingTokenProfile: () => qualifiedTokenProfile,
  });
  let embeddingTokenizer: PinnedMultilingualMiniLmTokenizer | undefined;
  const planner = new CooperativeHistoricalIndexPlanner();
  const store = new PostgresHistoricalMemoryStore(input.pool);
  const profileMaintenance = input.profileMaintenance ?? store;
  const checkpoints = new PostgresExhaustiveCoverageStore(input.pool);
  const worker = new HistoricalSyncWorker({
    authority: new PostgresHistoricalEvidenceAuthority(input.pool),
    ids: new HmacHistoricalOpaqueIds(topologyKey),
    indexProfileId: configuredHistoricalIndexProfileId(config.activation),
    memory,
    store,
    planner,
    receiptDigest: new Sha256HistoricalReceiptDigest(),
  }, {
    ...DEFAULT_HISTORICAL_SYNC_POLICY,
    leaseDurationMs: historicalSyncLeaseDurationMs(config.operationTimeoutMs),
  });
  let transportQualified = false;
  let projectionQualified = false;
  let searchQualified = false;
  const deletion = new RequestHistoricalMeetingDeletion(store);
  const refreshQualification = async (signal?: AbortSignal): Promise<void> => {
    transportQualified = projectionQualified = searchQualified = false;
    qualifiedTokenProfile = undefined; qualifiedTokenizer = undefined;
    const capabilities = await memory.qualifyCapabilities(
      signal === undefined ? {} : { signal },
    );
    assertInfinityContextTransportCapabilities(config.activation, capabilities);
    transportQualified = true;
    if (!config.activation.indexingEnabled && !config.activation.searchEnabled) { return; }
    assertInfinityContextActivation(
      config.activation, capabilities, productionQualification,
    );
    qualifiedTokenizer = qualifyEmbeddingTokenizer(
      embeddingTokenizer ??= new PinnedMultilingualMiniLmTokenizer(),
      config.activation.embeddingProfileAttestation,
      capabilities,
    );
    assertInfinityContextPlanningCompatibility({
      productionQualification,
      tokenizerProfile: qualifiedTokenizer.profile,
    });
    const planningProfile = await planner.start();
    qualifiedTokenProfile = qualifyPlanningProfile(
      planningProfile, qualifiedTokenizer,
    );
    const indexProfileId = configuredHistoricalIndexProfileId(config.activation);
    const rebuilds = await profileMaintenance.enqueueAppliedProfileRebuilds(
      indexProfileId, 4_096, signal === undefined ? {} : { signal },
    );
    if (rebuilds.enqueued > 0 || rebuilds.remaining) {
      input.logger.info("Historical index profile rebuilds enqueued", rebuilds);
    }
    projectionQualified = true;
    searchQualified = !rebuilds.remaining && semanticSearchQualified(
      config.activation, input.logger, productionQualification,
    );
  };

  const refreshQualificationForReconciliation = async (
    signal?: AbortSignal,
  ): Promise<void> => {
    try {
      await refreshQualification(signal);
    } catch (error) {
      signal?.throwIfAborted();
      projectionQualified = searchQualified = false;
      qualifiedTokenProfile = undefined; qualifiedTokenizer = undefined;
      input.logger.warn("Historical memory qualification unavailable; external indexing is disabled", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
    }
  };

  const reconciliation = createHistoricalReconciliationLifecycle({
    executePass: async (signal) => {
      await refreshQualificationForReconciliation(signal);
      if (!transportQualified) { return; }
      await executeHistoricalPass({
        checkpoints,
        indexingEnabled: () => config.activation.indexingEnabled && projectionQualified,
        logger: input.logger,
        worker,
      }, signal);
    },
    logger: input.logger,
  });

  return {
    // Static provenance/configuration already failed closed during config
    // decoding. A transient endpoint or capability response only disables the
    // derived memory slice; it must not block recording/transcription startup.
    assertReady: refreshQualificationForReconciliation,
    close: async () => {
      await reconciliation.close();
      await planner.close();
    },
    createExhaustiveCoverage: (authorization) => {
      return createPlatformExhaustiveCoverage({
        authorization,
        checkpoints,
        input,
        profile: twoHourProfile,
        tokenizer: () => qualifiedTokenizer,
        topologyKey,
      });
    },
    createFocusedLocatorRetrievalV2: (authorization) =>
      retrievalV2.retrieval(authorization),
    createRetrievalV2Admission: (binding) => retrievalV2.admission(binding),
    embeddingTokenizer: () => qualifiedTokenizer,
    servingAuthorized: () => config.activation.searchEnabled && searchQualified,
    requestMeetingDeletion: (meetingId) => deletion.execute(meetingId),
    start: reconciliation.start,
  };
}
