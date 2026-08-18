import type { ParticipantGreetingProfiles } from "./participant-greeting-profiles.js";
import type { InfinityContextRuntimeActivationV1 } from "@discord-meeting/infinity-context-adapter";
import type { TwoHourHistoricalQualificationV1 } from "@discord-meeting/meeting-core/meeting-knowledge";

interface PlatformSecrets {
  readonly conversationRuntimeToken?: string;
  readonly craigBearerToken: string;
  readonly discordToken: string;
  readonly infinityContextToken?: string;
  readonly infinityContextTopologyKey?: string;
  readonly meetingKnowledgePrincipalKey?: string;
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
  readonly infinityContext?: {
    readonly activation: InfinityContextRuntimeActivationV1;
    readonly baseUrl: string;
    readonly operationTimeoutMs: number;
    readonly requestTimeoutMs: number;
  };
  readonly meetingKnowledge?: {
    readonly groundedVoice?: {
      readonly rolloutEpoch: string;
    };
    readonly localFinalReply?: true;
    readonly twoHourHistoricalQualification?: TwoHourHistoricalQualificationV1;
  };
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
  /** Immutable source revision embedded in the running Meeting Platform image. */
  readonly sourceRevision?: string;
  /** SHA-256 over the canonical Git tree listing embedded at build time. */
  readonly sourceTreeSha256?: string;
  readonly speaches: { readonly baseUrl: string; readonly model: string };
  readonly subscriptionRuntime: {
    readonly address: string;
    readonly launcherSha256: string;
  };
  readonly transcriptionProvider: "speaches" | "voicetext";
  readonly voicetext?: {
    readonly batchMaxArtifactBytes: number;
    readonly batchMaxConcurrency: number;
    readonly batchMaxConcurrentMeetings: number;
    readonly liveMaxConcurrentSessions: number;
    readonly livePacketBackpressureTimeoutMs: number;
    readonly webSocketUrl: string;
  };
}
