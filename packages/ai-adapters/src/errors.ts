export type OpenAiAdapterErrorCode =
  | "invalid_input"
  | "invalid_provider_response"
  | "incomplete_response"
  | "refused_response"
  | "invalid_evidence";

export class OpenAiAdapterError extends Error {
  public readonly code: OpenAiAdapterErrorCode;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    code: OpenAiAdapterErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "OpenAiAdapterError";
    this.code = code;
    this.details = details;
  }
}

export type OpenAiOperation = "summary" | "transcription";

export interface OpenAiPortFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export function toOpenAiPortFailure(
  error: unknown,
  operation: OpenAiOperation,
): OpenAiPortFailure {
  const prefix = operation === "summary" ? "SUMMARY" : "TRANSCRIPTION";
  if (error instanceof OpenAiAdapterError) {
    const retryable = error.code === "incomplete_response";
    return {
      code: `OPENAI_${prefix}_${error.code.toUpperCase()}`,
      message: error.message,
      retryable,
    };
  }

  const status = readProviderStatus(error);
  return {
    code: `OPENAI_${prefix}_REQUEST_FAILED`,
    message: `OpenAI ${operation} request failed`,
    retryable:
      status === undefined ||
      status === 408 ||
      status === 409 ||
      status === 429 ||
      status >= 500,
  };
}

function readProviderStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }

  const { status } = error;
  return typeof status === "number" && Number.isSafeInteger(status) ? status : undefined;
}
