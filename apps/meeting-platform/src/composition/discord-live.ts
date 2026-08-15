import {
  DiscordGuildSetupAdapter,
  DiscordGuildSetupCommandHandler,
  DiscordJsProjectionClient,
  DiscordLiveMeetingProjectionAdapter,
  DiscordSummaryPublicationAdapter,
  DiscordSummaryPublisher,
  InProcessProjectionLock,
  craigGatewayInstallPermissions,
  createDiscordGuildInstallUrl,
  meetingPlatformInstallPermissions,
} from "@discord-meeting/discord-adapter";
import { ConfigureGuild } from "@discord-meeting/guild-configuration-core";
import { CraigPlaybackGateway } from "@discord-meeting/craig-playback-adapter";
import {
  AppendLiveTranscriptTurn,
  FinishLiveMeeting,
  RefreshLiveMeeting,
  StartLiveMeeting,
} from "@discord-meeting/meeting-core/live-meeting";
import {
  ConversationCoordinator,
} from "@discord-meeting/meeting-core/conversation";
import type { GroundedMeetingAnswer } from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  type SummaryPublicationPort,
  type SummaryPublicationEffectLedger,
} from "@discord-meeting/meeting-core/publishing";
import type { Logger } from "@discord-meeting/observability-adapter";
import {
  PostgresConversationOneShotReceiptStore,
  type PostgresGuildConfigurationRepository,
  type PostgresLiveMeetingRepository,
} from "@discord-meeting/postgres-adapter";
import type { Pool } from "pg";
import { GrpcPipecatConversationRuntime } from "@discord-meeting/pipecat-runtime-adapter";
import {
  SubscriptionRuntimeIncrementalSummaryAdapter,
  subscriptionRuntimeCliEngine,
  subscriptionRuntimeIncrementalMaxOutputTokens,
  type SubscriptionRuntimeTransportPort,
} from "@discord-meeting/subscription-runtime-adapter";
import { VoicetextLiveTranscriptionAdapter } from "@discord-meeting/voicetext-adapter";
import { Client, GatewayIntentBits, Partials } from "discord.js";

import { FileConversationFarewellCueRegistry } from "../adapters/outbound/file-conversation-farewell-cue-registry.js";
import { FileParticipantGreetingCueRegistry } from "../adapters/outbound/file-participant-greeting-cue-registry.js";
import { SubscriptionRuntimeFarewellClassifier } from "../adapters/outbound/subscription-runtime-farewell-classifier.js";
import type { PlatformConfig } from "../config.js";
import { PlatformLiveMeetingRuntime } from "../live-meeting-runtime.js";
import type { PlatformStartupCleanup } from "./startup-cleanup.js";
import type { PlatformLiveFinalizedMemoryRuntime } from "./live-finalized-memory.js";
import type { PlatformHistoricalMemoryRuntime } from "./historical-memory.js";
import { classifyPlatformError } from "./observability.js";
import { discordLiveCaptionSignature } from "./discord-live-caption-signature.js";
import { meetingVocabulary } from "./meeting-vocabulary.js";
export {
  createConversationLatencyLogger,
  createConversationPlaybackLogger,
  createGroundedKnowledgeAnswerLogger,
} from "./conversation-loggers.js";
export { createConversationCoordinator } from "./conversation-coordinator.js";
import { createLiveConversationResources } from "./conversation-coordinator.js";
import { createVoiceGroundedAnswers } from "./voice-grounded-answers.js";

// Keep wall-clock-shaped timestamps compatible with STT while preventing clock
// adjustments from corrupting playback deadlines and the four-second guard.
const monotonicUnixNowMilliseconds = (): number =>
  Math.floor(performance.timeOrigin + performance.now());
const incrementalSummaryTimeoutMs = 120_000;

export interface PlatformDiscordLiveComposition {
  readonly conversationRuntime?: GrpcPipecatConversationRuntime;
  readonly craigPlaybackGateway: CraigPlaybackGateway;
  readonly discord: Client;
  readonly guildSetupHandler: DiscordGuildSetupCommandHandler;
  readonly installUrls: {
    readonly craig: string;
    readonly meetingPlatform: string;
  };
  readonly live?: PlatformLiveMeetingRuntime;
  readonly rawPublisher: SummaryPublicationPort;
}

export async function createPlatformDiscordLiveComposition(input: {
  readonly cleanup: PlatformStartupCleanup;
  readonly config: PlatformConfig;
  readonly guildConfigurations: PostgresGuildConfigurationRepository;
  readonly groundedAnswerUseCase?: GroundedMeetingAnswer;
  readonly historicalMemory?: PlatformHistoricalMemoryRuntime;
  readonly logger: Logger;
  readonly liveFinalizedMemory?: PlatformLiveFinalizedMemoryRuntime;
  readonly meetings: PostgresLiveMeetingRepository;
  readonly pool: Pool;
  readonly publicationEffects: SummaryPublicationEffectLedger;
  readonly recordingPlaybackUrl?: (meetingId: string) => string;
  readonly runtimeTransport: SubscriptionRuntimeTransportPort;
}): Promise<PlatformDiscordLiveComposition> {
  const knowledgeIntents = input.config.meetingKnowledge?.localFinalReply === true
    ? [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
    : [];
  const knowledgePartials = input.config.meetingKnowledge?.localFinalReply === true
    ? [Partials.Message]
    : [];
  const discord = new Client({
    intents: [GatewayIntentBits.Guilds, ...knowledgeIntents],
    partials: knowledgePartials,
  });
  input.cleanup.defer("Discord client", async () => {
    await discord.destroy();
  });
  const installUrls = createInstallUrls(input.config);
  const guildSetupAdapter = new DiscordGuildSetupAdapter(
    discord,
    input.config.discordCraigApplicationId,
  );
  const guildSetupHandler = new DiscordGuildSetupCommandHandler(
    discord,
    new ConfigureGuild(
      input.guildConfigurations,
      guildSetupAdapter,
      guildSetupAdapter,
    ),
    installUrls.craig,
    (error) => {
      input.logger.error("Discord guild setup failed", classifyPlatformError(error));
    },
  );
  input.cleanup.defer("Discord guild setup listener", () => {
    guildSetupHandler.close();
  });
  const discordPublisher = new DiscordSummaryPublisher(
    new DiscordJsProjectionClient(discord),
    new InProcessProjectionLock(),
    input.publicationEffects,
    { publicationMode: input.config.discordPublicationMode },
  );
  const craigPlaybackGateway = new CraigPlaybackGateway(monotonicUnixNowMilliseconds);
  input.cleanup.defer("Craig playback gateway", () => {
    craigPlaybackGateway.close();
  });
  const conversationRuntime = createConversationRuntime(input.config);
  if (conversationRuntime !== undefined) {
    input.cleanup.defer("Pipecat conversation runtime", () => {
      conversationRuntime.close();
    });
  }
  const groundedAnswers = createVoiceGroundedAnswers(input, discord);
  const conversation = await createLiveConversationResources({
    config: input.config,
    ...(groundedAnswers === undefined ? {} : { groundedAnswers }),
    logger: input.logger,
    playback: craigPlaybackGateway,
    ...(conversationRuntime === undefined ? {} : { runtime: conversationRuntime }),
  });
  const live = createLiveRuntime({
    config: input.config,
    ...(conversation.coordinator === undefined
      ? {}
      : { conversationCoordinator: conversation.coordinator }),
    discordPublisher,
    ...(conversation.farewellCues === undefined
      ? {}
      : { farewellCues: conversation.farewellCues }),
    ...(conversation.greetingCues === undefined
      ? {}
      : { greetingCues: conversation.greetingCues }),
    isPlaybackReady: (recordingId) => craigPlaybackGateway.hasSession(recordingId),
    logger: input.logger,
    ...(input.liveFinalizedMemory === undefined
      ? {}
      : { liveFinalizedMemory: input.liveFinalizedMemory }),
    meetings: input.meetings,
    oneShotReceipts: new PostgresConversationOneShotReceiptStore(input.pool),
    runtimeTransport: input.runtimeTransport,
  });
  if (live !== undefined) {
    input.cleanup.defer("derived live runtime", () => live.close());
  }
  return {
    ...(conversationRuntime === undefined ? {} : { conversationRuntime }),
    craigPlaybackGateway,
    discord,
    guildSetupHandler,
    installUrls,
    ...(live === undefined ? {} : { live }),
    rawPublisher: new DiscordSummaryPublicationAdapter(
      discordPublisher,
      {
        finalPublicationMode: input.config.discordFinalPublicationMode,
        ...(input.recordingPlaybackUrl === undefined
          ? {}
          : { recordingPlaybackUrl: input.recordingPlaybackUrl }),
      },
    ),
  };
}

function createInstallUrls(config: PlatformConfig): {
  readonly craig: string;
  readonly meetingPlatform: string;
} {
  return {
    craig: createDiscordGuildInstallUrl({
      applicationId: config.discordCraigApplicationId,
      permissions: craigGatewayInstallPermissions,
    }),
    meetingPlatform: createDiscordGuildInstallUrl({
      applicationId: config.discordApplicationId,
      permissions:
        config.discordApplicationId === config.discordCraigApplicationId
          ? meetingPlatformInstallPermissions | craigGatewayInstallPermissions
          : meetingPlatformInstallPermissions,
    }),
  };
}

function createConversationRuntime(
  config: PlatformConfig,
): GrpcPipecatConversationRuntime | undefined {
  if (config.conversation === undefined) {
    return undefined;
  }
  const serviceToken = config.secrets.conversationRuntimeToken;
  if (serviceToken === undefined) {
    throw new Error("Conversation runtime token is missing from validated config");
  }
  return new GrpcPipecatConversationRuntime({
    address: config.conversation.runtimeAddress,
    serviceToken,
  });
}

function createLiveRuntime(input: {
  readonly config: PlatformConfig;
  readonly conversationCoordinator?: ConversationCoordinator;
  readonly discordPublisher: DiscordSummaryPublisher;
  readonly farewellCues?: FileConversationFarewellCueRegistry;
  readonly greetingCues?: FileParticipantGreetingCueRegistry;
  readonly isPlaybackReady: (recordingId: string) => boolean;
  readonly logger: Logger;
  readonly liveFinalizedMemory?: PlatformLiveFinalizedMemoryRuntime;
  readonly meetings: PostgresLiveMeetingRepository;
  readonly oneShotReceipts: PostgresConversationOneShotReceiptStore;
  readonly runtimeTransport: SubscriptionRuntimeTransportPort;
}): PlatformLiveMeetingRuntime | undefined {
  if (!hasLiveTranscriptionConfiguration(input.config)) {
    return undefined;
  }
  const summarizer = new SubscriptionRuntimeIncrementalSummaryAdapter(
    input.runtimeTransport,
    {
      expectedLauncherSha256: input.config.subscriptionRuntime.launcherSha256,
      expectedRuntimeEngine: subscriptionRuntimeCliEngine,
      maxOutputTokens: subscriptionRuntimeIncrementalMaxOutputTokens,
      maxRecentContextTurns: 256,
      timeoutMs: incrementalSummaryTimeoutMs,
    },
  );
  const projector = new DiscordLiveMeetingProjectionAdapter(input.discordPublisher);
  return new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(input.meetings),
    captionSignature: discordLiveCaptionSignature,
    ...(input.config.conversation === undefined ||
    input.conversationCoordinator === undefined
      ? {}
      : {
          conversation: {
            coordinator: input.conversationCoordinator,
            ...(input.farewellCues === undefined
              ? {}
              : {
                  farewells: {
                    classifier: new SubscriptionRuntimeFarewellClassifier(
                      input.runtimeTransport,
                      input.config.subscriptionRuntime.launcherSha256,
                    ),
                    cues: input.farewellCues,
                    participantNames: Object.freeze(Object.fromEntries(
                      Object.entries(input.config.participantGreetingProfiles)
                        .map(([participantId, profile]) => [
                          participantId,
                          profile.displayName,
                        ]),
                    )),
                  },
                }),
            greetings: {
              ...(input.greetingCues === undefined
                ? {}
                : { cues: input.greetingCues }),
              defaultLocale: input.config.participantGreetingDefaultLocale,
              excludedParticipantIds: Object.freeze([
                input.config.discordApplicationId,
                input.config.discordBotikApplicationId,
                input.config.discordCraigApplicationId,
              ]),
              isPlaybackReady: input.isPlaybackReady,
              profiles: input.config.participantGreetingProfiles,
            },
            locale: "auto",
            nowMilliseconds: monotonicUnixNowMilliseconds,
            oneShotReceipts: input.oneShotReceipts,
            systemPrompt: input.config.conversation.systemPrompt,
            voiceProfileId: input.config.conversation.voiceProfileId,
          },
        }),
    finishMeeting: new FinishLiveMeeting(input.meetings),
    ...(input.liveFinalizedMemory === undefined
      ? {}
      : { finalizedMemory: input.liveFinalizedMemory }),
    logger: input.logger,
    packetFlowControl: {
      maximumConcurrentSessions:
        input.config.voicetext.liveMaxConcurrentSessions,
      packetBackpressureTimeoutMs:
        input.config.voicetext.livePacketBackpressureTimeoutMs,
    },
    refreshMeeting: new RefreshLiveMeeting({
      meetings: input.meetings,
      projector,
      summarizer,
    }),
    startMeeting: new StartLiveMeeting({ meetings: input.meetings }),
    transcriber: new VoicetextLiveTranscriptionAdapter({
      endpoint: input.config.voicetext.webSocketUrl,
      keyterms: meetingVocabulary,
      language: "multi",
      token: input.config.secrets.voicetextServiceToken,
    }),
  });
}

function hasLiveTranscriptionConfiguration(
  config: PlatformConfig,
): config is PlatformConfig & {
  readonly voicetext: NonNullable<PlatformConfig["voicetext"]>;
  readonly secrets: PlatformConfig["secrets"] & {
    readonly voicetextServiceToken: string;
  };
} {
  return (
    config.transcriptionProvider === "voicetext" &&
    config.voicetext !== undefined &&
    config.secrets.voicetextServiceToken !== undefined
  );
}
