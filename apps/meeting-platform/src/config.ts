import { lstat, readFile } from "node:fs/promises";

import { z } from "zod";

const snowflake = z.string().regex(/^\d{17,20}$/u);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const mebibyte = 1_024 * 1_024;
const defaultVoicetextBatchMaxArtifactBytes = 64 * mebibyte;
// Voicetext batch-v2 rejects bodies above this fixed contract maximum.
const maximumVoicetextBatchMaxArtifactBytes = 64 * mebibyte;
const absolutePath = z.string().startsWith("/").refine((value) => !value.includes("\0"));
const httpUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    ["http:", "https:"].includes(url.protocol) &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
  );
});
const secureWebSocketUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "wss:" &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
  );
});

const environmentSchema = z
  .object({
    BIND_ADDRESS: z.union([z.ipv4(), z.ipv6()]).default("0.0.0.0"),
    CRAIG_BEARER_TOKEN_FILE: absolutePath,
    DISCORD_PUBLICATION_MODE: z.enum(["message", "thread"]).default("message"),
    DISCORD_RESULTS_CHANNEL_ID: snowflake,
    DISCORD_TOKEN_FILE: absolutePath,
    NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4_310),
    POSTGRES_URL_FILE: absolutePath,
    RECORDING_SPOOL_ROOT: absolutePath,
    REDIS_URL_FILE: absolutePath,
    S3_ACCESS_KEY_ID_FILE: absolutePath,
    S3_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u),
    S3_ENDPOINT: httpUrl,
    S3_PREFIX: z.string().max(512).regex(/^[a-zA-Z0-9][a-zA-Z0-9/_-]*\/$/u),
    S3_REGION: z.string().min(1).max(64),
    S3_SECRET_ACCESS_KEY_FILE: absolutePath,
    SPEACHES_BASE_URL: httpUrl,
    SPEACHES_MODEL: z.string().min(1).max(256),
    SUBSCRIPTION_RUNTIME_ADDRESS: z
      .string()
      .regex(/^(?:[a-zA-Z0-9][a-zA-Z0-9.-]*|\[[0-9a-fA-F:]+\]):\d{1,5}$/u),
    SUBSCRIPTION_RUNTIME_LAUNCHER_SHA256: sha256,
    SUBSCRIPTION_RUNTIME_TOKEN_FILE: absolutePath,
    TRANSCRIPTION_PROVIDER: z.enum(["speaches", "voicetext"]).default("speaches"),
    VOICETEXT_BATCH_MAX_ARTIFACT_BYTES: z.coerce.number()
      .int()
      .min(27)
      .max(maximumVoicetextBatchMaxArtifactBytes)
      .default(defaultVoicetextBatchMaxArtifactBytes),
    VOICETEXT_SERVICE_TOKEN_FILE: absolutePath.optional(),
    VOICETEXT_WS_URL: secureWebSocketUrl.optional(),
  })
  .superRefine((environment, context) => {
    if (environment.TRANSCRIPTION_PROVIDER !== "voicetext") {
      return;
    }
    if (environment.VOICETEXT_SERVICE_TOKEN_FILE === undefined) {
      context.addIssue({
        code: "custom",
        message: "VOICETEXT_SERVICE_TOKEN_FILE is required for Voicetext transcription",
        path: ["VOICETEXT_SERVICE_TOKEN_FILE"],
      });
    }
    if (environment.VOICETEXT_WS_URL === undefined) {
      context.addIssue({
        code: "custom",
        message: "VOICETEXT_WS_URL is required for Voicetext transcription",
        path: ["VOICETEXT_WS_URL"],
      });
    }
  });

interface PlatformSecrets {
  readonly craigBearerToken: string;
  readonly discordToken: string;
  readonly postgresUrl: string;
  readonly redisUrl: string;
  readonly s3AccessKeyId: string;
  readonly s3SecretAccessKey: string;
  readonly subscriptionRuntimeToken: string;
  readonly voicetextServiceToken?: string;
}

export interface PlatformConfig {
  readonly bindAddress: string;
  /** New meetings publish directly into the configured results channel by default. */
  readonly discordPublicationMode: "message" | "thread";
  readonly discordResultsChannelId: string;
  readonly nodeEnvironment: "development" | "production" | "test";
  readonly port: number;
  readonly recordingSpoolRoot: string;
  readonly s3: {
    readonly bucket: string;
    readonly endpoint: string;
    readonly prefix: string;
    readonly region: string;
  };
  readonly secrets: PlatformSecrets;
  readonly speaches: { readonly baseUrl: string; readonly model: string };
  readonly transcriptionProvider: "speaches" | "voicetext";
  readonly subscriptionRuntime: {
    readonly address: string;
    readonly launcherSha256: string;
  };
  readonly voicetext?: {
    readonly batchMaxArtifactBytes: number;
    readonly webSocketUrl: string;
  };
}

export type SecretFileReader = (path: string) => Promise<string>;

export async function loadPlatformConfig(
  rawEnvironment: Readonly<Record<string, string | undefined>> = process.env,
  readSecret: SecretFileReader = readSecretFile,
): Promise<PlatformConfig> {
  const forbiddenApiKey = Object.keys(rawEnvironment).find((key) =>
    /_API_KEY(?:_FILE)?$/u.test(key),
  );
  if (forbiddenApiKey !== undefined) {
    throw new Error(`API-key environment is forbidden: ${forbiddenApiKey}`);
  }
  const environment = environmentSchema.parse(rawEnvironment);
  const [
    craigBearerToken,
    discordToken,
    postgresUrl,
    redisUrl,
    s3AccessKeyId,
    s3SecretAccessKey,
    subscriptionRuntimeToken,
    voicetextServiceToken,
  ] = await Promise.all([
    readSecret(environment.CRAIG_BEARER_TOKEN_FILE),
    readSecret(environment.DISCORD_TOKEN_FILE),
    readSecret(environment.POSTGRES_URL_FILE),
    readSecret(environment.REDIS_URL_FILE),
    readSecret(environment.S3_ACCESS_KEY_ID_FILE),
    readSecret(environment.S3_SECRET_ACCESS_KEY_FILE),
    readSecret(environment.SUBSCRIPTION_RUNTIME_TOKEN_FILE),
    environment.VOICETEXT_SERVICE_TOKEN_FILE === undefined
      ? Promise.resolve()
      : readSecret(environment.VOICETEXT_SERVICE_TOKEN_FILE),
  ]);

  return Object.freeze({
    bindAddress: environment.BIND_ADDRESS,
    discordPublicationMode: environment.DISCORD_PUBLICATION_MODE,
    discordResultsChannelId: environment.DISCORD_RESULTS_CHANNEL_ID,
    nodeEnvironment: environment.NODE_ENV,
    port: environment.PORT,
    recordingSpoolRoot: environment.RECORDING_SPOOL_ROOT,
    s3: {
      bucket: environment.S3_BUCKET,
      endpoint: environment.S3_ENDPOINT,
      prefix: environment.S3_PREFIX,
      region: environment.S3_REGION,
    },
    secrets: Object.freeze({
      craigBearerToken,
      discordToken,
      postgresUrl,
      redisUrl,
      s3AccessKeyId,
      s3SecretAccessKey,
      subscriptionRuntimeToken,
      ...(voicetextServiceToken === undefined ? {} : { voicetextServiceToken }),
    }),
    speaches: {
      baseUrl: environment.SPEACHES_BASE_URL,
      model: environment.SPEACHES_MODEL,
    },
    subscriptionRuntime: {
      address: environment.SUBSCRIPTION_RUNTIME_ADDRESS,
      launcherSha256: environment.SUBSCRIPTION_RUNTIME_LAUNCHER_SHA256,
    },
    transcriptionProvider: environment.TRANSCRIPTION_PROVIDER,
    ...(environment.VOICETEXT_WS_URL === undefined
      ? {}
      : {
          voicetext: {
            batchMaxArtifactBytes: environment.VOICETEXT_BATCH_MAX_ARTIFACT_BYTES,
            webSocketUrl: environment.VOICETEXT_WS_URL,
          },
        }),
  });
}

async function readSecretFile(path: string): Promise<string> {
  const descriptor = await lstat(path);
  if (!descriptor.isFile() || descriptor.isSymbolicLink() || descriptor.size > 65_536) {
    throw new Error("Secret path must be a small regular non-symlink file");
  }
  const value = (await readFile(path, "utf8")).trim();
  if (value.length === 0 || value.includes("\0")) {
    throw new Error("Secret file must contain a non-empty text value");
  }
  return value;
}
