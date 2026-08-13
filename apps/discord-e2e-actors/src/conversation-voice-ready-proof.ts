import type { ConversationAnswerObserverReady, ConversationAnswerPlaybackIntent } from
  "@discord-meeting/conversation-runtime-contracts";

import type { ConversationVoiceObserverCapture } from "./conversation-voice-observer-config.js";
import {
  conversationVoiceCampaignPlanDigest,
  resolveConversationVoiceCampaignPlan,
  type ConversationVoiceCampaignProofV1,
} from "./conversation-voice-campaign-proof.js";
import { publishConversationAnswerObserverReady } from "./conversation-voice-turn-id-source.js";

export async function publishConversationVoiceReadyProof(input: {
  readonly authenticatedObserverBotId: string;
  readonly captures: readonly ConversationVoiceObserverCapture[];
  readonly intent: ConversationAnswerPlaybackIntent;
  readonly intentObservedAt: string;
  readonly root: string;
  readonly target: ConversationAnswerObserverReady["target"];
}): Promise<ConversationVoiceCampaignProofV1> {
  const plan = resolveConversationVoiceCampaignPlan(input.captures, input.intent);
  const planDigestSha256 = conversationVoiceCampaignPlanDigest(plan);
  const observerReadyReceipt = await publishConversationAnswerObserverReady({
    authenticatedObserverBotId: input.authenticatedObserverBotId,
    intent: input.intent,
    intentObservedAt: input.intentObservedAt,
    planDigestSha256,
    root: input.root,
    target: input.target,
  });
  return { observerReadyReceipt, plan, planDigestSha256, schemaVersion: 1 };
}
