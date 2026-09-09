import type { OssNativeEvidenceSink } from "./oss-native-evidence.js";
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
  readonly evidenceSink?: OssNativeEvidenceSink;
  readonly audioAckTimeoutMs?: number;
  readonly endpoint: string;
  readonly finalizeTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly keyterms?: readonly string[];
  readonly language?: string;
  readonly maxInboundFrameBytes?: number;
  readonly maxTranscriptCharsPerSegment?: number;
  readonly profile?: VoicetextLiveProfile;
  readonly readyTimeoutMs?: number;
  readonly token: string;
}

export type VoicetextLiveProfile =
  | "deepgram-nova-3"
  | "elevenlabs-scribe-v2-realtime";

export interface VoicetextLiveContractIdentity {
  readonly model: "nova-3" | "scribe_v2_realtime";
  readonly provider: "deepgram" | "elevenlabs";
}

export interface ValidatedVoicetextLiveTranscriptionOptions {
  readonly evidenceSink?: OssNativeEvidenceSink;
  readonly audioAckTimeoutMs: number;
  readonly authorization: string;
  readonly endpoint: URL;
  readonly finalizeTimeoutMs: number;
  readonly handshakeTimeoutMs: number;
  readonly keyterms: readonly string[];
  readonly language: string;
  readonly maxInboundFrameBytes: number;
  readonly maxTranscriptCharsPerSegment: number;
  readonly identity: VoicetextLiveContractIdentity;
  readonly readyTimeoutMs: number;
}

export function validateVoicetextLiveTranscriptionOptions(
  options: VoicetextLiveTranscriptionOptions,
): ValidatedVoicetextLiveTranscriptionOptions {
  try {
    return validateOptions(options);
  } catch (error) {
    if (!(error instanceof VoicetextAdapterError) && !(error instanceof TypeError)) { throw error; }
    throw new VoicetextAdapterError("live_admission_rejected", "Live configuration rejected before connection", false);
  }
}

function validateOptions(options: VoicetextLiveTranscriptionOptions): ValidatedVoicetextLiveTranscriptionOptions {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== "wss:" && endpoint.protocol !== "ws:") {
    throw new VoicetextAdapterError("invalid_input", "Voicetext endpoint must use WebSocket", false);
  }
  const token = options.token.trim();
  if (token.length < 16 || /\s/u.test(token)) {
    throw new VoicetextAdapterError("invalid_input", "Voicetext token is malformed", false);
  }
  const language = options.language?.trim();
  const identity = voicetextLiveContractIdentity(options.profile ?? "deepgram-nova-3");
  const resolvedLanguage = language === undefined || language.length === 0 ? "ru" : language;
  if (!/^[a-zA-Z0-9-]{1,10}$/u.test(resolvedLanguage) ||
      (identity.provider === "deepgram" && (resolvedLanguage.startsWith("-") || resolvedLanguage.endsWith("-")))) {
    throw new VoicetextAdapterError("invalid_input", "Live language exceeds profile capabilities", false);
  }
  const keyterms = validateLiveKeyterms(options.keyterms ?? [], identity);
  return {
    ...(options.evidenceSink === undefined ? {} : { evidenceSink: options.evidenceSink }),
    audioAckTimeoutMs: boundedLiveInteger(options.audioAckTimeoutMs, 10_000, 100, 120_000),
    authorization: "Bearer " + token,
    endpoint,
    finalizeTimeoutMs: boundedLiveInteger(options.finalizeTimeoutMs, 30_000, 100, 300_000),
    handshakeTimeoutMs: boundedLiveInteger(options.handshakeTimeoutMs, 10_000, 100, 120_000),
    keyterms,
    language: resolvedLanguage,
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
    identity,
    readyTimeoutMs: boundedLiveInteger(options.readyTimeoutMs, 15_000, 100, 120_000),
  };
}

function voicetextLiveContractIdentity(
  profile: string,
): VoicetextLiveContractIdentity {
  if (profile === "deepgram-nova-3") {
    return { model: "nova-3", provider: "deepgram" };
  }
  if (profile === "elevenlabs-scribe-v2-realtime") {
    return { model: "scribe_v2_realtime", provider: "elevenlabs" };
  }
  throw new VoicetextAdapterError(
    "invalid_input",
    "Voicetext live profile is unsupported",
    false,
  );
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

function validateLiveKeyterms(terms: readonly string[], identity: VoicetextLiveContractIdentity): readonly string[] {
  const keyterms = [...new Set(terms.map((value) => value.replace(/\p{White_Space}+/gu, " ").trim()).filter(Boolean))];
  if (keyterms.length > 100 || keyterms.some((term) => term.length > 256 || /[\p{Cc}]/u.test(term) || !term.isWellFormed() || (identity.provider === "deepgram" && new TextEncoder().encode(term).length > 256)) ||
      keyterms.reduce((sum, term) => sum + term.length, 0) > 8_192 ||
      (identity.provider === "elevenlabs" && (keyterms.length > 50 || keyterms.some((term) => Array.from(term).length > 20)))) {
    throw new VoicetextAdapterError("invalid_input", "Live keyterms exceed profile capabilities", false);
  }
  return keyterms;
}
