import { createHash } from "node:crypto";

import { VoicetextAdapterError } from "./errors.js";
import type { VoicetextLivePacket } from "./voicetext-live-transcription-configuration.js";

const maximumOpusPacketBytes = 65_536;

export interface LiveSessionDeferred<Value> {
  readonly promise: Promise<Value>;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: Value) => void;
}

export function createLiveSessionDeferred<Value>(): LiveSessionDeferred<Value> {
  let resolveDeferred!: (value: Value) => void;
  let rejectDeferred!: (error: unknown) => void;
  const promise = new Promise<Value>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  // Packet acknowledgements are intentionally consumed later, during
  // backpressure or finalization. Attach a rejection observer immediately so
  // a transport failure cannot surface as an unhandled rejection in between.
  void promise.catch(() => {});
  return { promise, reject: rejectDeferred, resolve: resolveDeferred };
}

export function validateLiveSessionPacket(packet: VoicetextLivePacket): void {
  if (
    !Number.isSafeInteger(packet.relativeTimeMs) ||
    packet.relativeTimeMs < 0 ||
    !Number.isSafeInteger(packet.relativeTimeMs * 48) ||
    !Number.isSafeInteger(packet.durationSamples48Khz) ||
    packet.durationSamples48Khz < 120 ||
    packet.durationSamples48Khz > 5_760 ||
    packet.durationSamples48Khz % 120 !== 0 ||
    packet.opus.byteLength === 0 ||
    packet.opus.byteLength > maximumOpusPacketBytes
  ) {
    throw new VoicetextAdapterError("invalid_input", "Live Opus packet is invalid", false);
  }
}

export function validateLiveSessionFinalizeStatus(
  status: "flushed" | "no_provider" | "timeout",
  nextSequence: number,
): void {
  if (status === "timeout") {
    throw new VoicetextAdapterError(
      "provider_error",
      "Voicetext live finalize completed with timeout",
      true,
    );
  }
  if (status === "no_provider" && nextSequence > 0) {
    throw new VoicetextAdapterError(
      "provider_error",
      "Voicetext did not create a provider session for acknowledged audio",
      true,
    );
  }
  // no_provider is successful only for a genuinely empty session.
}

export function asLiveSessionError(error: unknown, fallbackMessage: string): Error {
  return error instanceof Error ? error : new Error(fallbackMessage, { cause: error });
}

export async function withLiveSessionTimeout<Value>(
  promise: Promise<Value>,
  timeoutMs: number,
  message: string,
): Promise<Value> {
  const timeout = createLiveSessionDeferred<Value>();
  const handle = setTimeout(() => {
    timeout.reject(new VoicetextAdapterError("timeout", message, true));
  }, timeoutMs);
  try {
    return await Promise.race([promise, timeout.promise]);
  } finally {
    clearTimeout(handle);
  }
}

export function stableLiveSessionUuid(...parts: readonly string[]): string {
  const hex = createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    "4" + hex.slice(13, 16),
    "8" + hex.slice(17, 20),
    hex.slice(20),
  ].join("-");
}
