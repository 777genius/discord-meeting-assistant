import type {
  VoicetextBatchContractIdentity,
  VoicetextBatchTaskResult,
  VoicetextBatchUtterance,
} from "./voicetext-batch-contract.js";
import { VoicetextAdapterError } from "./errors.js";

const maximumProviderRequestIdCharacters = 256;
const maximumRetryAfterMilliseconds = 3_600_000;
const maximumTranscriptCharacters = 1_000_000;
const maximumUtterances = 10_000;

export function parseVoicetextBatchV3Response(
  value: unknown,
  statusCode: number,
  identity: VoicetextBatchContractIdentity,
): VoicetextBatchTaskResult {
  const response = record(value);
  const jobId = validateIdentity(response, identity);
  if (statusCode === 202) {
    return parsePending(response, jobId);
  }
  if (response.success === false && response.status === "failed") {
    return parseFailed(response, jobId);
  }
  return parseCompleted(response, jobId, identity);
}

function parsePending(
  response: Readonly<Record<string, unknown>>,
  jobId: string,
): VoicetextBatchTaskResult {
  const nextAction = response.next_action;
  if (
    response.success !== true ||
    response.status !== "running" ||
    (nextAction !== "poll" && nextAction !== "retry")
  ) {
    throw invalidResponse();
  }
  return {
    jobId,
    kind: "pending",
    nextAction,
    retryAfterMs: boundedInteger(response.retry_after_ms, maximumRetryAfterMilliseconds),
  };
}

function parseFailed(
  response: Readonly<Record<string, unknown>>,
  jobId: string,
): VoicetextBatchTaskResult {
  if (response.retryable !== false) {
    throw invalidResponse();
  }
  return {
    errorCode: safeErrorCode(response.error_code),
    jobId,
    kind: "failed",
    retryable: false,
  };
}

function parseCompleted(
  response: Readonly<Record<string, unknown>>,
  jobId: string,
  identity: VoicetextBatchContractIdentity,
): VoicetextBatchTaskResult {
  if (response.success !== true || response.status !== "completed") {
    throw invalidResponse();
  }
  const result = record(response.result);
  if (
    result.result_id !== jobId ||
    result.provider !== identity.provider ||
    result.model !== identity.model ||
    result.language !== identity.language ||
    !isBoundedString(result.text, maximumTranscriptCharacters)
  ) {
    throw invalidResponse();
  }
  validateProviderRequest(result.provider_request);
  const durationMs = boundedInteger(result.duration_ms, Number.MAX_SAFE_INTEGER);
  const segmentValues = array(result.segments);
  if (
    segmentValues.length > maximumUtterances ||
    (result.text.length === 0) !== (segmentValues.length === 0) ||
    (result.text.length > 0 && result.text.trim().length === 0)
  ) {
    throw invalidResponse();
  }
  let previousEndMs = 0;
  const utterances = segmentValues.map((segmentValue, index) => {
    const parsed = parseSegment(segmentValue, index, previousEndMs, durationMs);
    previousEndMs = Math.round(parsed.endSeconds * 1_000);
    return parsed;
  });
  return {
    jobId,
    kind: "completed",
    result: {
      durationSeconds: durationMs / 1_000,
      readableSegments: [],
      utterances,
    },
  };
}

function validateIdentity(
  response: Readonly<Record<string, unknown>>,
  identity: VoicetextBatchContractIdentity,
): string {
  if (
    response.contract_version !== Number(identity.contractVersion) ||
    response.provider !== identity.provider ||
    response.model !== identity.model ||
    response.language !== identity.language
  ) {
    throw invalidResponse();
  }
  return validateJobId(response.job_id);
}

function parseSegment(
  value: unknown,
  expectedIndex: number,
  previousEndMs: number,
  durationMs: number,
): VoicetextBatchUtterance {
  const segment = record(value);
  const index = boundedInteger(segment.index, maximumUtterances);
  const startMs = boundedInteger(segment.start_ms, durationMs);
  const endMs = boundedInteger(segment.end_ms, durationMs);
  if (
    index !== expectedIndex ||
    startMs < previousEndMs ||
    endMs <= startMs ||
    !isBoundedNonEmptyString(segment.text, maximumTranscriptCharacters)
  ) {
    throw invalidResponse();
  }
  const confidence = segment.confidence;
  if (
    confidence !== undefined &&
    confidence !== null &&
    (typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1)
  ) {
    throw invalidResponse();
  }
  return {
    ...(typeof confidence === "number" ? { confidence } : {}),
    endSeconds: endMs / 1_000,
    startSeconds: startMs / 1_000,
    transcript: segment.text,
  };
}

function validateProviderRequest(value: unknown): void {
  if (value === undefined) {
    return;
  }
  const providerRequest = record(value);
  if (
    Object.keys(providerRequest).length !== 1 ||
    typeof providerRequest.id !== "string" ||
    providerRequest.id.length === 0 ||
    providerRequest.id.length > maximumProviderRequestIdCharacters ||
    !/^[\x20-\x7e]+$/u.test(providerRequest.id)
  ) {
    throw invalidResponse();
  }
}

function validateJobId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(value)
  ) {
    throw invalidResponse();
  }
  return value.toLowerCase();
}

function safeErrorCode(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z0-9_]{1,128}$/u.test(value)) {
    throw invalidResponse();
  }
  return value;
}

function boundedInteger(value: unknown, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    throw invalidResponse();
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidResponse();
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw invalidResponse();
  }
  return value;
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length <= maximumLength;
}

function isBoundedNonEmptyString(value: unknown, maximumLength: number): value is string {
  return isBoundedString(value, maximumLength) && value.trim().length > 0;
}

function invalidResponse(): VoicetextAdapterError {
  return new VoicetextAdapterError(
    "invalid_provider_response",
    "Voicetext batch endpoint returned an invalid response",
    false,
  );
}
