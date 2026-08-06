import {
  type FinalTranscriptionFailure,
} from "@discord-meeting/meeting-core/transcription";

export type SpeachesAdapterErrorCode =
  | "artifact_read_failed"
  | "cancelled"
  | "invalid_input"
  | "invalid_provider_response"
  | "request_failed"
  | "timeout";

export class SpeachesAdapterError extends Error {
  public constructor(
    public readonly code: SpeachesAdapterErrorCode,
    message: string,
    public readonly retryable: boolean,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "SpeachesAdapterError";
  }
}

export type SpeachesClientErrorKind = "http" | "invalid_response";

export class SpeachesClientError extends Error {
  public constructor(
    public readonly kind: SpeachesClientErrorKind,
    message: string,
    public readonly status?: number,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "SpeachesClientError";
  }
}

export function toSpeachesPortFailure(error: unknown): FinalTranscriptionFailure {
  if (error instanceof SpeachesAdapterError) {
    return {
      code: `SPEACHES_TRANSCRIPTION_${error.code.toUpperCase()}`,
      message: error.message,
      retryable: error.retryable,
    };
  }

  if (error instanceof SpeachesClientError) {
    if (error.kind === "invalid_response") {
      return {
        code: "SPEACHES_TRANSCRIPTION_INVALID_PROVIDER_RESPONSE",
        message: "Speaches returned an invalid transcription response",
        retryable: false,
      };
    }

    return {
      code: "SPEACHES_TRANSCRIPTION_REQUEST_FAILED",
      message: "Speaches transcription request failed",
      retryable: isRetryableHttpStatus(error.status),
    };
  }

  return {
    code: "SPEACHES_TRANSCRIPTION_REQUEST_FAILED",
    message: "Speaches transcription request failed",
    retryable: true,
  };
}

function isRetryableHttpStatus(status: number | undefined): boolean {
  return (
    status === undefined ||
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}
