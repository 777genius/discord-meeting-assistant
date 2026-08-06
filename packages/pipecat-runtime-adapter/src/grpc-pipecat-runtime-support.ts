import {
  type ConversationPortResult,
  type ConversationFailure,
} from "@discord-meeting/meeting-core/conversation";

export function safeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

export function failure<Value>(
  code: string,
  message: string,
  retryable: boolean,
): ConversationPortResult<Value> {
  const stageFailure: ConversationFailure = { code, message, retryable };
  return { ok: false, failure: stageFailure };
}
