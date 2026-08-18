import { VoicetextAdapterError } from "./errors.js";
import type { VoicetextLiveContractIdentity } from "./voicetext-live-transcription-configuration.js";

export interface VoicetextFinalSegment {
  readonly confidence?: number;
  readonly durationMs: number;
  readonly startMs: number;
  readonly text: string;
}

export interface VoicetextPartialSegment {
  readonly confidence?: number;
  readonly durationMs: number;
  readonly startMs: number;
  readonly text: string;
}

export type VoicetextServerMessage =
  | ({ readonly sessionId: string; readonly type: "ready" } & VoicetextLiveContractIdentity)
  | { readonly seq: number; readonly type: "ack" }
  | ({ readonly type: "final" } & VoicetextFinalSegment)
  | { readonly segment: VoicetextPartialSegment | null; readonly type: "partial" }
  | ({ readonly type: "segment_final" } & VoicetextFinalSegment)
  | { readonly type: "usage_update" }
  | { readonly code: string; readonly message: string; readonly type: "error" }
  | {
    readonly sawResult: boolean;
    readonly status: "flushed" | "no_provider" | "timeout";
    readonly type: "finalize_complete";
  }
  | { readonly type: "resumed" };

interface VoicetextConfigBase {
  readonly capabilities: readonly ["finalize_ack"];
  readonly channels: 1;
  readonly client_session_id: string;
  readonly keyterms?: readonly string[];
  readonly language: string;
  readonly model: "nova-3" | "scribe_v2_realtime";
  readonly protocol_v: 2;
  readonly provider: "deepgram" | "elevenlabs";
  readonly type: "config";
}

export type VoicetextConfigMessage = VoicetextConfigBase & (
  | { readonly encoding: "opus"; readonly sample_rate: 48_000 }
  | { readonly encoding: "pcm_s16le"; readonly sample_rate: 16_000 }
);

export function parseServerMessage(
  raw: string,
  maxTranscriptChars: number,
  expectedIdentity: VoicetextLiveContractIdentity = {
    model: "nova-3",
    provider: "deepgram",
  },
): VoicetextServerMessage {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw protocolError("Voicetext returned malformed JSON", error);
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    throw protocolError("Voicetext returned a malformed protocol message");
  }

  switch (value.type) {
    case "ready":
      return parseReady(value, expectedIdentity);
    case "ack":
      return parseAcknowledgement(value);
    case "partial":
      return value.is_segment_final === true
        ? { ...parseFinalSegment(value, maxTranscriptChars), type: "segment_final" }
        : { segment: parsePartialSegment(value, maxTranscriptChars), type: "partial" };
    case "usage_update":
      return { type: "usage_update" };
    case "final":
      return parseFinalSegment(value, maxTranscriptChars);
    case "error":
      return parseError(value);
    case "finalize_complete":
      return parseFinalizeComplete(value);
    case "resumed":
      return { type: "resumed" };
    default:
      throw protocolError(`Voicetext returned unsupported protocol message type ${value.type}`);
  }
}

function parseReady(
  value: Readonly<Record<string, unknown>>,
  expectedIdentity: VoicetextLiveContractIdentity,
): Extract<VoicetextServerMessage, { readonly type: "ready" }> {
  if (
    typeof value.session_id !== "string" ||
    !uuidPattern.test(value.session_id) ||
    value.provider !== expectedIdentity.provider ||
    value.model !== expectedIdentity.model
  ) {
    throw protocolError("Voicetext returned an invalid ready message");
  }
  return {
    model: expectedIdentity.model,
    provider: expectedIdentity.provider,
    sessionId: value.session_id,
    type: "ready",
  };
}

function parseAcknowledgement(
  value: Readonly<Record<string, unknown>>,
): Extract<VoicetextServerMessage, { readonly type: "ack" }> {
  if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 1) {
    throw protocolError("Voicetext returned an invalid audio acknowledgement");
  }
  return { seq: value.seq as number, type: "ack" };
}

function parseError(
  value: Readonly<Record<string, unknown>>,
): Extract<VoicetextServerMessage, { readonly type: "error" }> {
  if (
    typeof value.code !== "string" ||
    value.code.length < 1 ||
    value.code.length > 128 ||
    typeof value.message !== "string" ||
    value.message.length > 2_048
  ) {
    throw protocolError("Voicetext returned an invalid error message");
  }
  return { code: value.code, message: value.message, type: "error" };
}

function parseFinalizeComplete(
  value: Readonly<Record<string, unknown>>,
): Extract<VoicetextServerMessage, { readonly type: "finalize_complete" }> {
  if (
    (value.status !== "flushed" &&
      value.status !== "timeout" &&
      value.status !== "no_provider") ||
    typeof value.saw_result !== "boolean"
  ) {
    throw protocolError("Voicetext returned an invalid finalize acknowledgement");
  }
  return {
    sawResult: value.saw_result,
    status: value.status,
    type: "finalize_complete",
  };
}

function parsePartialSegment(
  value: Readonly<Record<string, unknown>>,
  maxTranscriptChars: number,
): VoicetextPartialSegment | null {
  try {
    const parsed = parseFinalSegment(value, maxTranscriptChars);
    return {
      ...(parsed.confidence === undefined ? {} : { confidence: parsed.confidence }),
      durationMs: parsed.durationMs,
      startMs: parsed.startMs,
      text: parsed.text,
    };
  } catch {
    // Final transcription historically tolerated provider-specific partial
    // shapes. Live consumers receive only fully validated partial segments.
    return null;
  }
}

function parseFinalSegment(
  value: Readonly<Record<string, unknown>>,
  maxTranscriptChars: number,
): { readonly type: "final" } & VoicetextFinalSegment {
  if (
    typeof value.text !== "string" ||
    value.text.length > maxTranscriptChars ||
    !Number.isSafeInteger(value.start_ms) ||
    (value.start_ms as number) < 0 ||
    !Number.isSafeInteger(value.duration_ms) ||
    (value.duration_ms as number) < 0 ||
    (value.confidence !== undefined &&
      (typeof value.confidence !== "number" ||
        !Number.isFinite(value.confidence) ||
        value.confidence < 0 ||
        value.confidence > 1))
  ) {
    throw protocolError("Voicetext returned an invalid final transcript segment");
  }

  return {
    ...(value.confidence === undefined ? {} : { confidence: value.confidence }),
    durationMs: value.duration_ms as number,
    startMs: value.start_ms as number,
    text: value.text,
    type: "final",
  };
}

function protocolError(message: string, cause?: unknown): VoicetextAdapterError {
  return new VoicetextAdapterError(
    "protocol_error",
    message,
    false,
    cause === undefined ? {} : { cause },
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
