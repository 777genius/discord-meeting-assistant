import type { PortResult, StageFailure } from "@discord-meeting/meeting-core";

export function isAbortRequested(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

export async function rejectWhenAborted<Value>(
  operation: Promise<Value>,
  signal?: AbortSignal,
): Promise<Value> {
  if (signal === undefined) {
    return await operation;
  }
  if (signal.aborted) {
    throw new Error("operation aborted");
  }
  return await new Promise<Value>((resolve, reject) => {
    const abort = () => {
      reject(new Error("operation aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
        return null;
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error instanceof Error ? error : new Error("operation failed"));
        return null;
      },
    );
  });
}

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
