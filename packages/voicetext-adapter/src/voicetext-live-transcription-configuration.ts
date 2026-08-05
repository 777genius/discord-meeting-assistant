import { VoicetextAdapterError } from "./errors.js";

export interface VoicetextLiveTranscriptEvent {
  readonly confidence?: number;
  readonly endMs: number;
  readonly isFinal: boolean;
  readonly meetingId: string;
  readonly speakerId: string;
  readonly startMs: number;
  readonly text: string;
}

export interface VoicetextLivePacket {
  readonly durationSamples48Khz: number;
  readonly opus: Uint8Array;
  readonly packetId: string;
  readonly relativeTimeMs: number;
}

export interface OpenVoicetextLiveSessionRequest {
  readonly idempotencyKey: string;
  readonly meetingId: string;
  readonly onTranscript: (event: VoicetextLiveTranscriptEvent) => void;
  readonly signal?: AbortSignal;
  readonly speakerId: string;
}

export interface VoicetextLiveSession {
  finalize(): Promise<void>;
  sendPacket(packet: VoicetextLivePacket): Promise<"accepted" | "reused">;
  terminate(): void;
}

export interface VoicetextLiveTranscriptionOptions {
  readonly audioAckTimeoutMs?: number;
  readonly endpoint: string;
  readonly finalizeTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly keyterms?: readonly string[];
  readonly language?: string;
  readonly maxInboundFrameBytes?: number;
  readonly maxTranscriptCharsPerSegment?: number;
  readonly readyTimeoutMs?: number;
  readonly token: string;
}

export interface ValidatedVoicetextLiveTranscriptionOptions {
  readonly audioAckTimeoutMs: number;
  readonly authorization: string;
  readonly endpoint: URL;
  readonly finalizeTimeoutMs: number;
  readonly handshakeTimeoutMs: number;
  readonly keyterms: readonly string[];
  readonly language: string;
  readonly maxInboundFrameBytes: number;
  readonly maxTranscriptCharsPerSegment: number;
  readonly readyTimeoutMs: number;
}

export function validateVoicetextLiveTranscriptionOptions(
  options: VoicetextLiveTranscriptionOptions,
): ValidatedVoicetextLiveTranscriptionOptions {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== "wss:" && endpoint.protocol !== "ws:") {
    throw new VoicetextAdapterError("invalid_input", "Voicetext endpoint must use WebSocket", false);
  }
  const token = options.token.trim();
  if (token.length < 16 || /\s/u.test(token)) {
    throw new VoicetextAdapterError("invalid_input", "Voicetext token is malformed", false);
  }
  const language = options.language?.trim();
  return {
    audioAckTimeoutMs: boundedLiveInteger(options.audioAckTimeoutMs, 10_000, 100, 120_000),
    authorization: "Bearer " + token,
    endpoint,
    finalizeTimeoutMs: boundedLiveInteger(options.finalizeTimeoutMs, 30_000, 100, 300_000),
    handshakeTimeoutMs: boundedLiveInteger(options.handshakeTimeoutMs, 10_000, 100, 120_000),
    keyterms: [...new Set((options.keyterms ?? []).map((value) => value.trim()).filter(Boolean))],
    language: language === undefined || language.length === 0 ? "ru" : language,
    maxInboundFrameBytes: boundedLiveInteger(
      options.maxInboundFrameBytes,
      256 * 1_024,
      1_024,
      4 * 1_024 * 1_024,
    ),
    maxTranscriptCharsPerSegment: boundedLiveInteger(
      options.maxTranscriptCharsPerSegment,
      8_192,
      64,
      65_536,
    ),
    readyTimeoutMs: boundedLiveInteger(options.readyTimeoutMs, 15_000, 100, 120_000),
  };
}

export function validateVoicetextLiveIdentity(value: string, field: string): void {
  if (value.trim().length === 0 || value.length > 1_024 || value.includes("\0")) {
    throw new VoicetextAdapterError("invalid_input", field + " is invalid", false);
  }
}

export function createVoicetextLiveOperationSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent === undefined ? timeout : AbortSignal.any([parent, timeout]);
}

function boundedLiveInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new VoicetextAdapterError("invalid_input", "Live option is outside its bound", false);
  }
  return candidate;
}
