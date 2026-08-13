import type { ConversationVoiceObserverCapture, ConversationVoiceObserverConfig } from
  "./conversation-voice-observer-config.js";
import {
  publishConversationGreetingObserverReady,
  waitForConversationGreetingPlaybackIntent,
} from "./conversation-voice-turn-id-source.js";

export async function publishInitialGreetingObserverReady(input: {
  readonly authenticatedBotId: string;
  readonly captures: readonly ConversationVoiceObserverCapture[];
  readonly config: ConversationVoiceObserverConfig;
  readonly handshakeNotBeforeEpochMilliseconds: number;
}): Promise<void> {
  const root = input.config.greetingHandshakeRoot;
  if (root === undefined) { return; }
  const intent = await waitForConversationGreetingPlaybackIntent({
    ...(input.config.meetingId === undefined ? {} : { meetingId: input.config.meetingId }),
    notBeforeEpochMilliseconds: input.handshakeNotBeforeEpochMilliseconds,
    participantId: input.config.observerApplicationId,
    root,
    runId: input.config.runId,
    timeoutMilliseconds: input.config.readyTimeoutMilliseconds,
  });
  await publishConversationGreetingObserverReady({
    authenticatedObserverBotId: input.authenticatedBotId,
    intent,
    intentObservedAt: new Date().toISOString(),
    root,
    target: {
      craigBotId: input.config.craigBotId,
      guildId: input.config.guildId,
      observerApplicationId: input.config.observerApplicationId,
      voiceChannelId: input.config.voiceChannelId,
    },
  });
}
