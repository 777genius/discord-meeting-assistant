import {
  type FinalTranscriptionFailure,
} from "@discord-meeting/meeting-core/transcription";

export type VoicetextAdapterErrorCode =
  | "artifact_read_failed"
  | "cancelled"
  | "idempotency_conflict"
  | "live_admission_rejected"
  | "live_provider_terminal"
  | "live_acceptance_unknown"
  | "invalid_input"
  | "invalid_provider_response"
  | "limit_exceeded"
  | "protocol_error"
  | "provider_error"
  | "quota_exceeded"
  | "rate_limited"
  | "request_failed"
  | "timeout"
  | "transcode_failed"
  | "transport_error";

export interface VoicetextAdapterErrorOptions extends ErrorOptions {
  /** Bounded server retry hint. It is never derived from a response body. */
  readonly retryAfterMs?: number;
  readonly gatewayCode?: string;
  readonly failureClass?: "known_accepted_terminal";
}

export class VoicetextAdapterError extends Error {
  public readonly retryAfterMs?: number;
  public readonly gatewayCode?: string;
  public readonly failureClass?: "known_accepted_terminal";

  public constructor(
    public readonly code: VoicetextAdapterErrorCode,
    message: string,
    public readonly retryable: boolean,
    options: VoicetextAdapterErrorOptions = {},
  ) {
    super(message, options);
    this.name = "VoicetextAdapterError";
    if (options.gatewayCode !== undefined) { this.gatewayCode = options.gatewayCode; }
    if (options.failureClass !== undefined) { this.failureClass = options.failureClass; }
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}

export type VoicetextTransportErrorKind =
  | "closed"
  | "handshake"
  | "network";

export class VoicetextTransportError extends Error {
  public constructor(
    public readonly kind: VoicetextTransportErrorKind,
    message: string,
    public readonly details: {
      readonly closeCode?: number;
      readonly status?: number;
    } = {},
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "VoicetextTransportError";
  }
}

export function toVoicetextPortFailure(error: unknown): FinalTranscriptionFailure {
  if (error instanceof VoicetextAdapterError) {
    return {
      code: `VOICETEXT_TRANSCRIPTION_${error.code.toUpperCase()}`,
      message: error.message,
      retryable: error.retryable,
    };
  }

  if (error instanceof VoicetextTransportError) {
    return {
      code: "VOICETEXT_TRANSCRIPTION_TRANSPORT_ERROR",
      message: "Voicetext WebSocket transport failed",
      retryable: transportErrorIsRetryable(error),
    };
  }

  return {
    code: "VOICETEXT_TRANSCRIPTION_TRANSPORT_ERROR",
    message: "Voicetext transcription failed",
    retryable: true,
  };
}

function transportErrorIsRetryable(error: VoicetextTransportError): boolean {
  if (error.kind === "handshake") {
    const { status } = error.details;
    return status === undefined || status === 408 || status === 425 || status === 429 || status >= 500;
  }
  if (error.kind === "closed") {
    return error.details.closeCode !== 1_008 && error.details.closeCode !== 1_009;
  }
  return true;
}

/** Normalize only confirmed wire evidence, never an arbitrary retryable property. */
export function liveProviderError(message: {
  readonly code: string; readonly message: string;
  readonly failureClass?: "known_accepted_terminal";
}): VoicetextAdapterError {
  const terminal = message.code === "PROVIDER_TERMINAL" ||
    message.failureClass === "known_accepted_terminal";
  const unknown = message.code === "PROVIDER_OUTCOME_UNKNOWN";
  return new VoicetextAdapterError(
    terminal ? "live_provider_terminal" : unknown ? "live_acceptance_unknown" : "provider_error",
    message.message, !terminal && !unknown,
    { gatewayCode: message.code,
      ...(message.failureClass === undefined ? {} : { failureClass: message.failureClass }) },
  );
}
