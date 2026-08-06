import type { PortResult, StageFailure } from "@discord-meeting/meeting-core";

export function safeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

export function failure<Value>(
  code: string,
  message: string,
  retryable: boolean,
): PortResult<Value> {
  const stageFailure: StageFailure = { code, message, retryable };
  return { ok: false, failure: stageFailure };
}
