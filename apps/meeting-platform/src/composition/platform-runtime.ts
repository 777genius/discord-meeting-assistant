import {
  createJsonLogger,
  flushLoggers,
  PrometheusMetrics,
} from "@discord-meeting/observability-adapter";
import { RequestHistoricalMeetingDeletion } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import {
  PostgresHistoricalMemoryStore,
  PostgresSchemaReadiness,
} from "@discord-meeting/postgres-adapter";

import { PlatformRecordingIngress } from "../application/platform-ingress.js";
import type { PostCallOutboxDispatcher } from "../application/post-call-outbox-dispatcher.js";
import type { PlatformConfig } from "../config.js";
import { createPlatformCoreResources } from "./core-resources.js";
import { createPlatformDiscordLiveComposition } from "./discord-live.js";
import { createPlatformHealth } from "./health.js";
import { createPlatformHistoricalMemory } from "./historical-memory.js";
import { createPlatformGroundedMeetingAnswer } from "./grounded-answer.js";
import { createPlatformLiveFinalizedMemory } from "./live-finalized-memory.js";
import { createPlatformHttpComposition } from "./http.js";
import { createMeetingKnowledgeLocalFinalReply } from "./meeting-knowledge.js";
import {
  classifyRecordingIngressRejection,
  createQueueObserver,
} from "./observability.js";
import {
  createPlatformPostCallComposition,
} from "./post-call.js";
import { createPlatformRecordingPlaybackComposition } from "./recording-playback.js";
import { createProcessingRuntime } from "./processing.js";
import {
  closeMeetingPlatformResources,
  closePostCallResources,
} from "./platform-shutdown.js";
import {
  PlatformStartupCleanup,
  rethrowAfterFailedPlatformStartup,
} from "./startup-cleanup.js";
import { startPlatformServices } from "./startup.js";

const outboxReconcileIntervalMilliseconds = 5_000;

export interface MeetingPlatformRuntime {
  close(): Promise<void>;
}

/** Composes one singleton Meeting Platform process from explicit adapters. */
export async function startMeetingPlatform(
  config: PlatformConfig,
): Promise<MeetingPlatformRuntime> {
  const cleanup = new PlatformStartupCleanup();
  const logger = createJsonLogger({
    baseContext: { application: "discord-meeting-platform", version: "0.1.0" },
    environment: config.nodeEnvironment,
  });
  cleanup.defer("logger", () => flushLoggers([logger]));
  const metrics = new PrometheusMetrics();
  try {
    const core = createPlatformCoreResources({ cleanup, config, logger, metrics });
    const {
      discordLive,
      historicalMemory,
      liveFinalizedMemory,
      meetingKnowledge,
      recordingPlayback,
    } = await createPlatformKnowledgeComposition({ cleanup, config, core, logger });
    const processMeeting = createProcessingRuntime({
      ...(discordLive.live === undefined ? {} : { live: discordLive.live }),
      liveMeetings: core.liveMeetings,
      logger,
      meetings: core.meetings,
      metrics,
      rawPublisher: discordLive.rawPublisher,
      rawSummarizer: core.rawSummarizer,
      rawTranscriber: core.rawTranscriber,
    });
    const postCall = await createPlatformPostCallComposition({
      connection: core.connection,
      logger,
      meetings: core.meetings,
      metrics,
      observer: createQueueObserver(logger, metrics),
      processMeeting,
    });
    cleanup.defer("post-call runtime", () => closePostCallResources(postCall));
    const ingress = new PlatformRecordingIngress({
      dispatcher: postCall.outboxDispatcher,
      failureClassifier: { classify: classifyRecordingIngressRejection },
      ingress: core.recordingIngress,
      ...(discordLive.live === undefined ? {} : { live: discordLive.live }),
      logger,
      metrics,
      outbox: core.meetings,
      publicationTargets: core.publicationTargets,
    });
    const schemaReadiness = new PostgresSchemaReadiness(core.pool);
    const health = createPlatformHealth({
      config,
      ...(discordLive.conversationRuntime === undefined
        ? {}
        : { conversationRuntime: discordLive.conversationRuntime }),
      discord: discordLive.discord,
      pool: core.pool,
      postCallDurability: postCall.worker,
      queue: postCall.queue,
      redisPolicyReadiness: postCall.redisPolicyReadiness,
      runtime: core.rawSummarizer,
      schemaReadiness,
      s3: core.s3,
    });
    const http = createPlatformHttpComposition({
      cleanup,
      config,
      configuration: core.guildConfigurations,
      craigPlaybackGateway: discordLive.craigPlaybackGateway,
      health: {
        metrics: () => metrics.render(),
        readiness: async () => ({ ready: (await health.snapshot()).ready }),
      },
      historicalDeletion: createPlatformHistoricalDeletion(core.pool),
      ingress,
      installUrls: discordLive.installUrls,
      logger,
      ...(recordingPlayback.routes === undefined
        ? {}
        : { recordingPlaybackRoutes: recordingPlayback.routes }),
    });
    await startPlatformServices({
      config,
      dependencyReadiness: createDependencyReadiness(health),
      discord: discordLive.discord,
      guildSetupHandler: discordLive.guildSetupHandler,
      ...(historicalMemory === undefined ? {} : { historicalMemory }),
      logger,
      meetingPlatformInstallUrl: discordLive.installUrls.meetingPlatform,
      outboxDispatcher: postCall.outboxDispatcher,
      pool: core.pool,
      recordings: core.recordings,
      queue: postCall.queue,
      queueEvents: postCall.queueEvents,
      schemaReadiness,
      server: http.server,
      worker: postCall.worker,
    });
    meetingKnowledge?.start();
    liveFinalizedMemory?.start();
    cleanup.release();
    return createRunningPlatformRuntime({
      ...(discordLive.conversationRuntime === undefined
        ? {}
        : { conversationRuntime: discordLive.conversationRuntime }),
      craigPlayback: {
        gateway: discordLive.craigPlaybackGateway,
        webSocket: http.craigPlaybackWebSocket,
      },
      discord: discordLive.discord,
      guildSetupHandler: discordLive.guildSetupHandler,
      ...(historicalMemory === undefined ? {} : { historicalMemory }),
      ...(liveFinalizedMemory === undefined ? {} : { liveFinalizedMemory }),
      logger,
      ...(discordLive.live === undefined ? {} : { live: discordLive.live }),
      ...(meetingKnowledge === undefined ? {} : { meetingKnowledge }),
      outboxDispatcher: postCall.outboxDispatcher,
      pool: core.pool,
      queue: postCall.queue,
      queueEvents: postCall.queueEvents,
      recordings: core.recordings,
      runtimeTransport: core.rawRuntimeTransport,
      s3: core.s3,
      server: http.server,
      worker: postCall.worker,
    });
  } catch (error) {
    return rethrowAfterFailedPlatformStartup(error, cleanup);
  }
}

async function createPlatformKnowledgeComposition(input: {
  readonly cleanup: PlatformStartupCleanup;
  readonly config: PlatformConfig;
  readonly core: ReturnType<typeof createPlatformCoreResources>;
  readonly logger: Parameters<typeof createPlatformHistoricalMemory>[0]["logger"];
}) {
  const { cleanup, config, core, logger } = input;
  const historicalMemory = createPlatformHistoricalMemory({
    config,
    logger,
    pool: core.pool,
    runtimeTransport: core.runtimeTransport,
  });
  if (historicalMemory !== undefined) {
    cleanup.defer("historical memory reconciler", () => historicalMemory.close());
  }
  const liveFinalizedMemory = createPlatformLiveFinalizedMemory({
    config,
    logger,
    pool: core.pool,
  });
  if (liveFinalizedMemory !== undefined) {
    cleanup.defer("live finalized memory reconciler", () =>
      liveFinalizedMemory.close()
    );
  }
  const groundedAnswerUseCase = createPlatformGroundedMeetingAnswer({
    config,
    runtimeTransport: core.runtimeTransport,
  });
  const recordingPlayback = createPlatformRecordingPlaybackComposition({
    config,
    meetings: core.meetings,
    s3: core.s3,
  });
  const discordLive = await createPlatformDiscordLiveComposition({
    cleanup,
    config,
    guildConfigurations: core.guildConfigurations,
    ...(groundedAnswerUseCase === undefined ? {} : { groundedAnswerUseCase }),
    ...(historicalMemory === undefined ? {} : { historicalMemory }),
    logger,
    ...(liveFinalizedMemory === undefined ? {} : { liveFinalizedMemory }),
    meetings: core.liveMeetings,
    pool: core.pool,
    publicationEffects: core.publicationEffects,
    ...(recordingPlayback.recordingPlaybackUrl === undefined
      ? {}
      : { recordingPlaybackUrl: recordingPlayback.recordingPlaybackUrl }),
    runtimeTransport: core.runtimeTransport,
  });
  const meetingKnowledge = createMeetingKnowledgeLocalFinalReply({
    ...(groundedAnswerUseCase === undefined ? {} : { answers: groundedAnswerUseCase }),
    client: discordLive.discord,
    config,
    guildConfigurations: core.guildConfigurations,
    ...(historicalMemory === undefined ? {} : { historicalMemory }),
    logger,
    pool: core.pool,
    runtimeTransport: core.runtimeTransport,
  });
  if (meetingKnowledge !== undefined) {
    cleanup.defer("Meeting Knowledge local final reply", () => meetingKnowledge.close());
  }
  return {
    discordLive,
    historicalMemory,
    liveFinalizedMemory,
    meetingKnowledge,
    recordingPlayback,
  };
}

export function createPlatformHistoricalDeletion(
  pool: ConstructorParameters<typeof PostgresHistoricalMemoryStore>[0],
): { readonly requestMeetingDeletion: (meetingId: string) => Promise<void> } {
  const deletion = new RequestHistoricalMeetingDeletion(
    new PostgresHistoricalMemoryStore(pool),
  );
  return {
    requestMeetingDeletion: (meetingId) => deletion.execute(meetingId),
  };
}

function createDependencyReadiness(
  health: ReturnType<typeof createPlatformHealth>,
): { readonly assertReady: () => Promise<void> } {
  return {
    assertReady: async () => {
      const snapshot = await health.snapshot();
      if (snapshot.ready) {
        return;
      }
      const failedDependencies = snapshot.dependencies
        .filter(({ critical, status }) => critical && status !== "healthy")
        .map(({ name }) => name)
        .join(", ");
      throw new Error(
        `Required platform dependencies are not ready: ${failedDependencies}`,
      );
    },
  };
}

function createRunningPlatformRuntime(
  resources: Parameters<typeof closeMeetingPlatformResources>[0] & {
    readonly outboxDispatcher: Pick<
      PostCallOutboxDispatcher,
      "dispatchPending" | "whenIdle"
    >;
  },
): MeetingPlatformRuntime {
  const outboxReconcileTimer = setInterval(() => {
    void resources.outboxDispatcher.dispatchPending();
  }, outboxReconcileIntervalMilliseconds);
  outboxReconcileTimer.unref();
  let closing: Promise<void> | undefined;
  return {
    close: () => {
      clearInterval(outboxReconcileTimer);
      closing ??= closeMeetingPlatformResources(resources);
      return closing;
    },
  };
}
