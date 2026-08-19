import type { ConversationVoiceObserverConfig } from
  "./conversation-voice-observer-config.js";
import {
  publishConversationGreetingObserverReady,
  waitForConversationGreetingPlaybackIntent,
} from "./conversation-voice-turn-id-source.js";

export async function armInitialConversationObserver(input: {
  readonly publishObserverSubscribed: () => void;
  readonly waitForCraigBot: () => Promise<void>;
}): Promise<void> {
  // The actor that starts the next meeting is released by observer-subscribed.
  // Waiting for Craig before publishing it deadlocks whenever Craig correctly
  // leaves after the preceding meeting has finished processing.
  input.publishObserverSubscribed();
  await input.waitForCraigBot();
}

export async function publishGreetingObserverReady(input: {
  readonly authenticatedBotId: string;
  readonly config: ConversationVoiceObserverConfig;
  readonly handshakeNotBeforeEpochMilliseconds: number;
  readonly participantId: string;
}): Promise<void> {
  const root = input.config.greetingHandshakeRoot;
  if (root === undefined) { return; }
  const intent = await waitForConversationGreetingPlaybackIntent({
    ...(input.config.meetingId === undefined ? {} : { meetingId: input.config.meetingId }),
    notBeforeEpochMilliseconds: input.handshakeNotBeforeEpochMilliseconds,
    participantId: input.participantId,
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
