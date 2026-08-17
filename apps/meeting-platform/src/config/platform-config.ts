import type { ParticipantGreetingProfiles } from "./participant-greeting-profiles.js";

interface PlatformSecrets {
  readonly conversationRuntimeToken?: string;
  readonly craigBearerToken: string;
  readonly discordToken: string;
  readonly postgresUrl: string;
  readonly recordingPlaybackSigningSecret?: string;
  readonly redisUrl: string;
  readonly s3AccessKeyId: string;
  readonly s3SecretAccessKey: string;
  readonly subscriptionRuntimeToken: string;
  readonly voicetextServiceToken?: string;
}

export interface PlatformConfig {
  readonly bindAddress: string;
  readonly conversation?: {
    readonly farewellCueRoot: string;
    readonly greetingCueRoot: string;
    readonly runtimeAddress: string;
    readonly systemPrompt: string;
    readonly thinkingCueRoot: string;
    readonly voiceId: string;
    readonly voiceProfileId: string;
    readonly playbackReadiness?: {
      readonly root: string;
      readonly runId: string;
      readonly timeoutMilliseconds: number;
      readonly greetingObserverParticipantId?: string;
      readonly greetingRoot?: string;
    };
  };
  /** Controls whether the authoritative final summary replaces or follows the live draft. */
  readonly discordFinalPublicationMode: "separate-message" | "replace-live";
  /** New meetings publish directly into the configured results channel by default. */
  readonly discordPublicationMode: "message" | "thread";
  readonly discordApplicationId: string;
  /** Discord identity used for outbound Botik voice playback. */
  readonly discordBotikApplicationId: string;
  readonly discordCraigApplicationId: string;
  readonly discordLegacyRoute?: {
    readonly guildId: string;
    readonly publicationTargetId: string;
    readonly voiceChannelId: string;
  };
  readonly liveIngressOwnerMode: "singleton";
  readonly nodeEnvironment: "development" | "production" | "test";
  readonly participantGreetingDefaultLocale: "en" | "ru";
  readonly participantGreetingProfiles: ParticipantGreetingProfiles;
  readonly port: number;
  readonly recordingPlayback?: {
    readonly publicBaseUrl: string;
  };
  readonly recordingSpoolRoot: string;
  readonly s3: {
    readonly bucket: string;
    readonly endpoint: string;
    readonly prefix: string;
    readonly region: string;
  };
  readonly secrets: PlatformSecrets;
  readonly speaches: { readonly baseUrl: string; readonly model: string };
  readonly subscriptionRuntime: {
    readonly address: string;
    readonly launcherSha256: string;
  };
  readonly transcriptionProvider: "speaches" | "voicetext";
  readonly transcriptionLegacyExecutionBinding:
    | "speaches-v1"
    | "voicetext-batch-v2:deepgram-nova-3";
  readonly voicetext?: {
    readonly batchMaxArtifactBytes: number;
    readonly batchMaxConcurrency: number;
    readonly batchMaxConcurrentMeetings: number;
    readonly batchProfile: "deepgram-nova-3" | "elevenlabs-scribe-v2";
    readonly liveMaxConcurrentSessions: number;
    readonly livePacketBackpressureTimeoutMs: number;
    readonly liveProfile: "deepgram-nova-3" | "elevenlabs-scribe-v2-realtime";
    readonly webSocketUrl: string;
  };
}
