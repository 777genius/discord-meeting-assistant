import { z } from "zod";
import {
  decodeInfinityContextRuntimeActivation,
} from "@discord-meeting/infinity-context-adapter";
import {
  DEFAULT_HISTORICAL_MEMORY_OPERATION_TIMEOUT_MS,
  MAXIMUM_HISTORICAL_MEMORY_OPERATION_TIMEOUT_MS,
} from "@discord-meeting/meeting-core/meeting-knowledge";

import {
  recordingPlaybackEnvironmentShape,
  validateRecordingPlaybackEnvironment,
} from "./config/recording-playback-config.js";
import {
  participantGreetingProfilesEnvironmentSchema,
} from "./config/participant-greeting-profiles.js";
import { validateInfinityContextEnvironment } from "./config/infinity-context-environment.js";
import {
  validateConversationEnvironment,
  validateConversationReadinessEnvironment,
  validateMeetingKnowledgeEnvironment,
} from "./config/environment-validations.js";

import type { PlatformConfig } from "./config/platform-config.js";
import {
  loadPlatformConfigWithParser,
  type SecretFileReader,
} from "./config/platform-config-loader.js";
import type { BuildProvenanceReader } from "./config/build-provenance.js";
import type {
  AcceptedTwoHourQualification,
  QualificationFileReader,
} from "./config/two-hour-qualification.js";

export type { PlatformConfig } from "./config/platform-config.js";

const snowflake = z.string().regex(/^\d{17,20}$/u);
const optionalSnowflake = z.preprocess(
  (value) => (value === "" ? undefined : value),
  snowflake.optional(),
);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const retrievalV2ProviderBinding = z.string().min(2).max(4_000).transform((value, context) => {
  try {
    return z.object({
      capabilityFingerprint: sha256,
      contractVersion: z.literal("context-retrieval.v2"),
      indexProfileDigest: sha256,
      profileId: z.string().trim().min(1).max(256),
      rankingPolicy: z.literal("weighted_rrf_canonical_preferences.v1"),
      requiredProviderLanes: z.array(z.string().trim().min(1).max(256)).min(1).max(4)
        .refine((lanes) => lanes.every((lane, index) => index === 0 || lanes[index - 1]! < lane)),
      serviceRevision: z.string().trim().min(1).max(256),
    }).strict().parse(JSON.parse(value) as unknown);
  } catch (error: unknown) {
    context.addIssue({ code: "custom", message: error instanceof Error
      ? error.message : "invalid Retrieval V2 provider binding" });
    return z.NEVER;
  }
});
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
const e2eSyntheticHumanActorIds = z.string().default("").transform(
  (value, context): readonly string[] => {
    if (value.trim().length === 0) {
      return Object.freeze([]);
    }
    const actorIds = value.split(",").map((actorId) => actorId.trim());
    if (
      actorIds.length > 128 ||
      new Set(actorIds).size !== actorIds.length ||
      actorIds.some((actorId) => !/^\d{17,20}$/u.test(actorId))
    ) {
      context.addIssue({
        code: "custom",
        message: "E2E synthetic human actor IDs must be at most 128 unique Discord snowflakes",
      });
      return z.NEVER;
    }
    return Object.freeze(actorIds);
  },
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
const infinityActivation = z.string().min(2).max(4_000).transform((value, context) => {
  try {
    return decodeInfinityContextRuntimeActivation(JSON.parse(value) as unknown);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "invalid Infinity activation",
    });
    return z.NEVER;
  }
});
const environmentSchema = z
  .object({
    BIND_ADDRESS: z.union([z.ipv4(), z.ipv6()]).default("0.0.0.0"),
    CONVERSATION_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    CONVERSATION_FAREWELL_CUE_ROOT: absolutePath.optional(),
    CONVERSATION_E2E_PLAYBACK_READINESS_ROOT: optionalAbsolutePath,
    CONVERSATION_E2E_GREETING_OBSERVER_PARTICIPANT_ID: optionalSnowflake,
    CONVERSATION_E2E_GREETING_PLAYBACK_READINESS_ROOT: optionalAbsolutePath,
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
    INFINITY_CONTEXT_ACTIVATION: infinityActivation.optional(),
    INFINITY_CONTEXT_OPERATION_TIMEOUT_MS: z.coerce.number().int().min(1_000)
      .max(MAXIMUM_HISTORICAL_MEMORY_OPERATION_TIMEOUT_MS)
      .default(DEFAULT_HISTORICAL_MEMORY_OPERATION_TIMEOUT_MS),
    INFINITY_CONTEXT_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),
    INFINITY_CONTEXT_TOKEN_FILE: absolutePath.optional(),
    INFINITY_CONTEXT_TOPOLOGY_KEY_FILE: absolutePath.optional(),
    INFINITY_CONTEXT_URL: httpUrl.optional(),
    MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    MEETING_KNOWLEDGE_ACTOR_KEYRING_FILE: absolutePath.optional(),
    MEETING_KNOWLEDGE_GROUNDED_VOICE_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    MEETING_KNOWLEDGE_GROUNDED_VOICE_ROLLOUT_EPOCH: profileIdentifier.optional(),
    MEETING_KNOWLEDGE_GROUNDED_VOICE_ROLLOUT_STATE_FILE: absolutePath.optional(),
    MEETING_KNOWLEDGE_E2E_SYNTHETIC_HUMAN_ACTOR_IDS: e2eSyntheticHumanActorIds,
    MEETING_KNOWLEDGE_E2E_PUBLIC_REPLY_CRASH_ROOT: optionalAbsolutePath,
    MEETING_KNOWLEDGE_E2E_PUBLIC_REPLY_CRASH_WORKER_ID: optionalProfileIdentifier,
    MEETING_KNOWLEDGE_PRINCIPAL_KEY_FILE: absolutePath.optional(),
    MEETING_KNOWLEDGE_RETRIEVAL_V2_PROVIDER_BINDING_JSON:
      retrievalV2ProviderBinding.optional(),
    MEETING_KNOWLEDGE_TWO_HOUR_QUALIFICATION_FILE: optionalAbsolutePath,
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
    SUMMARY_PROVIDER: z
      .enum(["transcript-outline", "subscription-runtime"])
      .default("transcript-outline"),
    SUBSCRIPTION_RUNTIME_ADDRESS: runtimeAddress.optional(),
    SUBSCRIPTION_RUNTIME_LAUNCHER_SHA256: sha256.optional(),
    SUBSCRIPTION_RUNTIME_TOKEN_FILE: absolutePath.optional(),
    TRANSCRIPTION_PROVIDER: z
      .enum(["speaches", "voicetext"])
      .default("speaches"),
    TRANSCRIPTION_LEGACY_EXECUTION_BINDING: z.enum(["speaches-v1", "voicetext-batch-v2:deepgram-nova-3"]),
    VOICETEXT_BATCH_MAX_ARTIFACT_BYTES: z.coerce
      .number()
      .int()
      .min(27)
      .max(maximumVoicetextBatchMaxArtifactBytes)
      .default(defaultVoicetextBatchMaxArtifactBytes),
    VOICETEXT_BATCH_PROFILE: z.enum(["deepgram-nova-3", "elevenlabs-scribe-v2"])
      .default("deepgram-nova-3"),
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
    VOICETEXT_LIVE_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    VOICETEXT_LIVE_PACKET_BACKPRESSURE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(maximumVoicetextLivePacketBackpressureTimeoutMs)
      .default(defaultVoicetextLivePacketBackpressureTimeoutMs),
    VOICETEXT_LIVE_PROFILE: z.enum(["deepgram-nova-3", "elevenlabs-scribe-v2-realtime"])
      .default("deepgram-nova-3"),
    VOICETEXT_SERVICE_TOKEN_FILE: absolutePath.optional(),
    VOICETEXT_WS_URL: secureWebSocketUrl.optional(),
  })
  .superRefine((environment, context) => {
    validateConversationReadinessEnvironment(environment, context);
  })
  .superRefine((environment, context) => {
    validateConversationEnvironment(environment, context);
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
    validateInfinityContextEnvironment(environment, context);
    validateMeetingKnowledgeEnvironment(environment, context);
    if (environment.SUMMARY_PROVIDER === "subscription-runtime") {
      for (const [name, value] of [
        ["SUBSCRIPTION_RUNTIME_ADDRESS", environment.SUBSCRIPTION_RUNTIME_ADDRESS],
        ["SUBSCRIPTION_RUNTIME_LAUNCHER_SHA256", environment.SUBSCRIPTION_RUNTIME_LAUNCHER_SHA256],
        ["SUBSCRIPTION_RUNTIME_TOKEN_FILE", environment.SUBSCRIPTION_RUNTIME_TOKEN_FILE],
      ] as const) {
        if (value === undefined) {
          context.addIssue({
            code: "custom",
            message: `${name} is required for subscription-runtime summaries`,
            path: [name],
          });
        }
      }
    }
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

export function loadPlatformConfig(
  rawEnvironment: Readonly<Record<string, string | undefined>> = process.env,
  readSecret?: SecretFileReader,
  readBuildProvenance?: BuildProvenanceReader,
  readQualificationFile?: QualificationFileReader,
  acceptedTwoHourQualification?: AcceptedTwoHourQualification | null,
): Promise<PlatformConfig> {
  return loadPlatformConfigWithParser(
    (raw) => environmentSchema.parse(raw),
    rawEnvironment,
    {
      ...(acceptedTwoHourQualification === undefined
        ? {}
        : { acceptedTwoHourQualification }),
      ...(readBuildProvenance === undefined ? {} : { readBuildProvenance }),
      ...(readQualificationFile === undefined ? {} : { readQualificationFile }),
      ...(readSecret === undefined ? {} : { readSecret }),
    },
  );
}
