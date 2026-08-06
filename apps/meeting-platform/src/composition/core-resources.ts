import { S3Client } from "@aws-sdk/client-s3";
import type { ConnectionOptions } from "bullmq";
import { ResolveGuildMeetingTarget } from "@discord-meeting/guild-configuration-core";
import {
  type FinalTranscriptionPort,
} from "@discord-meeting/meeting-core/transcription";
import {
  createS3BinaryArtifactReader,
  createS3BinaryArtifactWriter,
} from "@discord-meeting/object-storage-adapter";
import type { Logger, PrometheusMetrics } from "@discord-meeting/observability-adapter";
import {
  PostgresGuildConfigurationRepository,
  PostgresLiveMeetingRepository,
  PostgresMeetingRepository,
  PostgresSummaryPublicationEffectLedger,
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
import type { RecordingDurabilityPort } from "../application/recording-ingress.js";
import type { PlatformConfig } from "../config.js";
import type { PlatformStartupCleanup } from "./startup-cleanup.js";
import { createFinalTranscriber } from "./transcription.js";

export interface PlatformCoreResources {
  readonly connection: ConnectionOptions;
  readonly guildConfigurations: PostgresGuildConfigurationRepository;
  readonly liveMeetings: PostgresLiveMeetingRepository;
  readonly meetings: PostgresMeetingRepository;
  readonly pool: Pool;
  readonly publicationTargets: DiscordPublicationTargetResolver;
  readonly publicationEffects: PostgresSummaryPublicationEffectLedger;
  readonly rawRuntimeTransport: GrpcSubscriptionRuntimeTransport;
  readonly rawSummarizer: SubscriptionRuntimeSummaryAdapter;
  readonly rawTranscriber: FinalTranscriptionPort;
  readonly recordingIngress: RecordingDurabilityPort;
  readonly recordings: DurableCraigRecordingIngress;
  readonly runtimeTransport: InstrumentedSubscriptionRuntimeTransport;
  readonly s3: S3Client;
}

export function createPlatformCoreResources(input: {
  readonly cleanup: PlatformStartupCleanup;
  readonly config: PlatformConfig;
  readonly logger: Logger;
  readonly metrics: PrometheusMetrics;
}): PlatformCoreResources {
  const pool = new Pool({ connectionString: input.config.secrets.postgresUrl });
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
  const meetings = new PostgresMeetingRepository(pool);
  const guildConfigurations = new PostgresGuildConfigurationRepository(pool);
  const publicationTargets = new DiscordPublicationTargetResolver(
    new ResolveGuildMeetingTarget(guildConfigurations),
    input.config.discordLegacyRoute,
  );
  const rawRuntimeTransport = new GrpcSubscriptionRuntimeTransport({
    address: input.config.subscriptionRuntime.address,
    serviceToken: input.config.secrets.subscriptionRuntimeToken,
  });
  input.cleanup.defer("subscription runtime transport", () => {
    rawRuntimeTransport.close();
  });
  const runtimeTransport = new InstrumentedSubscriptionRuntimeTransport(
    rawRuntimeTransport,
    input.logger,
    () => performance.now(),
  );
  return {
    connection: redisConnection(input.config.secrets.redisUrl),
    guildConfigurations,
    liveMeetings: new PostgresLiveMeetingRepository(pool),
    meetings,
    pool,
    publicationTargets,
    publicationEffects: new PostgresSummaryPublicationEffectLedger(pool),
    rawRuntimeTransport,
    rawSummarizer: new SubscriptionRuntimeSummaryAdapter(runtimeTransport, {
      expectedLauncherSha256: input.config.subscriptionRuntime.launcherSha256,
      expectedRuntimeEngine: subscriptionRuntimeCliEngine,
      maxOutputTokens: subscriptionRuntimeSummaryMaxOutputTokens,
      outputLanguage: "Natural English; preserve technical terms exactly",
    }),
    rawTranscriber: createFinalTranscriber(input.config, artifactReader),
    recordingIngress: new CraigRecordingIngressAdapter(recordings),
    recordings,
    runtimeTransport,
    s3,
  };
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
