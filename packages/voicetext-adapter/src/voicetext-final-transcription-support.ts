import { createHash } from "node:crypto";

import { VoicetextAdapterError, VoicetextTransportError } from "./errors.js";

export interface VoicetextFinalProviderTurn {
  readonly endMs: number;
  readonly speakerId: string;
  readonly stableTurnId: string;
  readonly startMs: number;
  readonly text: string;
}

export interface VoicetextFinalOperationSignal {
  readonly signal: AbortSignal;
  readonly timeoutSignal: AbortSignal;
}

export function createVoicetextFinalOperationSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): VoicetextFinalOperationSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return {
    signal: externalSignal === undefined
      ? timeoutSignal
      : AbortSignal.any([externalSignal, timeoutSignal]),
    timeoutSignal,
  };
}

export async function awaitVoicetextFinalSignal<Value>(
  promise: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> {
  return await new Promise<Value>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
        return value;
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
        return error;
      },
    );
    if (signal.aborted) {
      onAbort();
    }
  });
}

export function classifyVoicetextFinalOperationError(
  error: unknown,
  externalSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
  fallbackCode: "artifact_read_failed" | "transcode_failed" | "transport_error",
): unknown {
  if (externalSignal?.aborted === true) {
    return new VoicetextAdapterError(
      "cancelled",
      "Voicetext transcription was cancelled",
      true,
      { cause: error },
    );
  }
  if (timeoutSignal.aborted) {
    return new VoicetextAdapterError(
      "timeout",
      "Voicetext " + fallbackCode.replaceAll("_", " ") + " timed out",
      true,
      { cause: error },
    );
  }
  if (error instanceof VoicetextAdapterError || error instanceof VoicetextTransportError) {
    return error;
  }
  return new VoicetextAdapterError(
    fallbackCode,
    "Voicetext " + fallbackCode.replaceAll("_", " "),
    fallbackCode !== "transcode_failed",
    { cause: error },
  );
}

export function addVoicetextFinalSafeIntegers(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new VoicetextAdapterError(
      "invalid_provider_response",
      "Voicetext returned a timestamp outside the supported range",
      false,
    );
  }
  return result;
}

export function compareVoicetextFinalTurns(
  left: VoicetextFinalProviderTurn,
  right: VoicetextFinalProviderTurn,
): number {
  return left.startMs - right.startMs ||
    left.endMs - right.endMs ||
    left.speakerId.localeCompare(right.speakerId) ||
    left.stableTurnId.localeCompare(right.stableTurnId);
}

export function stableVoicetextFinalId(
  kind: string,
  idempotencyKey: string,
  ...parts: readonly string[]
): string {
  return [kind, "v1", encodeVoicetextFinalIdentityPart(idempotencyKey), ...parts.map(
    encodeVoicetextFinalIdentityPart,
  )].join(":");
}

export function stableVoicetextFinalSessionUuid(...parts: readonly string[]): string {
  const bytes = createHash("sha256")
    .update(parts.map(encodeVoicetextFinalIdentityPart).join(":"), "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function encodeVoicetextFinalIdentityPart(value: string): string {
  return value.length + ":" + value;
}
