import { once } from "node:events";
import type { Server } from "node:http";

import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import {
  BullMqPostCallDeadLetterRecorder,
  BullMqPostCallEnqueuer,
  NonRetryablePostCallError,
  RetryablePostCallError,
  createPostCallDeadLetterQueue,
  createPostCallQueue,
  createPostCallQueueEvents,
  createPostCallWorker,
  drainActivePostCallJobsAndClose,
  type PostCallObserver,
  type PostCallWorker,
} from "@discord-meeting/bullmq-adapter";
import {
  DiscordGuildSetupAdapter,
  DiscordGuildSetupCommandHandler,
  DiscordJsProjectionClient,
  DiscordLiveMeetingProjectionAdapter,
  DiscordSummaryPublicationAdapter,
  DiscordSummaryPublisher,
  InProcessProjectionLock,
  craigGatewayInstallPermissions,
  createDiscordGuildInstallUrl,
  meetingPlatformInstallPermissions,
  registerDiscordGuildSetupCommand,
} from "@discord-meeting/discord-adapter";
import {
  ConfigureGuild,
  ResolveGuildMeetingTarget,
} from "@discord-meeting/guild-configuration-core";
import {
  ProcessMeetingSummary,
  AppendLiveTranscriptTurn,
  FinishLiveMeeting,
  RefreshLiveMeeting,
  StartLiveMeeting,
  type FinalTranscriptionPort,
} from "@discord-meeting/meeting-core";
import {
  createS3BinaryArtifactReader,
  createS3BinaryArtifactWriter,
} from "@discord-meeting/object-storage-adapter";
import {
  HealthAggregator,
  PrometheusMetrics,
  createJsonLogger,
  flushLoggers,
  type HealthProbe,
  type Logger,
} from "@discord-meeting/observability-adapter";
import {
  PostgresLiveMeetingRepository,
  PostgresMeetingRepository,
  PostgresGuildConfigurationRepository,
} from "@discord-meeting/postgres-adapter";
import {
  DurableCraigRecordingIngress,
  RecordingIngressError,
} from "@discord-meeting/recording-ingress-adapter";
import {
  FetchSpeachesTranscriptionClient,
  SpeachesFinalTranscriptionAdapter,
} from "@discord-meeting/speaches-adapter";
import {
  SubscriptionRuntimeIncrementalSummaryAdapter,
  SubscriptionRuntimeSummaryAdapter,
  subscriptionRuntimeIncrementalMaxOutputTokens,
  subscriptionRuntimeSummaryMaxOutputTokens,
} from "@discord-meeting/subscription-runtime-adapter";
import {
  FetchVoicetextBatchClient,
  VoicetextBatchFinalTranscriptionAdapter,
  VoicetextLiveTranscriptionAdapter,
  batchEndpointFromWebSocketUrl,
} from "@discord-meeting/voicetext-adapter";
import type { ConnectionOptions } from "bullmq";
import { Client, GatewayIntentBits } from "discord.js";
import { Pool } from "pg";

import type { PlatformConfig } from "./config.js";
import { createCraigHttpServer } from "./craig-http-server.js";
import {
  InstrumentedFinalTranscriptionPort,
  InstrumentedSummaryGenerationPort,
  InstrumentedSummaryPublicationPort,
} from "./instrumented-processing-ports.js";
import { LiveFencedSummaryPublicationPort } from "./live-fenced-summary-publication.js";
import { GuildPublicationTargetResolver } from "./guild-publication-target-resolver.js";
import { PlatformLiveMeetingRuntime } from "./live-meeting-runtime.js";
import { PlatformCraigIngress } from "./platform-ingress.js";
import { PostCallOutboxDispatcher } from "./post-call-outbox-dispatcher.js";
import {
  S3CompleteOggArtifactReader,
  S3OggAudioArtifactReader,
} from "./s3-ogg-audio-artifact-reader.js";
import { GrpcSubscriptionRuntimeTransport } from "./subscription-runtime-grpc-transport.js";

const queuePrefix = "discord-meeting-v1";
const monotonicNowMilliseconds = (): number => performance.now();

export interface MeetingPlatformRuntime {
  close(): Promise<void>;
}

export async function startMeetingPlatform(
  config: PlatformConfig,
): Promise<MeetingPlatformRuntime> {
  const logger = createJsonLogger({
    baseContext: { application: "discord-meeting-platform", version: "0.1.0" },
    environment: config.nodeEnvironment,
  });
  const metrics = new PrometheusMetrics();
  const observer = createQueueObserver(logger, metrics);
  const pool = new Pool({ connectionString: config.secrets.postgresUrl });
  const connection = redisConnection(config.secrets.redisUrl);
  const s3 = new S3Client({
    credentials: {
      accessKeyId: config.secrets.s3AccessKeyId,
      secretAccessKey: config.secrets.s3SecretAccessKey,
    },
    endpoint: config.s3.endpoint,
    forcePathStyle: true,
    region: config.s3.region,
  });
  const accessPolicy = { bucket: config.s3.bucket, keyPrefix: config.s3.prefix } as const;
  const artifactReader = createS3BinaryArtifactReader(s3, { accessPolicy });
  const artifactWriter = createS3BinaryArtifactWriter(s3, { accessPolicy });
  const recordings = new DurableCraigRecordingIngress({
    artifactLocatorPrefix: `s3://${config.s3.bucket}/${config.s3.prefix.slice(0, -1)}`,
    finalizationSource: "craig-original",
    spoolRoot: config.recordingSpoolRoot,
    writer: artifactWriter,
  });
  const meetings = new PostgresMeetingRepository(pool);
  const guildConfigurations = new PostgresGuildConfigurationRepository(pool);
  const publicationTargets = new GuildPublicationTargetResolver(
    new ResolveGuildMeetingTarget(guildConfigurations),
    config.discordLegacyRoute,
  );
  const rawTranscriber = createFinalTranscriber(config, artifactReader);
  const runtimeTransport = new GrpcSubscriptionRuntimeTransport({
    address: config.subscriptionRuntime.address,
    serviceToken: config.secrets.subscriptionRuntimeToken,
  });
  const rawSummarizer = new SubscriptionRuntimeSummaryAdapter(runtimeTransport, {
    expectedLauncherSha256: config.subscriptionRuntime.launcherSha256,
    maxOutputTokens: subscriptionRuntimeSummaryMaxOutputTokens,
    outputLanguage: "Natural English; preserve technical terms exactly",
  });
  const discord = new Client({ intents: [GatewayIntentBits.Guilds] });
  const meetingPlatformInstallUrl = createDiscordGuildInstallUrl({
    applicationId: config.discordApplicationId,
    permissions: config.discordApplicationId === config.discordCraigApplicationId
      ? meetingPlatformInstallPermissions | craigGatewayInstallPermissions
      : meetingPlatformInstallPermissions,
  });
  const craigInstallUrl = createDiscordGuildInstallUrl({
    applicationId: config.discordCraigApplicationId,
    permissions: craigGatewayInstallPermissions,
  });
  const guildSetupAdapter = new DiscordGuildSetupAdapter(
    discord,
    config.discordCraigApplicationId,
  );
  const guildSetupHandler = new DiscordGuildSetupCommandHandler(
    discord,
    new ConfigureGuild(guildConfigurations, guildSetupAdapter, guildSetupAdapter),
    craigInstallUrl,
    (error) => {
      logger.error("Discord guild setup failed", classifyCraigIngressError(error));
    },
  );
  const discordPublisher = new DiscordSummaryPublisher(
    new DiscordJsProjectionClient(discord),
    new InProcessProjectionLock(),
    { publicationMode: config.discordPublicationMode },
  );
  const rawPublisher = new DiscordSummaryPublicationAdapter(discordPublisher);
  const liveMeetings = new PostgresLiveMeetingRepository(pool);
  const live = createLiveRuntime({
    config,
    discordPublisher,
    logger,
    meetings: liveMeetings,
    publicationTargets,
    runtimeTransport,
  });
  const transcriber = new InstrumentedFinalTranscriptionPort(
    rawTranscriber,
    metrics,
    logger,
    monotonicNowMilliseconds,
  );
  const summarizer = new InstrumentedSummaryGenerationPort(
    rawSummarizer,
    metrics,
    logger,
    monotonicNowMilliseconds,
  );
  const finalPublisher = live === undefined
    ? rawPublisher
    : new LiveFencedSummaryPublicationPort(rawPublisher, live, liveMeetings);
  const publisher = new InstrumentedSummaryPublicationPort(
    finalPublisher,
    metrics,
    logger,
    monotonicNowMilliseconds,
  );
  const processMeeting = new ProcessMeetingSummary({
    meetings,
    publisher,
    summarizer,
    transcriber,
  });
  const queue = createPostCallQueue({ connection, observer, prefix: queuePrefix });
  const deadLetterQueue = createPostCallDeadLetterQueue({
    connection,
    observer,
    prefix: queuePrefix,
  });
  const queueEvents = createPostCallQueueEvents({ connection, observer, prefix: queuePrefix });
  const enqueuer = new BullMqPostCallEnqueuer(queue, {}, observer);
  const outboxDispatcher = new PostCallOutboxDispatcher(meetings, enqueuer, logger);
  const worker = createPostCallWorker({
    connection,
    deadLetterRecorder: new BullMqPostCallDeadLetterRecorder(deadLetterQueue),
    handler: async ({ meetingId }, { signal }) => {
      const result = await processMeeting.execute(
        meetingId,
        signal === undefined ? {} : { signal },
      );
      if (result.status === "published") {
        metrics.recordDiscordPublication(result.reused ? "duplicate" : "succeeded");
        logger.info("Meeting summary published", { meetingId, reused: result.reused });
        return;
      }
      if (result.status === "not-found") {
        throw new NonRetryablePostCallError("MEETING_NOT_FOUND");
      }
      throw result.failure.retryable
        ? new RetryablePostCallError(result.failure.code)
        : new NonRetryablePostCallError(result.failure.code);
    },
    observer,
    prefix: queuePrefix,
  });

  const ingress = new PlatformCraigIngress({
    dispatcher: outboxDispatcher,
    ingress: recordings,
    ...(live === undefined ? {} : { live }),
    logger,
    outbox: meetings,
    metrics,
    publicationTargets,
  });
  const health = new HealthAggregator(
    createHealthProbes({
      config,
      discord,
      pool,
      queue,
      runtime: rawSummarizer,
      s3,
    }),
    { timeoutMs: 5_000 },
  );
  const server = createCraigHttpServer({
    bearerToken: config.secrets.craigBearerToken,
    configuration: guildConfigurations,
    health: {
      metrics: () => metrics.render(),
      readiness: async () => ({ ready: (await health.snapshot()).ready }),
    },
    ingress,
    installUrls: {
      craig: craigInstallUrl,
      meetingPlatform: meetingPlatformInstallUrl,
    },
    onInternalError: (error) => {
      logger.error("Craig ingress request failed", classifyCraigIngressError(error));
    },
  });

  try {
    await Promise.all([
      pool.query("SELECT 1"),
      ...(live === undefined
        ? []
        : [pool.query("SELECT 1 FROM meeting_core.live_meetings LIMIT 0")]),
      pool.query("SELECT 1 FROM guild_configuration.guild_installations LIMIT 0"),
      queue.waitUntilReady(),
      queueEvents.waitUntilReady(),
    ]);
    await outboxDispatcher.dispatchPending();
    const ready = once(discord, "clientReady");
    await discord.login(config.secrets.discordToken);
    if (!discord.isReady()) {
      await ready;
    }
    const discordApplication = discord.application;
    if (discordApplication === null || discordApplication.id !== config.discordApplicationId) {
      throw new Error("Discord application ID does not match the configured bot token");
    }
    await registerDiscordGuildSetupCommand(discord);
    guildSetupHandler.start();
    server.listen(config.port, config.bindAddress);
    await once(server, "listening");
    logger.info("Meeting platform is ready", {
      discordInstallUrl: meetingPlatformInstallUrl,
      port: config.port,
    });
  } catch (error) {
    await closeMeetingPlatformResources({
      discord,
      guildSetupHandler,
      logger,
      ...(live === undefined ? {} : { live }),
      pool,
      queue,
      queueEvents,
      deadLetterQueue,
      runtimeTransport,
      s3,
      server,
      worker,
    }).catch(() => false);
    throw error;
  }

  const outboxReconcileTimer = setInterval(() => {
    void outboxDispatcher.dispatchPending();
  }, 5_000);
  outboxReconcileTimer.unref();
  let closing: Promise<void> | undefined;
  return {
    close: async () => {
      clearInterval(outboxReconcileTimer);
      closing ??= closeMeetingPlatformResources({
        discord,
        guildSetupHandler,
        logger,
        ...(live === undefined ? {} : { live }),
        pool,
        queue,
        queueEvents,
        deadLetterQueue,
        runtimeTransport,
        s3,
        server,
        worker,
      });
      await closing;
    },
  };
}

function createLiveRuntime(input: {
  readonly config: PlatformConfig;
  readonly discordPublisher: DiscordSummaryPublisher;
  readonly logger: Logger;
  readonly meetings: PostgresLiveMeetingRepository;
  readonly publicationTargets: GuildPublicationTargetResolver;
  readonly runtimeTransport: GrpcSubscriptionRuntimeTransport;
}): PlatformLiveMeetingRuntime | undefined {
  if (
    input.config.transcriptionProvider !== "voicetext" ||
    input.config.voicetext === undefined ||
    input.config.secrets.voicetextServiceToken === undefined
  ) {
    return undefined;
  }
  const summarizer = new SubscriptionRuntimeIncrementalSummaryAdapter(
    input.runtimeTransport,
    {
      expectedLauncherSha256: input.config.subscriptionRuntime.launcherSha256,
      maxOutputTokens: subscriptionRuntimeIncrementalMaxOutputTokens,
      maxRecentContextTurns: 256,
      outputLanguage: "Natural English; preserve technical terms exactly",
      timeoutMs: 30_000,
    },
  );
  const projector = new DiscordLiveMeetingProjectionAdapter(input.discordPublisher);
  return new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(input.meetings),
    finishMeeting: new FinishLiveMeeting(input.meetings),
    logger: input.logger,
    publicationTargets: input.publicationTargets,
    refreshMeeting: new RefreshLiveMeeting({
      meetings: input.meetings,
      projector,
      summarizer,
    }),
    startMeeting: new StartLiveMeeting({ meetings: input.meetings }),
    transcriber: new VoicetextLiveTranscriptionAdapter({
      endpoint: input.config.voicetext.webSocketUrl,
      keyterms: meetingVocabulary,
      language: "multi",
      token: input.config.secrets.voicetextServiceToken,
    }),
  });
}

const meetingVocabulary = [
  "BullMQ",
  "Craig",
  "Craig recording",
  "Discord",
  "Discord thread",
  "idempotency key",
  "live Pipecat assistant",
  "Meeting Platform",
  "Pipecat",
  "PostgreSQL",
  "PostgreSQL pipeline",
  "Redis",
  "Redis queue",
] as const;

function createFinalTranscriber(
  config: PlatformConfig,
  artifactReader: ReturnType<typeof createS3BinaryArtifactReader>,
): FinalTranscriptionPort {
  if (config.transcriptionProvider === "speaches") {
    return new SpeachesFinalTranscriptionAdapter(
      new FetchSpeachesTranscriptionClient(config.speaches.baseUrl),
      new S3OggAudioArtifactReader(artifactReader),
      {
        language: "ru",
        maxBytesPerSpeaker: 64 * 1_024 * 1_024,
        maxSpeakerTracks: 64,
        model: config.speaches.model,
        vocabulary: meetingVocabulary,
      },
    );
  }
  if (config.voicetext === undefined || config.secrets.voicetextServiceToken === undefined) {
    throw new Error("Voicetext transcription configuration is incomplete");
  }
  return new VoicetextBatchFinalTranscriptionAdapter(
    new FetchVoicetextBatchClient({
      endpoint: batchEndpointFromWebSocketUrl(config.voicetext.webSocketUrl),
      token: config.secrets.voicetextServiceToken,
    }),
    new S3CompleteOggArtifactReader(artifactReader),
    {
      keyterms: meetingVocabulary,
      maxArtifactBytesPerSpeaker: config.voicetext.batchMaxArtifactBytes,
      maxConcurrency: 2,
      maxTotalArtifactBytes: 256 * 1_024 * 1_024,
      maxSpeakerTracks: 64,
      pollTimeoutMs: 900_000,
    },
  );
}

function classifyCraigIngressError(error: unknown): Readonly<Record<string, unknown>> {
  if (error instanceof RecordingIngressError) {
    return {
      errorCode: error.code,
      failure: error.failure,
    };
  }
  if (error instanceof Error) {
    const errorWithCode = error as Error & { readonly code?: unknown };
    return {
      errorCode:
        typeof errorWithCode.code === "string" ? errorWithCode.code : "UNEXPECTED_ERROR",
      errorName: error.name,
    };
  }
  return { errorCode: "UNEXPECTED_THROWABLE" };
}

function createQueueObserver(logger: Logger, metrics: PrometheusMetrics): PostCallObserver {
  return (event) => {
    if (event.kind === "job-requeued") {
      logger.info("Post-call job requeued after cancellation", { jobRef: event.jobRef });
    }
    if (event.kind === "job-failed" && event.retryable === true) {
      metrics.recordQueueRetry("transient");
    }
    if (event.kind === "dead-letter-recorded") {
      metrics.recordDeadLetter("attempts-exhausted");
    }
    if (event.kind === "runtime-error") {
      logger.warn("Post-call queue runtime error", { component: event.component });
    }
  };
}

function redisConnection(value: string): ConnectionOptions {
  const url = new URL(value);
  if (
    !["redis:", "rediss:"].includes(url.protocol) ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("Redis secret must contain a canonical redis URL");
  }
  const databaseText = url.pathname.slice(1);
  const database = databaseText.length === 0 ? 0 : Number(databaseText);
  if (!Number.isSafeInteger(database) || database < 0 || database > 15) {
    throw new Error("Redis database must be an integer from 0 through 15");
  }
  return {
    db: database,
    host: url.hostname,
    password: url.password.length === 0 ? undefined : decodeURIComponent(url.password),
    port: url.port.length === 0 ? 6_379 : Number(url.port),
    tls: url.protocol === "rediss:" ? {} : undefined,
    username: url.username.length === 0 ? undefined : decodeURIComponent(url.username),
  };
}

function createHealthProbes(input: {
  readonly config: PlatformConfig;
  readonly discord: Client;
  readonly pool: Pool;
  readonly queue: { waitUntilReady(): Promise<unknown> };
  readonly runtime: SubscriptionRuntimeSummaryAdapter;
  readonly s3: S3Client;
}): readonly HealthProbe[] {
  return [
    probe("database", true, async () => {
      await input.pool.query("SELECT 1");
    }),
    probe("discord", true, async () => {
      if (!input.discord.isReady()) {
        throw new Error("Discord client is not ready");
      }
    }),
    probe("object-storage", true, async () => {
      await input.s3.send(new HeadBucketCommand({ Bucket: input.config.s3.bucket }));
    }),
    probe("queue", true, async () => input.queue.waitUntilReady()),
    createTranscriptionHealthProbe(input.config),
    {
      check: async () => {
        const result = await input.runtime.checkHealth();
        return {
          code: result.status === "serving" ? "SERVING" : "NOT_SERVING",
          status: result.status === "serving" ? "healthy" : "unhealthy",
        };
      },
      critical: true,
      name: "summary-provider",
    },
  ];
}

function createTranscriptionHealthProbe(config: PlatformConfig): HealthProbe {
  if (config.transcriptionProvider === "speaches") {
    return probe("stt", true, async (signal) => {
      const response = await fetch(new URL("/v1/models", config.speaches.baseUrl), { signal });
      await response.body?.cancel();
      if (!response.ok) {
        throw new Error("STT dependency is not ready");
      }
    });
  }
  return probe("stt", true, async (signal) => {
    const response = await fetch(voicetextHealthUrl(config), { signal });
    const body = await response.json();
    if (!response.ok || !isVoicetextHealthy(body)) {
      throw new Error("STT dependency is not ready");
    }
  });
}

function isVoicetextHealthy(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && "status" in value
    && value.status === "ok";
}

function voicetextHealthUrl(config: PlatformConfig): URL {
  if (config.voicetext === undefined) {
    throw new Error("Voicetext transcription configuration is incomplete");
  }
  const endpoint = new URL(config.voicetext.webSocketUrl);
  endpoint.protocol = "https:";
  endpoint.pathname = "/health";
  return endpoint;
}

function probe(
  name: string,
  critical: boolean,
  check: (signal: AbortSignal) => Promise<unknown>,
): HealthProbe {
  return {
    check: async (signal) => {
      await check(signal);
      return { status: "healthy" };
    },
    critical,
    name,
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

export async function closeMeetingPlatformResources(input: {
  readonly deadLetterQueue: { close(): Promise<void> };
  readonly discord: Client;
  readonly guildSetupHandler?: DiscordGuildSetupCommandHandler;
  readonly logger: Logger;
  readonly live?: PlatformLiveMeetingRuntime;
  readonly pool: Pool;
  readonly queue: { close(): Promise<void> };
  readonly queueEvents: { close(): Promise<void> };
  readonly runtimeTransport: GrpcSubscriptionRuntimeTransport;
  readonly s3: S3Client;
  readonly server: Server;
  readonly worker: PostCallWorker;
}): Promise<void> {
  const failures: unknown[] = [];
  const settle = async (operation: Promise<unknown>): Promise<void> => {
    try {
      await operation;
    } catch (error) {
      failures.push(error);
    }
  };

  // `drainActivePostCallJobsAndClose` synchronously closes worker admission
  // before its first await. Start it before any potentially slow HTTP or live
  // drain so SIGTERM cannot leave an active final job uncancelled. The live
  // runtime remains available while it settles, preserving the final-publication
  // fence for work that already crossed into publication.
  const postCallShutdown = drainActivePostCallJobsAndClose({
    queueEvents: input.queueEvents,
    queues: [input.queue, input.deadLetterQueue],
    worker: input.worker,
  });
  const serverClose = closeServer(input.server);
  input.guildSetupHandler?.close();
  const liveClose = input.live?.close() ?? Promise.resolve();
  await Promise.all([
    settle(postCallShutdown),
    settle(serverClose),
    settle(liveClose),
  ]);
  await settle(Promise.resolve(input.discord.destroy()));
  input.runtimeTransport.close();
  input.s3.destroy();
  await settle(input.pool.end());
  await settle(flushLoggers([input.logger]));
  if (failures.length > 0) {
    throw new AggregateError(failures, "Meeting platform shutdown was incomplete");
  }
}
