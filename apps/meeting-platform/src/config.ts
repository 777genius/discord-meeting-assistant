import { z } from "zod";

import {
  loadRecordingPlaybackConfig,
  recordingPlaybackEnvironmentShape,
  validateRecordingPlaybackEnvironment,
} from "./config/recording-playback-config.js";
import { readSecretFile } from "./config/secret-file-reader.js";

const snowflake = z.string().regex(/^\d{17,20}$/u);
const optionalSnowflake = z.preprocess(
  (value) => (value === "" ? undefined : value),
  snowflake.optional(),
);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const mebibyte = 1_024 * 1_024;
const defaultVoicetextBatchMaxArtifactBytes = 64 * mebibyte;
const defaultVoicetextBatchMaxConcurrency = 2;
const defaultVoicetextBatchMaxConcurrentMeetings = 1;
const defaultVoicetextLiveMaxConcurrentSessions = 3;
const defaultVoicetextLivePacketBackpressureTimeoutMs = 2_000;
// Voicetext batch-v2 rejects bodies above this fixed contract maximum.
const maximumVoicetextBatchMaxArtifactBytes = 64 * mebibyte;
const maximumVoicetextBatchMaxConcurrency = 10;
// Two is an explicit scale-up option; the production 2 GiB container admits one.
const maximumVoicetextBatchMaxConcurrentMeetings = 2;
const maximumVoicetextLiveMaxConcurrentSessions = 10;
const maximumVoicetextLivePacketBackpressureTimeoutMs = 30_000;
const defaultConversationThinkingCueRoot =
  "/app/apps/meeting-platform/assets/thinking-cues";
const absolutePath = z
  .string()
  .startsWith("/")
  .refine((value) => !value.includes("\0"));
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
const runtimeAddress = z
  .string()
  .regex(/^(?:[a-zA-Z0-9][a-zA-Z0-9.-]*|\[[0-9a-fA-F:]+\]):\d{1,5}$/u);
const profileIdentifier = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u);
const voiceIdentifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);

const environmentSchema = z
  .object({
    BIND_ADDRESS: z.union([z.ipv4(), z.ipv6()]).default("0.0.0.0"),
    CONVERSATION_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    CONVERSATION_RUNTIME_ADDRESS: runtimeAddress.optional(),
    CONVERSATION_RUNTIME_TOKEN_FILE: absolutePath.optional(),
    CONVERSATION_THINKING_CUE_ROOT: absolutePath.optional(),
    CONVERSATION_VOICE_ID: voiceIdentifier.default("jqcCZkN6Knx8BJ5TBdYR"),
    CONVERSATION_SYSTEM_PROMPT: z
      .string()
      .trim()
      .min(1)
      .max(4_000)
      .default(
        "You are Botik, a concise voice assistant. Answer in the participant's language. When that language uses grammatical gender, refer to yourself using feminine forms. Never claim to remember earlier turns.",
      ),
    CONVERSATION_VOICE_PROFILE_ID: profileIdentifier.default("deterministic-e2e-ru"),
    CRAIG_BEARER_TOKEN_FILE: absolutePath,
    DISCORD_APPLICATION_ID: snowflake,
    DISCORD_CRAIG_APPLICATION_ID: snowflake,
    DISCORD_LEGACY_GUILD_ID: optionalSnowflake,
    DISCORD_LEGACY_VOICE_CHANNEL_ID: optionalSnowflake,
    DISCORD_FINAL_PUBLICATION_MODE: z
      .enum(["separate-message", "replace-live"])
      .default("separate-message"),
    DISCORD_PUBLICATION_MODE: z.enum(["message", "thread"]).default("message"),
    DISCORD_RESULTS_CHANNEL_ID: optionalSnowflake,
    DISCORD_TOKEN_FILE: absolutePath,
    LIVE_INGRESS_OWNER_MODE: z.literal("singleton").default("singleton"),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("production"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4_310),
    POSTGRES_URL_FILE: absolutePath,
    RECORDING_SPOOL_ROOT: absolutePath,
    REDIS_URL_FILE: absolutePath,
    ...recordingPlaybackEnvironmentShape,
    S3_ACCESS_KEY_ID_FILE: absolutePath,
    S3_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u),
    S3_ENDPOINT: httpUrl,
    S3_PREFIX: z
      .string()
      .max(512)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9/_-]*\/$/u),
    S3_REGION: z.string().min(1).max(64),
    S3_SECRET_ACCESS_KEY_FILE: absolutePath,
    SPEACHES_BASE_URL: httpUrl,
    SPEACHES_MODEL: z.string().min(1).max(256),
    SUBSCRIPTION_RUNTIME_ADDRESS: runtimeAddress,
    SUBSCRIPTION_RUNTIME_LAUNCHER_SHA256: sha256,
    SUBSCRIPTION_RUNTIME_TOKEN_FILE: absolutePath,
    TRANSCRIPTION_PROVIDER: z
      .enum(["speaches", "voicetext"])
      .default("speaches"),
    VOICETEXT_BATCH_MAX_ARTIFACT_BYTES: z.coerce
      .number()
      .int()
      .min(27)
      .max(maximumVoicetextBatchMaxArtifactBytes)
      .default(defaultVoicetextBatchMaxArtifactBytes),
    VOICETEXT_BATCH_MAX_CONCURRENCY: z.coerce
      .number()
      .int()
      .min(1)
      .max(maximumVoicetextBatchMaxConcurrency)
      .default(defaultVoicetextBatchMaxConcurrency),
    VOICETEXT_BATCH_MAX_CONCURRENT_MEETINGS: z.coerce
      .number()
      .int()
      .min(1)
      .max(maximumVoicetextBatchMaxConcurrentMeetings)
      .default(defaultVoicetextBatchMaxConcurrentMeetings),
    VOICETEXT_LIVE_MAX_CONCURRENT_SESSIONS: z.coerce
      .number()
      .int()
      .min(1)
      .max(maximumVoicetextLiveMaxConcurrentSessions)
      .default(defaultVoicetextLiveMaxConcurrentSessions),
    VOICETEXT_LIVE_PACKET_BACKPRESSURE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(maximumVoicetextLivePacketBackpressureTimeoutMs)
      .default(defaultVoicetextLivePacketBackpressureTimeoutMs),
    VOICETEXT_SERVICE_TOKEN_FILE: absolutePath.optional(),
    VOICETEXT_WS_URL: secureWebSocketUrl.optional(),
  })
  .superRefine((environment, context) => {
    if (environment.CONVERSATION_ENABLED) {
      if (environment.TRANSCRIPTION_PROVIDER !== "voicetext") {
        context.addIssue({
          code: "custom",
          message: "live conversation requires Voicetext streaming transcription",
          path: ["TRANSCRIPTION_PROVIDER"],
        });
      }
      if (environment.CONVERSATION_RUNTIME_ADDRESS === undefined) {
        context.addIssue({
          code: "custom",
          message: "CONVERSATION_RUNTIME_ADDRESS is required when conversation is enabled",
          path: ["CONVERSATION_RUNTIME_ADDRESS"],
        });
      }
      if (environment.CONVERSATION_RUNTIME_TOKEN_FILE === undefined) {
        context.addIssue({
          code: "custom",
          message: "CONVERSATION_RUNTIME_TOKEN_FILE is required when conversation is enabled",
          path: ["CONVERSATION_RUNTIME_TOKEN_FILE"],
        });
      }
      if (
        environment.NODE_ENV === "production" &&
        environment.CONVERSATION_VOICE_PROFILE_ID.startsWith("deterministic-e2e")
      ) {
        context.addIssue({
          code: "custom",
          message: "deterministic E2E voice profiles are forbidden in production",
          path: ["CONVERSATION_VOICE_PROFILE_ID"],
        });
      }
    }
    const legacyRouteParts = [
      environment.DISCORD_LEGACY_GUILD_ID,
      environment.DISCORD_LEGACY_VOICE_CHANNEL_ID,
      environment.DISCORD_RESULTS_CHANNEL_ID,
    ].filter((value) => value !== undefined).length;
    if (legacyRouteParts !== 0 && legacyRouteParts !== 3) {
      context.addIssue({
        code: "custom",
        message:
          "legacy Discord guild, voice channel and results channel must be configured together",
        path: ["DISCORD_LEGACY_GUILD_ID"],
      });
    }
    validateRecordingPlaybackEnvironment(environment, context);
    if (environment.TRANSCRIPTION_PROVIDER !== "voicetext") {
      return;
    }
    if (environment.VOICETEXT_SERVICE_TOKEN_FILE === undefined) {
      context.addIssue({
        code: "custom",
        message:
          "VOICETEXT_SERVICE_TOKEN_FILE is required for Voicetext transcription",
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
  readonly conversationRuntimeToken?: string;
  readonly craigBearerToken: string;
  readonly discordToken: string;
  readonly postgresUrl: string;
  readonly redisUrl: string;
  readonly recordingPlaybackSigningSecret?: string;
  readonly s3AccessKeyId: string;
  readonly s3SecretAccessKey: string;
  readonly subscriptionRuntimeToken: string;
  readonly voicetextServiceToken?: string;
}

export interface PlatformConfig {
  readonly bindAddress: string;
  readonly conversation?: {
    readonly runtimeAddress: string;
    readonly systemPrompt: string;
    readonly thinkingCueRoot: string;
    readonly voiceId: string;
    readonly voiceProfileId: string;
  };
  /** Controls whether the authoritative final summary replaces or follows the live draft. */
  readonly discordFinalPublicationMode: "separate-message" | "replace-live";
  /** New meetings publish directly into the configured results channel by default. */
  readonly discordPublicationMode: "message" | "thread";
  readonly discordApplicationId: string;
  readonly discordCraigApplicationId: string;
  readonly discordLegacyRoute?: {
    readonly guildId: string;
    readonly publicationTargetId: string;
    readonly voiceChannelId: string;
  };
  readonly nodeEnvironment: "development" | "production" | "test";
  readonly liveIngressOwnerMode: "singleton";
  readonly port: number;
  readonly recordingSpoolRoot: string;
  readonly recordingPlayback?: {
    readonly publicBaseUrl: string;
  };
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
    readonly batchMaxConcurrency: number;
    readonly batchMaxConcurrentMeetings: number;
    readonly liveMaxConcurrentSessions: number;
    readonly livePacketBackpressureTimeoutMs: number;
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
    conversationRuntimeToken,
    discordToken,
    postgresUrl,
    redisUrl,
    s3AccessKeyId,
    s3SecretAccessKey,
    subscriptionRuntimeToken,
    voicetextServiceToken,
    recordingPlayback,
  ] = await Promise.all([
    readSecret(environment.CRAIG_BEARER_TOKEN_FILE),
    !environment.CONVERSATION_ENABLED ||
    environment.CONVERSATION_RUNTIME_TOKEN_FILE === undefined
      ? Promise.resolve()
      : readSecret(environment.CONVERSATION_RUNTIME_TOKEN_FILE),
    readSecret(environment.DISCORD_TOKEN_FILE),
    readSecret(environment.POSTGRES_URL_FILE),
    readSecret(environment.REDIS_URL_FILE),
    readSecret(environment.S3_ACCESS_KEY_ID_FILE),
    readSecret(environment.S3_SECRET_ACCESS_KEY_FILE),
    readSecret(environment.SUBSCRIPTION_RUNTIME_TOKEN_FILE),
    environment.VOICETEXT_SERVICE_TOKEN_FILE === undefined
      ? Promise.resolve()
      : readSecret(environment.VOICETEXT_SERVICE_TOKEN_FILE),
    loadRecordingPlaybackConfig(environment, readSecret),
  ]);

  return Object.freeze({
    bindAddress: environment.BIND_ADDRESS,
    ...(environment.CONVERSATION_ENABLED &&
    environment.CONVERSATION_RUNTIME_ADDRESS !== undefined
      ? {
          conversation: {
            runtimeAddress: environment.CONVERSATION_RUNTIME_ADDRESS,
            systemPrompt: environment.CONVERSATION_SYSTEM_PROMPT,
            thinkingCueRoot:
              environment.CONVERSATION_THINKING_CUE_ROOT ??
              defaultConversationThinkingCueRoot,
            voiceId: environment.CONVERSATION_VOICE_ID,
            voiceProfileId: environment.CONVERSATION_VOICE_PROFILE_ID,
          },
        }
      : {}),
    discordFinalPublicationMode: environment.DISCORD_FINAL_PUBLICATION_MODE,
    discordPublicationMode: environment.DISCORD_PUBLICATION_MODE,
    discordApplicationId: environment.DISCORD_APPLICATION_ID,
    discordCraigApplicationId: environment.DISCORD_CRAIG_APPLICATION_ID,
    ...(environment.DISCORD_LEGACY_GUILD_ID === undefined ||
    environment.DISCORD_LEGACY_VOICE_CHANNEL_ID === undefined ||
    environment.DISCORD_RESULTS_CHANNEL_ID === undefined
      ? {}
      : {
          discordLegacyRoute: {
            guildId: environment.DISCORD_LEGACY_GUILD_ID,
            publicationTargetId: environment.DISCORD_RESULTS_CHANNEL_ID,
            voiceChannelId: environment.DISCORD_LEGACY_VOICE_CHANNEL_ID,
          },
        }),
    liveIngressOwnerMode: environment.LIVE_INGRESS_OWNER_MODE,
    nodeEnvironment: environment.NODE_ENV,
    port: environment.PORT,
    recordingSpoolRoot: environment.RECORDING_SPOOL_ROOT,
    ...(recordingPlayback.config === undefined
      ? {}
      : { recordingPlayback: recordingPlayback.config }),
    s3: {
      bucket: environment.S3_BUCKET,
      endpoint: environment.S3_ENDPOINT,
      prefix: environment.S3_PREFIX,
      region: environment.S3_REGION,
    },
    secrets: Object.freeze({
      craigBearerToken,
      ...(conversationRuntimeToken === undefined
        ? {}
        : { conversationRuntimeToken }),
      discordToken,
      postgresUrl,
      redisUrl,
      ...(recordingPlayback.signingSecret === undefined
        ? {}
        : { recordingPlaybackSigningSecret: recordingPlayback.signingSecret }),
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
            batchMaxArtifactBytes:
              environment.VOICETEXT_BATCH_MAX_ARTIFACT_BYTES,
            batchMaxConcurrency: environment.VOICETEXT_BATCH_MAX_CONCURRENCY,
            batchMaxConcurrentMeetings:
              environment.VOICETEXT_BATCH_MAX_CONCURRENT_MEETINGS,
            liveMaxConcurrentSessions:
              environment.VOICETEXT_LIVE_MAX_CONCURRENT_SESSIONS,
            livePacketBackpressureTimeoutMs:
              environment.VOICETEXT_LIVE_PACKET_BACKPRESSURE_TIMEOUT_MS,
            webSocketUrl: environment.VOICETEXT_WS_URL,
          },
        }),
  });
}
