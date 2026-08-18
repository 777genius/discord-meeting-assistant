import { CraigPlaybackGateway } from "@discord-meeting/craig-playback-adapter";
import {
  ConversationCoordinator,
  type ConversationLatencyObserverPort,
  type ConversationPlaybackObserverPort,
  type ConversationRuntime,
  type GroundedKnowledgeAnswerObserverPort,
  type GroundedKnowledgeAnswerPort,
  type VoicePlaybackPort,
} from "@discord-meeting/meeting-core/conversation";
import type { Logger } from "@discord-meeting/observability-adapter";

import { FileConversationFarewellCueRegistry } from "../adapters/outbound/file-conversation-farewell-cue-registry.js";
import { FileConversationPlaybackReadiness } from "../adapters/outbound/file-conversation-playback-readiness.js";
import { FileConversationThinkingCueRegistry } from "../adapters/outbound/file-conversation-thinking-cue-registry.js";
import { FileParticipantGreetingCueRegistry } from "../adapters/outbound/file-participant-greeting-cue-registry.js";
import { SystemConversationDelay } from "../adapters/outbound/system-conversation-delay.js";
import type { PlatformConfig } from "../config.js";
import {
  createConversationLatencyLogger,
  createConversationPlaybackLogger,
  createGroundedKnowledgeAnswerLogger,
} from "./conversation-loggers.js";

interface ConversationResources {
  readonly coordinator?: ConversationCoordinator;
  readonly farewellCues?: FileConversationFarewellCueRegistry;
  readonly greetingCues?: FileParticipantGreetingCueRegistry;
}

export async function createLiveConversationResources(input: {
  readonly config: Pick<PlatformConfig, "conversation">;
  readonly groundedAnswers?: GroundedKnowledgeAnswerPort;
  readonly logger: Logger;
  readonly playback: CraigPlaybackGateway;
  readonly runtime?: ConversationRuntime;
}): Promise<ConversationResources> {
  if (input.runtime === undefined) {
    return {};
  }
  const coordinator = await createConversationCoordinator({
    config: input.config,
    ...(input.groundedAnswers === undefined
      ? {}
      : {
          groundedAnswerObserver: createGroundedKnowledgeAnswerLogger(input.logger),
          groundedAnswers: input.groundedAnswers,
        }),
    latencyObserver: createConversationLatencyLogger(input.logger),
    playback: input.playback,
    ...(input.config.conversation?.playbackReadiness === undefined
      ? {}
      : {
          playbackReadiness: new FileConversationPlaybackReadiness(
            input.config.conversation.playbackReadiness,
          ),
        }),
    playbackObserver: createConversationPlaybackLogger(
      input.logger,
      performance.timeOrigin,
      input.config.conversation === undefined
        ? undefined
        : {
            deployment: input.config.conversation.runtimeAddress.slice(
              0, input.config.conversation.runtimeAddress.lastIndexOf(":"),
            ),
            model: input.config.conversation.voiceProfileId,
            schemaVersion: 1,
            voice: input.config.conversation.voiceId,
          },
    ),
    runtime: input.runtime,
  });
  const conversation = input.config.conversation;
  if (coordinator === undefined || conversation === undefined) {
    return {};
  }
  const [farewellCues, greetingCues] = await Promise.all([
    FileConversationFarewellCueRegistry.load(
      conversation.farewellCueRoot,
      conversation.voiceProfileId,
      conversation.voiceId,
    ),
    FileParticipantGreetingCueRegistry.load(
      conversation.greetingCueRoot,
      conversation.voiceProfileId,
      conversation.voiceId,
    ),
  ]);
  return { coordinator, farewellCues, greetingCues };
}

/** Preloads required local cue assets before live conversation accepts work. */
export async function createConversationCoordinator(input: {
  readonly config: Pick<PlatformConfig, "conversation">;
  readonly groundedAnswerObserver?: GroundedKnowledgeAnswerObserverPort;
  readonly groundedAnswers?: GroundedKnowledgeAnswerPort;
  readonly latencyObserver?: ConversationLatencyObserverPort;
  readonly playback: VoicePlaybackPort;
  readonly playbackReadiness?: import("@discord-meeting/meeting-core/conversation")
    .ConversationPlaybackReadinessPort;
  readonly playbackObserver?: ConversationPlaybackObserverPort;
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
    ...(input.groundedAnswerObserver === undefined
      ? {}
      : { groundedAnswerObserver: input.groundedAnswerObserver }),
    ...(input.groundedAnswers === undefined
      ? {}
      : { groundedAnswers: input.groundedAnswers }),
    ...(input.latencyObserver === undefined
      ? {}
      : { latencyObserver: input.latencyObserver }),
    playback: input.playback,
    ...(input.playbackReadiness === undefined
      ? {}
      : { playbackReadiness: input.playbackReadiness }),
    ...(input.playbackObserver === undefined
      ? {}
      : { playbackObserver: input.playbackObserver }),
    runtime: input.runtime,
    thinkingCues,
  });
}
