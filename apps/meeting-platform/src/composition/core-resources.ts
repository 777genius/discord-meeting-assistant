import { S3Client } from "@aws-sdk/client-s3";
import type { ConnectionOptions } from "bullmq";
import { ResolveMeetingPublicationTarget } from "@discord-meeting/meeting-routing-core";
import {
  type SummaryGenerationPort,
} from "@discord-meeting/meeting-core/meeting-intelligence";
import {
  type FinalTranscriptionPort,
} from "@discord-meeting/meeting-core/transcription";
import {
  createS3BinaryArtifactReader,
  createS3BinaryArtifactWriter,
} from "@discord-meeting/object-storage-adapter";
import type { Logger, PrometheusMetrics } from "@discord-meeting/observability-adapter";
import {
  PostgresMeetingSourceConfigurationRepository,
  PostgresLiveMeetingRepository,
  type PostgresMeetingRepository,
  PostgresSummaryPublicationEffectLedger,
  PostgresTranscriptionExecutionBindingStore,
} from "@discord-meeting/postgres-adapter";
import { DurableCraigRecordingIngress } from "@discord-meeting/recording-ingress-adapter";
import {
  SubscriptionRuntimeSummaryAdapter,
  subscriptionRuntimeCliEngine,
  subscriptionRuntimeSummaryMaxOutputTokens,
} from "@discord-meeting/subscription-runtime-adapter";
import { Pool } from "pg";

import { InstrumentedSubscriptionRuntimeTransport } from "../adapters/outbound/instrumented-subscription-runtime-transport.js";
import { CraigRecordingIngressAdapter } from "../adapters/outbound/craig-recording-ingress-adapter.js";
import { DiscordPublicationTargetResolver } from "../adapters/outbound/discord-publication-target-resolver.js";
import { GrpcSubscriptionRuntimeTransport } from "../adapters/outbound/subscription-runtime-grpc-transport.js";
import {
  TranscriptOutlineSummaryAdapter,
  type SummaryProviderHealth,
} from "../adapters/outbound/transcript-outline-summary-adapter.js";
import { VerifiedRecordingRepository } from "../adapters/recording-compatibility/verified-recording-repository.js";
import type { RecordingDurabilityPort } from "../application/recording-ingress.js";
import type { PlatformConfig } from "../config.js";
import type { PlatformStartupCleanup } from "./startup-cleanup.js";
import { meetingVocabulary } from "./meeting-vocabulary.js";
import {
  createFinalTranscriber,
  legacyFinalTranscriptionExecutionBinding,
  selectedFinalTranscriptionExecutionBinding,
  supportedFinalTranscriptionExecutionBindings,
  type FinalTranscriptionExecutionBinding,
} from "./transcription.js";

const postgresPoolConnectionTimeoutMillis = 5_000;

export interface PlatformCoreResources {
  readonly connection: ConnectionOptions;
  readonly sourceConfigurations: PostgresMeetingSourceConfigurationRepository;
  readonly liveMeetings: PostgresLiveMeetingRepository;
  readonly meetings: PostgresMeetingRepository;
  readonly pool: Pool;
  readonly publicationTargets: DiscordPublicationTargetResolver;
  readonly publicationEffects: PostgresSummaryPublicationEffectLedger;
  readonly rawSummarizer: SummaryGenerationPort & {
    checkHealth(): Promise<SummaryProviderHealth>;
  };
  readonly rawTranscriber: FinalTranscriptionPort;
  readonly legacyTranscriptionExecutionBinding: FinalTranscriptionExecutionBinding;
  readonly selectedTranscriptionExecutionBinding: FinalTranscriptionExecutionBinding;
  readonly supportedTranscriptionExecutionBindings: ReadonlySet<FinalTranscriptionExecutionBinding>;
  readonly transcriptionExecutionBindings: PostgresTranscriptionExecutionBindingStore;
  readonly recordingIngress: RecordingDurabilityPort;
  readonly recordings: DurableCraigRecordingIngress;
  readonly subscriptionRuntime?: PlatformSubscriptionRuntimeResources;
  readonly s3: S3Client;
}

export interface PlatformSubscriptionRuntimeResources {
  readonly rawTransport: GrpcSubscriptionRuntimeTransport;
  readonly transport: InstrumentedSubscriptionRuntimeTransport;
}

export function createPlatformCoreResources(input: {
  readonly cleanup: PlatformStartupCleanup;
  readonly config: PlatformConfig;
  readonly logger: Logger;
  readonly metrics: PrometheusMetrics;
}): PlatformCoreResources {
  const pool = new Pool({
    connectionString: input.config.secrets.postgresUrl,
    connectionTimeoutMillis: postgresPoolConnectionTimeoutMillis,
  });
  input.cleanup.defer("PostgreSQL pool", () => pool.end());
  const s3 = new S3Client(s3ClientOptions(input.config));
  input.cleanup.defer("S3 client", () => {
    s3.destroy();
  });
  const accessPolicy = {
    bucket: input.config.s3.bucket,
    keyPrefix: input.config.s3.prefix,
  } as const;
  const artifactReader = createS3BinaryArtifactReader(s3, { accessPolicy });
  const artifactWriter = createS3BinaryArtifactWriter(s3, { accessPolicy });
  const recordings = new DurableCraigRecordingIngress({
    artifactLocatorPrefix: `s3://${input.config.s3.bucket}/${input.config.s3.prefix.slice(0, -1)}`,
    spoolRoot: input.config.recordingSpoolRoot,
    writer: artifactWriter,
  });
  input.cleanup.defer("recording ingress spool", () => recordings.close());
  const meetings = new VerifiedRecordingRepository(pool, {
    artifacts: artifactReader,
    completedRecording: (recordingId) => recordings.completedRecording(recordingId),
    onVerified: (evidence) => input.logger.info("Verified legacy recording identity", evidence),
  });
  const transcriptionExecutionBindings = new PostgresTranscriptionExecutionBindingStore(pool);
  const sourceConfigurations = new PostgresMeetingSourceConfigurationRepository(pool);
  const publicationTargets = new DiscordPublicationTargetResolver(
    new ResolveMeetingPublicationTarget(sourceConfigurations),
    input.config.discordLegacyRoute,
  );
  const subscriptionRuntime = createPlatformSubscriptionRuntimeResources(
    input.config,
    input.logger,
  );
  if (subscriptionRuntime !== undefined) {
    input.cleanup.defer("subscription runtime transport", () => {
      subscriptionRuntime.rawTransport.close();
    });
  }
  return {
    connection: redisConnection(input.config.secrets.redisUrl),
    sourceConfigurations,
    liveMeetings: new PostgresLiveMeetingRepository(pool),
    meetings,
    pool,
    publicationTargets,
    publicationEffects: new PostgresSummaryPublicationEffectLedger(pool),
    rawSummarizer: input.config.summaryProvider === "subscription-runtime"
      ? new SubscriptionRuntimeSummaryAdapter(
          requirePlatformSubscriptionRuntime(subscriptionRuntime).transport,
          {
          expectedLauncherSha256: requireSubscriptionRuntimeConfig(input.config)
            .launcherSha256,
          expectedRuntimeEngine: subscriptionRuntimeCliEngine,
          maxOutputTokens: subscriptionRuntimeSummaryMaxOutputTokens,
          technicalVocabulary: meetingVocabulary,
        })
      : new TranscriptOutlineSummaryAdapter(),
    rawTranscriber: createFinalTranscriber(
      input.config,
      artifactReader,
      transcriptionExecutionBindings,
    ),
    recordingIngress: new CraigRecordingIngressAdapter(recordings),
    recordings,
    ...(subscriptionRuntime === undefined ? {} : { subscriptionRuntime }),
    s3,
    legacyTranscriptionExecutionBinding: legacyFinalTranscriptionExecutionBinding(input.config),
    selectedTranscriptionExecutionBinding: selectedFinalTranscriptionExecutionBinding(input.config),
    supportedTranscriptionExecutionBindings: supportedFinalTranscriptionExecutionBindings(input.config),
    transcriptionExecutionBindings,
  };
}

export function createPlatformSubscriptionRuntimeResources(
  config: PlatformConfig,
  logger: Logger,
): PlatformSubscriptionRuntimeResources | undefined {
  const runtimeConfig = config.subscriptionRuntime;
  const serviceToken = config.secrets.subscriptionRuntimeToken;
  if (runtimeConfig === undefined && serviceToken === undefined) {
    return undefined;
  }
  if (runtimeConfig === undefined || serviceToken === undefined) {
    throw new Error("Subscription Runtime configuration must be complete when enabled");
  }
  const rawTransport = new GrpcSubscriptionRuntimeTransport({
    address: runtimeConfig.address,
    serviceToken,
  });
  return {
    rawTransport,
    transport: new InstrumentedSubscriptionRuntimeTransport(
      rawTransport,
      logger,
      () => performance.now(),
    ),
  };
}

function requirePlatformSubscriptionRuntime(
  runtime: PlatformSubscriptionRuntimeResources | undefined,
): PlatformSubscriptionRuntimeResources {
  if (runtime === undefined) {
    throw new Error("Subscription Runtime is required for this enabled feature");
  }
  return runtime;
}

function requireSubscriptionRuntimeConfig(
  config: PlatformConfig,
): NonNullable<PlatformConfig["subscriptionRuntime"]> {
  if (config.subscriptionRuntime === undefined) {
    throw new Error("Subscription Runtime configuration is missing");
  }
  return config.subscriptionRuntime;
}

function s3ClientOptions(config: PlatformConfig) {
  return {
    credentials: {
      accessKeyId: config.secrets.s3AccessKeyId,
      secretAccessKey: config.secrets.s3SecretAccessKey,
    },
    endpoint: config.s3.endpoint,
    forcePathStyle: true,
    region: config.s3.region,
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
    password:
      url.password.length === 0 ? undefined : decodeURIComponent(url.password),
    port: url.port.length === 0 ? 6_379 : Number(url.port),
    tls: url.protocol === "rediss:" ? {} : undefined,
    username:
      url.username.length === 0 ? undefined : decodeURIComponent(url.username),
  };
}
