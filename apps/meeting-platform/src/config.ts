import { z } from "zod";

import {
  loadRecordingPlaybackConfig,
  recordingPlaybackEnvironmentShape,
  validateRecordingPlaybackEnvironment,
} from "./config/recording-playback-config.js";
import {
  participantGreetingProfilesEnvironmentSchema,
} from "./config/participant-greeting-profiles.js";
import type { PlatformConfig } from "./config/platform-config.js";
import { readSecretFile } from "./config/secret-file-reader.js";
import { assemblePlatformConfig } from "./config/platform-config-assembly.js";

export type { PlatformConfig } from "./config/platform-config.js";

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
const absolutePath = z
  .string()
  .startsWith("/")
  .refine((value) => !value.includes("\0"));
const profileIdentifier = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u);
const optionalAbsolutePath = z.preprocess(
  (value) => value === "" ? undefined : value,
  absolutePath.optional(),
);
const optionalProfileIdentifier = z.preprocess(
  (value) => value === "" ? undefined : value,
  profileIdentifier.optional(),
);
const optionalReadinessTimeout = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.coerce.number().int().min(1_000).max(120_000).optional(),
);
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
const voiceIdentifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const environmentSchema = z
  .object({
    BIND_ADDRESS: z.union([z.ipv4(), z.ipv6()]).default("0.0.0.0"),
    CONVERSATION_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    CONVERSATION_FAREWELL_CUE_ROOT: absolutePath.optional(),
    CONVERSATION_E2E_PLAYBACK_READINESS_ROOT: optionalAbsolutePath,
    CONVERSATION_E2E_PLAYBACK_READINESS_RUN_ID: optionalProfileIdentifier,
    CONVERSATION_E2E_PLAYBACK_READINESS_TIMEOUT_MS: optionalReadinessTimeout,
    CONVERSATION_GREETING_CUE_ROOT: absolutePath.optional(),
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
    DISCORD_BOTIK_APPLICATION_ID: optionalSnowflake,
    DISCORD_CRAIG_APPLICATION_ID: snowflake,
    DISCORD_LEGACY_GUILD_ID: optionalSnowflake,
    DISCORD_LEGACY_VOICE_CHANNEL_ID: optionalSnowflake,
    DISCORD_FINAL_PUBLICATION_MODE: z
      .enum(["separate-message", "replace-live"])
      .default("separate-message"),
    DISCORD_PUBLICATION_MODE: z.enum(["message", "thread"]).default("message"),
    DISCORD_RESULTS_CHANNEL_ID: optionalSnowflake,
    DISCORD_TOKEN_FILE: absolutePath,
    E2E_TEST_ONLY_LABEL: z.enum(["true", "false"]).default("false")
      .transform((value) => value === "true"),
    LIVE_INGRESS_OWNER_MODE: z.literal("singleton").default("singleton"),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("production"),
    PARTICIPANT_GREETING_DEFAULT_LOCALE: z.enum(["ru", "en"]).default("ru"),
    PARTICIPANT_GREETING_PROFILES_JSON:
      participantGreetingProfilesEnvironmentSchema,
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
    const playbackReadinessParts = [
      environment.CONVERSATION_E2E_PLAYBACK_READINESS_ROOT,
      environment.CONVERSATION_E2E_PLAYBACK_READINESS_RUN_ID,
      environment.CONVERSATION_E2E_PLAYBACK_READINESS_TIMEOUT_MS,
    ];
    const configuredPlaybackReadinessParts = playbackReadinessParts
      .filter((value) => value !== undefined).length;
    if (configuredPlaybackReadinessParts !== 0 && configuredPlaybackReadinessParts !== 3) {
      context.addIssue({
        code: "custom",
        message: "conversation E2E playback readiness root, run ID and timeout must be configured together",
        path: ["CONVERSATION_E2E_PLAYBACK_READINESS_ROOT"],
      });
    }
    if (configuredPlaybackReadinessParts > 0 && !environment.E2E_TEST_ONLY_LABEL) {
      context.addIssue({
        code: "custom",
        message: "conversation playback readiness is permitted only in an explicitly test-only deployment",
        path: ["E2E_TEST_ONLY_LABEL"],
      });
    }
    if (configuredPlaybackReadinessParts > 0 && !environment.CONVERSATION_ENABLED) {
      context.addIssue({
        code: "custom",
        message: "conversation playback readiness requires live conversation to be enabled",
        path: ["CONVERSATION_ENABLED"],
      });
    }
    if (
      Object.keys(environment.PARTICIPANT_GREETING_PROFILES_JSON).length > 0 &&
      !environment.CONVERSATION_ENABLED
    ) {
      context.addIssue({
        code: "custom",
        message:
          "participant greeting profiles require live conversation to be enabled",
        path: ["PARTICIPANT_GREETING_PROFILES_JSON"],
      });
    }
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

export type ParsedPlatformEnvironment = z.infer<typeof environmentSchema>;

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

  return assemblePlatformConfig(environment, {
    craigBearerToken,
    ...(conversationRuntimeToken === undefined ? {} : { conversationRuntimeToken }),
    discordToken,
    postgresUrl,
    redisUrl,
    recordingPlayback,
    s3AccessKeyId,
    s3SecretAccessKey,
    subscriptionRuntimeToken,
    ...(voicetextServiceToken === undefined ? {} : { voicetextServiceToken }),
  });
}
