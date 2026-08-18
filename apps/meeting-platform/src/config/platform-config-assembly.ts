import type { TwoHourHistoricalQualificationV1 } from "@discord-meeting/meeting-core/meeting-knowledge";

import type { BuildProvenanceV1 } from "./build-provenance.js";
import type { PlatformConfig } from "./platform-config.js";
import type { ParsedPlatformEnvironment } from "../config.js";

export interface LoadedPlatformSecrets {
  readonly buildProvenance?: BuildProvenanceV1;
  readonly craigBearerToken: string;
  readonly conversationRuntimeToken?: string;
  readonly discordToken: string;
  readonly infinityContextToken?: string;
  readonly infinityContextTopologyKey?: string;
  readonly meetingKnowledgePrincipalKey?: string;
  readonly postgresUrl: string;
  readonly redisUrl: string;
  readonly s3AccessKeyId: string;
  readonly s3SecretAccessKey: string;
  readonly subscriptionRuntimeToken: string;
  readonly voicetextServiceToken?: string;
  readonly twoHourHistoricalQualification?: TwoHourHistoricalQualificationV1;
  readonly recordingPlayback: {
    readonly config?: { readonly publicBaseUrl: string };
    readonly signingSecret?: string;
  };
}

function cueRoot(configured: string | undefined, fallback: string): string {
  return configured ?? fallback;
}

function infinityContextConfig(
  environment: ParsedPlatformEnvironment,
): Pick<PlatformConfig, "infinityContext"> {
  if (
    environment.INFINITY_CONTEXT_ACTIVATION === undefined ||
    environment.INFINITY_CONTEXT_URL === undefined
  ) {
    return {};
  }
  return {
    infinityContext: {
      activation: environment.INFINITY_CONTEXT_ACTIVATION,
      baseUrl: environment.INFINITY_CONTEXT_URL,
      operationTimeoutMs: environment.INFINITY_CONTEXT_OPERATION_TIMEOUT_MS,
      requestTimeoutMs: environment.INFINITY_CONTEXT_REQUEST_TIMEOUT_MS,
    },
  };
}

function platformSecrets(loaded: LoadedPlatformSecrets): PlatformConfig["secrets"] {
  return Object.freeze({
    craigBearerToken: loaded.craigBearerToken,
    ...(loaded.conversationRuntimeToken === undefined
      ? {}
      : { conversationRuntimeToken: loaded.conversationRuntimeToken }),
    discordToken: loaded.discordToken,
    ...(loaded.infinityContextToken === undefined
      ? {}
      : { infinityContextToken: loaded.infinityContextToken }),
    ...(loaded.infinityContextTopologyKey === undefined
      ? {}
      : { infinityContextTopologyKey: loaded.infinityContextTopologyKey }),
    ...(loaded.meetingKnowledgePrincipalKey === undefined
      ? {}
      : { meetingKnowledgePrincipalKey: loaded.meetingKnowledgePrincipalKey }),
    postgresUrl: loaded.postgresUrl,
    ...(loaded.recordingPlayback.signingSecret === undefined
      ? {}
      : { recordingPlaybackSigningSecret: loaded.recordingPlayback.signingSecret }),
    redisUrl: loaded.redisUrl,
    s3AccessKeyId: loaded.s3AccessKeyId,
    s3SecretAccessKey: loaded.s3SecretAccessKey,
    subscriptionRuntimeToken: loaded.subscriptionRuntimeToken,
    ...(loaded.voicetextServiceToken === undefined
      ? {}
      : { voicetextServiceToken: loaded.voicetextServiceToken }),
  });
}

export function assemblePlatformConfig(
  environment: ParsedPlatformEnvironment,
  loaded: LoadedPlatformSecrets,
): PlatformConfig {
  return Object.freeze({
    bindAddress: environment.BIND_ADDRESS,
    ...(environment.CONVERSATION_ENABLED && environment.CONVERSATION_RUNTIME_ADDRESS !== undefined
      ? { conversation: {
          farewellCueRoot: cueRoot(environment.CONVERSATION_FAREWELL_CUE_ROOT, "/app/apps/meeting-platform/assets/farewell-cues"),
          greetingCueRoot: cueRoot(environment.CONVERSATION_GREETING_CUE_ROOT, "/app/apps/meeting-platform/assets/greeting-cues"),
          runtimeAddress: environment.CONVERSATION_RUNTIME_ADDRESS,
          systemPrompt: environment.CONVERSATION_SYSTEM_PROMPT,
          thinkingCueRoot: cueRoot(environment.CONVERSATION_THINKING_CUE_ROOT, "/app/apps/meeting-platform/assets/thinking-cues"),
          voiceId: environment.CONVERSATION_VOICE_ID,
          voiceProfileId: environment.CONVERSATION_VOICE_PROFILE_ID,
          ...(environment.CONVERSATION_E2E_PLAYBACK_READINESS_ROOT === undefined || environment.CONVERSATION_E2E_PLAYBACK_READINESS_RUN_ID === undefined || environment.CONVERSATION_E2E_PLAYBACK_READINESS_TIMEOUT_MS === undefined
            ? {} : { playbackReadiness: Object.freeze({ root: environment.CONVERSATION_E2E_PLAYBACK_READINESS_ROOT, runId: environment.CONVERSATION_E2E_PLAYBACK_READINESS_RUN_ID, timeoutMilliseconds: environment.CONVERSATION_E2E_PLAYBACK_READINESS_TIMEOUT_MS,
              ...(environment.CONVERSATION_E2E_GREETING_OBSERVER_PARTICIPANT_ID === undefined ? {} : { greetingObserverParticipantId: environment.CONVERSATION_E2E_GREETING_OBSERVER_PARTICIPANT_ID }),
              ...(environment.CONVERSATION_E2E_GREETING_PLAYBACK_READINESS_ROOT === undefined ? {} : { greetingRoot: environment.CONVERSATION_E2E_GREETING_PLAYBACK_READINESS_ROOT }) }) }),
        } } : {}),
    discordFinalPublicationMode: environment.DISCORD_FINAL_PUBLICATION_MODE,
    discordPublicationMode: environment.DISCORD_PUBLICATION_MODE,
    discordApplicationId: environment.DISCORD_APPLICATION_ID,
    discordBotikApplicationId: environment.DISCORD_BOTIK_APPLICATION_ID ?? environment.DISCORD_CRAIG_APPLICATION_ID,
    discordCraigApplicationId: environment.DISCORD_CRAIG_APPLICATION_ID,
    ...(environment.DISCORD_LEGACY_GUILD_ID === undefined || environment.DISCORD_LEGACY_VOICE_CHANNEL_ID === undefined || environment.DISCORD_RESULTS_CHANNEL_ID === undefined ? {} : { discordLegacyRoute: { guildId: environment.DISCORD_LEGACY_GUILD_ID, publicationTargetId: environment.DISCORD_RESULTS_CHANNEL_ID, voiceChannelId: environment.DISCORD_LEGACY_VOICE_CHANNEL_ID } }),
    liveIngressOwnerMode: environment.LIVE_INGRESS_OWNER_MODE,
    ...infinityContextConfig(environment),
    ...(environment.MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED ||
      loaded.twoHourHistoricalQualification !== undefined
      ? { meetingKnowledge: {
          ...(environment.MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED
            ? { localFinalReply: true as const }
            : {}),
          ...(loaded.twoHourHistoricalQualification === undefined
            ? {}
            : {
                twoHourHistoricalQualification:
                  loaded.twoHourHistoricalQualification,
              }),
        } }
      : {}),
    nodeEnvironment: environment.NODE_ENV,
    participantGreetingDefaultLocale: environment.PARTICIPANT_GREETING_DEFAULT_LOCALE,
    participantGreetingProfiles: environment.PARTICIPANT_GREETING_PROFILES_JSON,
    port: environment.PORT,
    recordingSpoolRoot: environment.RECORDING_SPOOL_ROOT,
    ...(loaded.recordingPlayback.config === undefined ? {} : { recordingPlayback: loaded.recordingPlayback.config }),
    s3: { bucket: environment.S3_BUCKET, endpoint: environment.S3_ENDPOINT, prefix: environment.S3_PREFIX, region: environment.S3_REGION },
    secrets: platformSecrets(loaded),
    ...(loaded.buildProvenance === undefined
      ? {}
      : {
          sourceRevision: loaded.buildProvenance.releaseRevision,
          sourceTreeSha256: loaded.buildProvenance.sourceTreeSha256,
        }),
    speaches: { baseUrl: environment.SPEACHES_BASE_URL, model: environment.SPEACHES_MODEL },
    subscriptionRuntime: { address: environment.SUBSCRIPTION_RUNTIME_ADDRESS, launcherSha256: environment.SUBSCRIPTION_RUNTIME_LAUNCHER_SHA256 },
    transcriptionProvider: environment.TRANSCRIPTION_PROVIDER,
    ...(environment.VOICETEXT_WS_URL === undefined ? {} : { voicetext: { batchMaxArtifactBytes: environment.VOICETEXT_BATCH_MAX_ARTIFACT_BYTES, batchMaxConcurrency: environment.VOICETEXT_BATCH_MAX_CONCURRENCY, batchMaxConcurrentMeetings: environment.VOICETEXT_BATCH_MAX_CONCURRENT_MEETINGS, liveMaxConcurrentSessions: environment.VOICETEXT_LIVE_MAX_CONCURRENT_SESSIONS, livePacketBackpressureTimeoutMs: environment.VOICETEXT_LIVE_PACKET_BACKPRESSURE_TIMEOUT_MS, webSocketUrl: environment.VOICETEXT_WS_URL } }),
  });
}
