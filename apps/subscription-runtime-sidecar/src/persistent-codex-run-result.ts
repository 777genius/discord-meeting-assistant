import type { ProcessRunResult } from "./types.js";

export function persistentCodexSafeErrorChain(error: unknown): string {
  const parts: string[] = [];
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    parts.push(`${current.name}: ${current.message}`);
    current = current.cause;
  }
  return (parts.length === 0 ? "unknown worker failure" : parts.join(" <- "))
    .replaceAll(/[\r\n]+/gu, " ")
    .slice(0, 2_000);
}

export function persistentCodexSafeRuntimeFailure(
  error: unknown,
): Readonly<Record<string, unknown>> {
  const code = persistentCodexRuntimeFailureCode(error);
  return {
    causeCategory: "subscription_runtime",
    code,
    reconnectRequired: code === "needs_reconnect",
    retryable: new Set([
      "backend_unavailable",
      "needs_reconnect",
      "quota_limited",
      "task_timeout",
    ]).has(code),
    safeMessage: "Subscription runtime worker could not complete the task",
  };
}

export function persistentCodexBoundedResult(
  stdout: string,
  maximumBytes: number,
  exitCode = 0,
): ProcessRunResult {
  const encoded = Buffer.from(stdout, "utf8");
  return {
    exitCode,
    outputLimitExceeded: encoded.length > maximumBytes,
    signal: null,
    stderr: "",
    stdout: encoded.length > maximumBytes
      ? encoded.subarray(0, maximumBytes).toString("utf8")
      : stdout,
    timedOut: false,
  };
}

export function persistentCodexCancelledResult(): ProcessRunResult {
  return {
    cancelled: true,
    exitCode: null,
    outputLimitExceeded: false,
    signal: null,
    stderr: "",
    stdout: "",
    timedOut: false,
  };
}

export function persistentCodexTimedOutResult(): ProcessRunResult {
  return {
    exitCode: null,
    outputLimitExceeded: false,
    signal: null,
    stderr: "",
    stdout: "",
    timedOut: true,
  };
}

export function persistentCodexSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function persistentCodexRuntimeFailureCode(error: unknown): string {
  const text = error instanceof Error ? `${error.name} ${error.message}` : "";
  if (/quota|usage.?limit/iu.test(text)) {
    return "quota_limited";
  }
  if (/reconnect|refresh.?token|auth.?expired/iu.test(text)) {
    return "needs_reconnect";
  }
  if (/permission/iu.test(text)) {
    return "permission_required";
  }
  if (/timeout|timed.?out/iu.test(text)) {
    return "task_timeout";
  }
  return "backend_unavailable";
}
