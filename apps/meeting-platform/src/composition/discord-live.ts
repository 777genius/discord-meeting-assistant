import { randomUUID } from "node:crypto";

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
import { ConfigureMeetingSource } from "@discord-meeting/meeting-routing-core";
import { CraigPlaybackGateway } from "@discord-meeting/craig-playback-adapter";
import type { ConversationCoordinator } from
  "@discord-meeting/meeting-core/conversation";
import type { GroundedMeetingAnswer } from "@discord-meeting/meeting-core/meeting-knowledge";
import type {
  IncrementalSummaryGenerationPort,
} from "@discord-meeting/meeting-core/live-meeting";
import {
  type SummaryPublicationPort,
  type SummaryPublicationEffectLedger,
} from "@discord-meeting/meeting-core/publishing";
import type { Logger } from "@discord-meeting/observability-adapter";
import {
  PostgresConversationOneShotReceiptStore,
  type PostgresMeetingSourceConfigurationRepository,
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
import { PostgresRecordingPublicationReconciliation } from
  "../recording-playback/adapters/index.js";
import type { PlatformStartupCleanup } from "./startup-cleanup.js";
import type { PlatformLiveFinalizedMemoryRuntime } from "./live-finalized-memory.js";
import type { PlatformHistoricalMemoryRuntime } from "./historical-memory.js";
import { classifyPlatformError } from "./observability.js";
import { discordLiveCaptionSignature } from "./discord-live-caption-signature.js";
import { meetingVocabulary } from "./meeting-vocabulary.js";
import {
  createPlatformLiveConversationConfiguration,
  createPlatformLiveMeetingRuntime,
} from "./live-runtime-factory.js";
export {
  createPlatformLiveConversationConfiguration,
  createPlatformLiveMeetingRuntime,
} from "./live-runtime-factory.js";
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

// oxlint-disable-next-line max-lines-per-function
export async function createPlatformDiscordLiveComposition(input: {
  readonly cleanup: PlatformStartupCleanup;
  readonly config: PlatformConfig;
  readonly sourceConfigurations: PostgresMeetingSourceConfigurationRepository;
  readonly groundedAnswerUseCase?: GroundedMeetingAnswer;
  readonly historicalMemory?: PlatformHistoricalMemoryRuntime;
  readonly logger: Logger;
  readonly liveFinalizedMemory?: PlatformLiveFinalizedMemoryRuntime;
  readonly meetings: PostgresLiveMeetingRepository;
  readonly pool: Pool;
  readonly publicationEffects: SummaryPublicationEffectLedger;
  readonly recordingPlayback?: (meetingId: string) => Promise<
    | { readonly status: "processing" | "unavailable" }
    | { readonly status: "ready"; readonly url: string }
  >;
  readonly recordingPlaybackUrl?: (meetingId: string) => string;
  readonly runtimeTransport?: SubscriptionRuntimeTransportPort;
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
    new ConfigureMeetingSource(
      input.sourceConfigurations,
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
    ...(input.runtimeTransport === undefined
      ? {}
      : { runtimeTransport: input.runtimeTransport }),
  });
  if (live !== undefined) {
    input.cleanup.defer("derived live runtime", () => live.close());
    const stopObservingPlaybackReadiness = craigPlaybackGateway.onSessionReady(
      (recordingId) => {
        void live.conversationPlaybackReady(recordingId).catch((error: unknown) => {
          input.logger.warn(
            "Conversation playback readiness notification failed",
            classifyPlatformError(error),
          );
        });
      },
    );
    input.cleanup.defer("Craig playback readiness observer", () => {
      stopObservingPlaybackReadiness();
    });
  }
  const recordingReconciliations = input.recordingPlayback === undefined
    ? undefined
    : new PostgresRecordingPublicationReconciliation(input.pool);
  const rawPublisher = new DiscordSummaryPublicationAdapter(
    discordPublisher,
    {
      finalPublicationMode: input.config.discordFinalPublicationMode,
      publisherIdentity: input.config.discordApplicationId,
      ...(input.recordingPlayback === undefined
        ? {}
        : { recordingPlayback: input.recordingPlayback }),
      ...(recordingReconciliations === undefined
        ? {}
        : { recordingPlaybackReconciliation: recordingReconciliations }),
      ...(input.recordingPlaybackUrl === undefined
        ? {}
        : { recordingPlaybackUrl: input.recordingPlaybackUrl }),
    },
  );
  if (recordingReconciliations !== undefined) {
    const reconciliationOwner = `meeting-platform:${randomUUID()}`;
    let reconciliationRunning = false;
    const reconcile = async (): Promise<void> => {
      if (reconciliationRunning) {
        return;
      }
      reconciliationRunning = true;
      try {
        for (const obligation of await recordingReconciliations.claim({
          leaseOwner: reconciliationOwner,
        })) {
          try {
            const outcome = await rawPublisher.reconcileRecordingPlayback({
              externalPublicationId: obligation.externalPublicationId,
              request: obligation.request,
            });
            if (outcome === "processing") {
              await recordingReconciliations.release(
                obligation.meetingId,
                obligation.leaseOwner,
              );
            } else if (!await recordingReconciliations.complete(
              obligation.meetingId,
              obligation.leaseOwner,
              outcome,
            )) {
              throw new Error("Recording publication reconciliation lease was lost");
            }
          } catch (error) {
            await recordingReconciliations.release(
              obligation.meetingId,
              obligation.leaseOwner,
            );
            input.logger.warn(
              "Recording publication reconciliation failed",
              classifyPlatformError(error),
            );
          }
        }
      } catch (error) {
        input.logger.warn("Recording publication reconciliation failed", classifyPlatformError(error));
      } finally {
        reconciliationRunning = false;
      }
    };
    const handle = setInterval(() => { void reconcile(); }, 1_000);
    input.cleanup.defer("recording publication reconciliation", () => { clearInterval(handle); });
    void reconcile();
  }
  return {
    ...(conversationRuntime === undefined ? {} : { conversationRuntime }),
    craigPlaybackGateway,
    discord,
    guildSetupHandler,
    installUrls,
    ...(live === undefined ? {} : { live }),
    rawPublisher,
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
  readonly runtimeTransport?: SubscriptionRuntimeTransportPort;
}): PlatformLiveMeetingRuntime | undefined {
  if (!hasLiveTranscriptionConfiguration(input.config)) {
    return undefined;
  }
  const summarizer = createLiveIncrementalSummaryPort(
    input.config,
    input.runtimeTransport,
  );
  const projector = new DiscordLiveMeetingProjectionAdapter(input.discordPublisher, {
    publisherIdentity: input.config.discordApplicationId,
  });
  const conversation = createPlatformLiveConversationConfiguration({
    config: input.config,
    ...(input.conversationCoordinator === undefined
      ? {}
      : { coordinator: input.conversationCoordinator }),
    ...(input.farewellCues === undefined ? {} : { farewellCues: input.farewellCues }),
    ...createFarewellClassifier(input.config, input.runtimeTransport),
    ...(input.greetingCues === undefined ? {} : { greetingCues: input.greetingCues }),
    isPlaybackReady: input.isPlaybackReady,
    oneShotReceipts: input.oneShotReceipts,
  });
  return createPlatformLiveMeetingRuntime({
    captionSignature: discordLiveCaptionSignature,
    ...(conversation === undefined ? {} : { conversation }),
    ...(input.liveFinalizedMemory === undefined
      ? {}
      : { finalizedMemory: input.liveFinalizedMemory }),
    logger: input.logger,
    meetings: input.meetings,
    packetFlowControl: {
      maximumConcurrentSessions:
        input.config.voicetext.liveMaxConcurrentSessions,
      packetBackpressureTimeoutMs:
        input.config.voicetext.livePacketBackpressureTimeoutMs,
    },
    projector,
    summarizer,
    transcriber: new VoicetextLiveTranscriptionAdapter({
      endpoint: input.config.voicetext.webSocketUrl,
      keyterms: meetingVocabulary,
      language: "multi",
      profile: input.config.voicetext.liveProfile,
      token: input.config.secrets.voicetextServiceToken,
    }),
  });
}

/**
 * Keeps the consumer-owned live-summary port explicit when the optional hosted
 * runtime is absent. Captions continue to project, while summary generation
 * settles as unavailable and can never invent an outline from partial speech.
 */
export function createLiveIncrementalSummaryPort(
  config: PlatformConfig,
  runtimeTransport?: SubscriptionRuntimeTransportPort,
): IncrementalSummaryGenerationPort {
  if (runtimeTransport === undefined || config.subscriptionRuntime === undefined) {
    return new UnavailableIncrementalSummaryPort();
  }
  return new SubscriptionRuntimeIncrementalSummaryAdapter(runtimeTransport, {
    expectedLauncherSha256: config.subscriptionRuntime.launcherSha256,
    expectedRuntimeEngine: subscriptionRuntimeCliEngine,
    maxOutputTokens: subscriptionRuntimeIncrementalMaxOutputTokens,
    maxRecentContextTurns: 256,
    timeoutMs: incrementalSummaryTimeoutMs,
  });
}

class UnavailableIncrementalSummaryPort
  implements IncrementalSummaryGenerationPort
{
  public async generate() {
    return {
      failure: {
        code: "LIVE_SUMMARY_PROVIDER_UNAVAILABLE",
        message: "Incremental summary generation is not configured",
        retryable: false,
      },
      ok: false as const,
    };
  }
}

function createFarewellClassifier(
  config: PlatformConfig,
  runtimeTransport?: SubscriptionRuntimeTransportPort,
): { readonly farewellClassifier?: SubscriptionRuntimeFarewellClassifier } {
  if (config.conversation === undefined) {
    return {};
  }
  if (runtimeTransport === undefined || config.subscriptionRuntime === undefined) {
    throw new Error("Subscription Runtime is required for voice-assistant features");
  }
  return {
    farewellClassifier: new SubscriptionRuntimeFarewellClassifier(
      runtimeTransport,
      config.subscriptionRuntime.launcherSha256,
    ),
  };
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
    config.voicetext.liveEnabled === true &&
    config.secrets.voicetextServiceToken !== undefined
  );
}
