import { requireNonEmpty } from "./errors.js";

export interface ConversationTurnInput {
  readonly meetingId: string;
  readonly prompt: string;
  readonly speakerId: string;
  readonly turnId: string;
}

export interface ConversationTurn {
  readonly meetingId: string;
  readonly prompt: string;
  readonly speakerId: string;
  readonly turnId: string;
}

export function createConversationTurn(input: ConversationTurnInput): ConversationTurn {
  return Object.freeze({
    meetingId: requireNonEmpty(input.meetingId, "conversation.meetingId"),
    prompt: requireNonEmpty(input.prompt, "conversation.prompt"),
    speakerId: requireNonEmpty(input.speakerId, "conversation.speakerId"),
    turnId: requireNonEmpty(input.turnId, "conversation.turnId"),
  });
}
