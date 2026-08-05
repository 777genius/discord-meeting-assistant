import type {
  VoicetextBatchTaskResult,
  VoicetextBatchUtterance,
} from "./voicetext-batch-contract.js";
import {
  voicetextBatchLanguage,
  voicetextBatchModel,
  voicetextBatchProvider,
} from "./voicetext-batch-contract.js";
import { VoicetextAdapterError } from "./errors.js";

const maximumResponseBytes = 2 * 1_024 * 1_024;
const maximumRetryAfterMilliseconds = 3_600_000;
const maximumUtterances = 10_000;
const maximumTranscriptCharacters = 1_000_000;

export async function parseVoicetextBatchTaskResponse(
  response: Response,
): Promise<VoicetextBatchTaskResult> {
  if (response.status === 409) {
    await discardVoicetextBatchResponse(response);
    throw new VoicetextAdapterError(
      "idempotency_conflict",
      "Voicetext rejected a conflicting batch idempotency key",
      false,
    );
  }
  if (response.status !== 200 && response.status !== 202) {
    const serviceErrorCode = response.headers.get("x-voicetext-error-code");
    await discardVoicetextBatchResponse(response);
    if (serviceErrorCode === "LIMIT_EXCEEDED") {
      throw new VoicetextAdapterError(
        "quota_exceeded",
        "Voicetext batch quota is exhausted",
        false,
      );
    }
    const retryable = isRetryableStatus(response.status);
    const retryAfterMs = retryable
      ? retryAfterMilliseconds(response.headers.get("retry-after"))
      : undefined;
    throw new VoicetextAdapterError(
      serviceErrorCode === "RATE_LIMIT_EXCEEDED" ? "rate_limited" : "request_failed",
      "Voicetext batch request failed",
      retryable,
      retryAfterMs === undefined ? {} : { retryAfterMs },
    );
  }
  const payload = await readJson(response);
  return response.status === 202 ? parsePending(payload) : parseFinal(payload);
}

export function validateVoicetextBatchJobId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(value)
  ) {
    throw invalidVoicetextBatchResponse();
  }
  return value.toLowerCase();
}

export function invalidVoicetextBatchResponse(): VoicetextAdapterError {
  return new VoicetextAdapterError(
    "invalid_provider_response",
    "Voicetext batch endpoint returned an invalid response",
    false,
  );
}

function parsePending(value: unknown): VoicetextBatchTaskResult {
  const response = record(value, "batch pending response");
  if (response.success !== true || response.status !== "running") {
    throw invalidVoicetextBatchResponse();
  }
  const nextAction = response.next_action;
  if (nextAction !== "poll" && nextAction !== "retry") {
    throw invalidVoicetextBatchResponse();
  }
  return {
    jobId: validateVoicetextBatchJobId(response.job_id),
    kind: "pending",
    nextAction,
    retryAfterMs: boundedNonNegativeInteger(response.retry_after_ms),
  };
}

function parseFinal(value: unknown): VoicetextBatchTaskResult {
  const response = record(value, "batch final response");
  if (
    response.success === false &&
    response.status === "failed" &&
    response.retryable === false
  ) {
    return {
      errorCode: safeErrorCode(response.error_code),
      jobId: validateVoicetextBatchJobId(response.job_id),
      kind: "failed",
      retryable: false,
    };
  }
  if (response.success !== true || response.status !== "completed") {
    throw invalidVoicetextBatchResponse();
  }
  const result = record(response.result, "batch transcription result");
  if (
    result.provider !== voicetextBatchProvider ||
    result.model !== voicetextBatchModel ||
    result.language !== voicetextBatchLanguage ||
    !isBoundedString(result.text, maximumTranscriptCharacters)
  ) {
    throw invalidVoicetextBatchResponse();
  }
  const durationSeconds = nonNegativeFiniteNumber(result.duration_seconds);
  const utteranceValues = array(result.utterances, "batch utterances");
  if (utteranceValues.length > maximumUtterances) {
    throw invalidVoicetextBatchResponse();
  }
  return {
    jobId: validateVoicetextBatchJobId(response.job_id),
    kind: "completed",
    result: {
      durationSeconds,
      utterances: utteranceValues.map(parseUtterance),
    },
  };
}

function parseUtterance(value: unknown): VoicetextBatchUtterance {
  const utterance = record(value, "batch utterance");
  const startSeconds = nonNegativeFiniteNumber(utterance.start);
  const endSeconds = nonNegativeFiniteNumber(utterance.end);
  if (
    endSeconds < startSeconds ||
    !isBoundedString(utterance.transcript, maximumTranscriptCharacters)
  ) {
    throw invalidVoicetextBatchResponse();
  }
  const confidence = utterance.confidence;
  if (
    confidence !== undefined &&
    (typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1)
  ) {
    throw invalidVoicetextBatchResponse();
  }
  return {
    ...(confidence === undefined ? {} : { confidence }),
    endSeconds,
    startSeconds,
    transcript: utterance.transcript,
  };
}

async function readJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximumResponseBytes) {
    await discardVoicetextBatchResponse(response);
    throw invalidVoicetextBatchResponse();
  }
  if (response.body === null) {
    throw invalidVoicetextBatchResponse();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let reachedEnd = false;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) {
        reachedEnd = true;
        break;
      }
      const chunk: unknown = item.value;
      if (!(chunk instanceof Uint8Array)) {
        throw invalidVoicetextBatchResponse();
      }
      byteLength += chunk.byteLength;
      if (byteLength > maximumResponseBytes) {
        throw invalidVoicetextBatchResponse();
      }
      chunks.push(chunk);
    }
  } catch (error: unknown) {
    if (error instanceof VoicetextAdapterError) {
      throw error;
    }
    throw invalidVoicetextBatchResponse();
  } finally {
    try {
      if (!reachedEnd) {
        await reader.cancel();
      }
    } catch {
      // Preserve the bounded-response validation or stream read failure.
    } finally {
      reader.releaseLock();
    }
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw invalidVoicetextBatchResponse();
  }
}

async function discardVoicetextBatchResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The status is already known and no response content is used.
  }
}

function safeErrorCode(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z0-9_]{1,128}$/u.test(value)) {
    throw invalidVoicetextBatchResponse();
  }
  return value;
}

function boundedNonNegativeInteger(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 3_600_000
  ) {
    throw invalidVoicetextBatchResponse();
  }
  return value;
}

function nonNegativeFiniteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalidVoicetextBatchResponse();
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VoicetextAdapterError(
      "invalid_provider_response",
      `Voicetext ${label} is invalid`,
      false,
    );
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new VoicetextAdapterError(
      "invalid_provider_response",
      `Voicetext ${label} is invalid`,
      false,
    );
  }
  return value;
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length <= maximumLength;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (value === null || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isNaN(seconds)) {
    return undefined;
  }
  return seconds >= maximumRetryAfterMilliseconds / 1_000
    ? maximumRetryAfterMilliseconds
    : seconds * 1_000;
}
