import { bindConversationVoiceRecording } from "./e2e-collector.js";
import { conversationVoiceCampaignEvidenceIssue } from
  "./conversation-voice-campaign-contract.js";

export async function accessDiscordWithBoundConversation<T>(input: {
  readonly connect: (token: string) => Promise<void>;
  readonly rawVoice: readonly unknown[] | undefined;
  readonly readSecret: () => Promise<string>;
  readonly recordingId: string;
  readonly run: (
    boundVoice: readonly ReturnType<typeof bindConversationVoiceRecording>[] | undefined,
  ) => Promise<T>;
}): Promise<T> {
  const boundVoice = input.rawVoice?.map((observation) =>
    bindConversationVoiceRecording(observation, input.recordingId)
  );
  if (boundVoice !== undefined) {
    const campaignIssue = conversationVoiceCampaignEvidenceIssue(boundVoice);
    if (campaignIssue !== undefined) {
      throw new Error(`Conversation voice campaign evidence is invalid: ${campaignIssue}`);
    }
  }
  const token = await input.readSecret();
  await input.connect(token);
  return input.run(boundVoice);
}
