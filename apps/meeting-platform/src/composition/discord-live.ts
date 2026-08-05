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
  ConversationCoordinator,
  FinishLiveMeeting,
  RefreshLiveMeeting,
  StartLiveMeeting,
  type ConversationRuntime,
  type ConversationLatencyObserverPort,
  type SummaryPublicationPort,
  type SummaryPublicationEffectLedger,
  type VoicePlaybackPort,
} from "@discord-meeting/meeting-core";
import type { Logger } from "@discord-meeting/observability-adapter";
import type {
  PostgresGuildConfigurationRepository,
  PostgresLiveMeetingRepository,
} from "@discord-meeting/postgres-adapter";
import { GrpcPipecatConversationRuntime } from "@discord-meeting/pipecat-runtime-adapter";
import {
  SubscriptionRuntimeIncrementalSummaryAdapter,
  subscriptionRuntimeCliEngine,
  subscriptionRuntimeIncrementalMaxOutputTokens,
  type SubscriptionRuntimeTransportPort,
} from "@discord-meeting/subscription-runtime-adapter";
import { VoicetextLiveTranscriptionAdapter } from "@discord-meeting/voicetext-adapter";
import { Client, GatewayIntentBits } from "discord.js";

import { FileConversationThinkingCueRegistry } from "../adapters/outbound/file-conversation-thinking-cue-registry.js";
import { SystemConversationDelay } from "../adapters/outbound/system-conversation-delay.js";
import type { PlatformConfig } from "../config.js";
import { PlatformLiveMeetingRuntime } from "../live-meeting-runtime.js";
import type { PlatformStartupCleanup } from "./startup-cleanup.js";
import { classifyPlatformError } from "./observability.js";
import { discordLiveCaptionSignature } from "./discord-live-caption-signature.js";

const monotonicNowMilliseconds = (): number => performance.now();
const unixNowMilliseconds = (): number => Date.now();

const meetingVocabulary = [
  "BullMQ",
  "Craig",
  "Craig recording",
  "Discord",
  "Discord thread",
  "idempotency key",
  "live Pipecat assistant",
  "Meeting Platform",
  "Pipecat",
  "PostgreSQL",
  "PostgreSQL pipeline",
  "Redis",
  "Redis queue",
] as const;

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
  readonly logger: Logger;
  readonly meetings: PostgresLiveMeetingRepository;
  readonly publicationEffects: SummaryPublicationEffectLedger;
  readonly runtimeTransport: SubscriptionRuntimeTransportPort;
}): Promise<PlatformDiscordLiveComposition> {
  const discord = new Client({ intents: [GatewayIntentBits.Guilds] });
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
  const craigPlaybackGateway = new CraigPlaybackGateway(unixNowMilliseconds);
  input.cleanup.defer("Craig playback gateway", () => {
    craigPlaybackGateway.close();
  });
  const conversationRuntime = createConversationRuntime(input.config);
  if (conversationRuntime !== undefined) {
    input.cleanup.defer("Pipecat conversation runtime", () => {
      conversationRuntime.close();
    });
  }
  const conversationCoordinator = conversationRuntime === undefined
    ? undefined
    : await createConversationCoordinator({
        config: input.config,
        latencyObserver: createConversationLatencyLogger(input.logger),
        playback: craigPlaybackGateway,
        runtime: conversationRuntime,
      });
  const live = createLiveRuntime({
    config: input.config,
    ...(conversationCoordinator === undefined ? {} : { conversationCoordinator }),
    discordPublisher,
    logger: input.logger,
    meetings: input.meetings,
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
    rawPublisher: new DiscordSummaryPublicationAdapter(discordPublisher),
  };
}

/** Adapts provider-neutral latency observations to platform structured logs. */
export function createConversationLatencyLogger(
  logger: Pick<Logger, "info">,
): ConversationLatencyObserverPort {
  return {
    observeConversationLatency: (observation) => {
      logger.info("Live conversation latency observed", { ...observation });
    },
  };
}

/** Preloads required local cue assets before live conversation accepts work. */
export async function createConversationCoordinator(input: {
  readonly config: Pick<PlatformConfig, "conversation">;
  readonly latencyObserver?: ConversationLatencyObserverPort;
  readonly playback: VoicePlaybackPort;
  readonly runtime: ConversationRuntime;
}): Promise<ConversationCoordinator | undefined> {
  if (input.config.conversation === undefined) {
    return undefined;
  }
  const thinkingCues = await FileConversationThinkingCueRegistry.load(
    input.config.conversation.thinkingCueRoot,
    input.config.conversation.voiceProfileId,
    input.config.conversation.voiceId,
  );
  return new ConversationCoordinator({
    delay: new SystemConversationDelay(),
    ...(input.latencyObserver === undefined
      ? {}
      : { latencyObserver: input.latencyObserver }),
    playback: input.playback,
    runtime: input.runtime,
    thinkingCues,
  });
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
  readonly logger: Logger;
  readonly meetings: PostgresLiveMeetingRepository;
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
      outputLanguage: "Natural English; preserve technical terms exactly",
      timeoutMs: 30_000,
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
            locale: "auto",
            nowMilliseconds: unixNowMilliseconds,
            systemPrompt: input.config.conversation.systemPrompt,
            voiceProfileId: input.config.conversation.voiceProfileId,
          },
        }),
    finishMeeting: new FinishLiveMeeting(input.meetings),
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
