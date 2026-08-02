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
} from "@discord-meeting/bullmq-adapter";
import {
  DiscordJsProjectionClient,
  DiscordSummaryPublicationAdapter,
  DiscordSummaryPublisher,
  InProcessProjectionLock,
} from "@discord-meeting/discord-adapter";
import {
  ProcessMeetingSummary,
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
import { PostgresMeetingRepository } from "@discord-meeting/postgres-adapter";
import {
  DurableCraigRecordingIngress,
  RecordingIngressError,
} from "@discord-meeting/recording-ingress-adapter";
import {
  FetchSpeachesTranscriptionClient,
  SpeachesFinalTranscriptionAdapter,
} from "@discord-meeting/speaches-adapter";
import { SubscriptionRuntimeSummaryAdapter } from "@discord-meeting/subscription-runtime-adapter";
import {
  FfmpegPcmTranscoder,
  VoicetextFinalTranscriptionAdapter,
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
  const rawTranscriber = createFinalTranscriber(config, artifactReader);
  const runtimeTransport = new GrpcSubscriptionRuntimeTransport({
    address: config.subscriptionRuntime.address,
    serviceToken: config.secrets.subscriptionRuntimeToken,
  });
  const rawSummarizer = new SubscriptionRuntimeSummaryAdapter(runtimeTransport, {
    expectedLauncherSha256: config.subscriptionRuntime.launcherSha256,
    outputLanguage: "Russian; preserve English technical terms",
  });
  const discord = new Client({ intents: [GatewayIntentBits.Guilds] });
  const rawPublisher = new DiscordSummaryPublicationAdapter(
    new DiscordSummaryPublisher(
      new DiscordJsProjectionClient(discord),
      new InProcessProjectionLock(),
    ),
  );
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
  const publisher = new InstrumentedSummaryPublicationPort(
    rawPublisher,
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
    handler: async ({ meetingId }) => {
      const result = await processMeeting.execute(meetingId);
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
    logger,
    outbox: meetings,
    metrics,
    publicationTargetId: config.discordResultsChannelId,
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
    health: {
      metrics: () => metrics.render(),
      readiness: async () => ({ ready: (await health.snapshot()).ready }),
    },
    ingress,
    onInternalError: (error) => {
      logger.error("Craig ingress request failed", classifyCraigIngressError(error));
    },
  });

  try {
    await Promise.all([pool.query("SELECT 1"), queue.waitUntilReady(), queueEvents.waitUntilReady()]);
    await outboxDispatcher.dispatchPending();
    const ready = once(discord, "ready");
    await discord.login(config.secrets.discordToken);
    if (!discord.isReady()) {
      await ready;
    }
    server.listen(config.port, config.bindAddress);
    await once(server, "listening");
    logger.info("Meeting platform is ready", { port: config.port });
  } catch (error) {
    await closeResources({
      discord,
      logger,
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
      closing ??= closeResources({
        discord,
        logger,
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

function createFinalTranscriber(
  config: PlatformConfig,
  artifactReader: ReturnType<typeof createS3BinaryArtifactReader>,
): FinalTranscriptionPort {
  const vocabulary = [
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
  if (config.transcriptionProvider === "speaches") {
    return new SpeachesFinalTranscriptionAdapter(
      new FetchSpeachesTranscriptionClient(config.speaches.baseUrl),
      new S3OggAudioArtifactReader(artifactReader),
      {
        language: "ru",
        maxBytesPerSpeaker: 64 * 1_024 * 1_024,
        maxSpeakerTracks: 64,
        model: config.speaches.model,
        vocabulary,
      },
    );
  }
  if (config.voicetext === undefined || config.secrets.voicetextServiceToken === undefined) {
    throw new Error("Voicetext transcription configuration is incomplete");
  }
  return new VoicetextFinalTranscriptionAdapter(
    new S3CompleteOggArtifactReader(artifactReader),
    new FfmpegPcmTranscoder({ executablePath: "/usr/bin/ffmpeg", timeoutMs: 900_000 }),
    {
      endpoint: config.voicetext.webSocketUrl,
      keyterms: vocabulary,
      language: "multi",
      maxArtifactBytesPerSpeaker: 256 * 1_024 * 1_024,
      maxPcmBytesPerSpeaker: 512 * 1_024 * 1_024,
      maxSpeakerTracks: 64,
      token: config.secrets.voicetextServiceToken,
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

async function closeResources(input: {
  readonly deadLetterQueue: { close(): Promise<void> };
  readonly discord: Client;
  readonly logger: Logger;
  readonly pool: Pool;
  readonly queue: { close(): Promise<void> };
  readonly queueEvents: { close(): Promise<void> };
  readonly runtimeTransport: GrpcSubscriptionRuntimeTransport;
  readonly s3: S3Client;
  readonly server: Server;
  readonly worker: { close(force?: boolean): Promise<void> };
}): Promise<void> {
  const failures: unknown[] = [];
  const settle = async (operation: () => unknown): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  };
  await settle(async () => closeServer(input.server));
  await settle(async () =>
    drainActivePostCallJobsAndClose({
      queueEvents: input.queueEvents,
      queues: [input.queue, input.deadLetterQueue],
      worker: input.worker,
    }),
  );
  await settle(async () => input.discord.destroy());
  input.runtimeTransport.close();
  input.s3.destroy();
  await settle(async () => input.pool.end());
  await settle(async () => flushLoggers([input.logger]));
  if (failures.length > 0) {
    throw new AggregateError(failures, "Meeting platform shutdown was incomplete");
  }
}
