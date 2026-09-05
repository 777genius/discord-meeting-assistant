import type {
  ConversationCoordinator,
  ConversationFarewellClassifier,
} from "@discord-meeting/meeting-core/conversation";
import {
  AppendLiveTranscriptTurn,
  FinishLiveMeeting,
  type IncrementalSummaryGenerationPort,
  type LiveMeetingProjectionPort,
  RefreshLiveMeeting,
  StartLiveMeeting,
} from "@discord-meeting/meeting-core/live-meeting";
import {
  PostgresConversationOneShotReceiptStore,
  type PostgresLiveMeetingRepository,
} from "@discord-meeting/postgres-adapter";

import { FileConversationFarewellCueRegistry } from
  "../adapters/outbound/file-conversation-farewell-cue-registry.js";
import { FileParticipantGreetingCueRegistry } from
  "../adapters/outbound/file-participant-greeting-cue-registry.js";
import type { PlatformConfig } from "../config.js";
import { PlatformLiveMeetingRuntime } from "../live-meeting-runtime.js";
import type {
  LiveCaptionSignature,
  LiveConversationConfiguration,
  LivePacketFlowControl,
  LivePacketInspector,
  LiveRuntimeClock,
  LiveRuntimeLogger,
  LiveRuntimeTimer,
  LiveTranscriptionPort,
} from "../live-runtime/contracts.js";
import type { PlatformLiveFinalizedMemoryRuntime } from "./live-finalized-memory.js";

const monotonicUnixNowMilliseconds = (): number =>
  Math.floor(performance.timeOrigin + performance.now());

type PlatformLiveConversationConfig = Pick<
  PlatformConfig,
  | "conversation"
  | "discordApplicationId"
  | "discordBotikApplicationId"
  | "discordCraigApplicationId"
  | "participantGreetingDefaultLocale"
  | "participantGreetingProfiles"
>;

/** Builds the exact live-conversation policy consumed by the production root. */
export function createPlatformLiveConversationConfiguration(input: {
  readonly config: PlatformLiveConversationConfig;
  readonly coordinator?: ConversationCoordinator;
  readonly farewellClassifier?: ConversationFarewellClassifier;
  readonly farewellCues?: FileConversationFarewellCueRegistry;
  readonly greetingCues?: FileParticipantGreetingCueRegistry;
  readonly isPlaybackReady: (recordingId: string) => boolean;
  readonly nowMilliseconds?: () => number;
  readonly oneShotReceipts: PostgresConversationOneShotReceiptStore;
}): LiveConversationConfiguration | undefined {
  if (input.config.conversation === undefined || input.coordinator === undefined) {
    return undefined;
  }
  return {
    coordinator: input.coordinator,
    ...(input.farewellCues === undefined
      ? {}
      : {
          farewells: {
            ...(input.farewellClassifier === undefined
              ? {}
              : { classifier: input.farewellClassifier }),
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
      ...(input.greetingCues === undefined ? {} : { cues: input.greetingCues }),
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
    nowMilliseconds: input.nowMilliseconds ?? monotonicUnixNowMilliseconds,
    oneShotReceipts: input.oneShotReceipts,
    systemPrompt: input.config.conversation.systemPrompt,
    voiceProfileId: input.config.conversation.voiceProfileId,
  };
}

/** Production use-case wiring below provider-specific construction. */
export function createPlatformLiveMeetingRuntime(input: {
  readonly captionSignature?: LiveCaptionSignature;
  readonly clock?: LiveRuntimeClock;
  readonly conversation?: LiveConversationConfiguration;
  readonly finalizedMemory?: PlatformLiveFinalizedMemoryRuntime;
  readonly logger: LiveRuntimeLogger;
  readonly markLivePacketDelivered?: (packetId: string) => Promise<void>;
  readonly pendingLivePackets?: (recordingId: string) => Promise<readonly import("../live-runtime/contracts.js").LiveVoicePacket[]>;
  readonly meetings: PostgresLiveMeetingRepository;
  readonly packetFlowControl: LivePacketFlowControl;
  readonly packetInspector?: LivePacketInspector;
  readonly projector: LiveMeetingProjectionPort;
  readonly speakerIdleFinalizeMs?: number;
  readonly summarizer: IncrementalSummaryGenerationPort;
  readonly timer?: LiveRuntimeTimer;
  readonly transcriber: LiveTranscriptionPort;
}): PlatformLiveMeetingRuntime {
  return new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(input.meetings),
    ...(input.captionSignature === undefined
      ? {}
      : { captionSignature: input.captionSignature }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
    ...(input.conversation === undefined
      ? {}
      : { conversation: input.conversation }),
    finishMeeting: new FinishLiveMeeting(input.meetings),
    ...(input.finalizedMemory === undefined
      ? {}
      : { finalizedMemory: input.finalizedMemory }),
    logger: input.logger,
    ...(input.markLivePacketDelivered === undefined ? {} : { markLivePacketDelivered: input.markLivePacketDelivered }),
    ...(input.pendingLivePackets === undefined ? {} : { pendingLivePackets: input.pendingLivePackets }),
    packetFlowControl: input.packetFlowControl,
    ...(input.packetInspector === undefined
      ? {}
      : { packetInspector: input.packetInspector }),
    refreshMeeting: new RefreshLiveMeeting({
      meetings: input.meetings,
      projector: input.projector,
      summarizer: input.summarizer,
    }),
    ...(input.speakerIdleFinalizeMs === undefined
      ? {}
      : { speakerIdleFinalizeMs: input.speakerIdleFinalizeMs }),
    startMeeting: new StartLiveMeeting({ meetings: input.meetings }),
    ...(input.timer === undefined ? {} : { timer: input.timer }),
    transcriber: input.transcriber,
  });
}
