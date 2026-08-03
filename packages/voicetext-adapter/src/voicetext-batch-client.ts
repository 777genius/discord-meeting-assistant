import { VoicetextAdapterError } from "./errors.js";

const batchContractVersion = "2";
const batchLanguage = "multi";
const batchModel = "nova-3";
const batchProvider = "deepgram";
const maximumAudioBytes = 64 * 1_024 * 1_024;
const maximumResponseBytes = 2 * 1_024 * 1_024;
const maximumRetryAfterMilliseconds = 3_600_000;
const maximumUtterances = 10_000;
const maximumTranscriptCharacters = 1_000_000;

export interface VoicetextBatchUtterance {
  readonly confidence?: number;
  readonly endSeconds: number;
  readonly startSeconds: number;
  readonly transcript: string;
}

export interface VoicetextBatchTranscriptionResult {
  readonly durationSeconds: number;
  readonly utterances: readonly VoicetextBatchUtterance[];
}

export type VoicetextBatchTaskResult =
  | {
      readonly jobId: string;
      readonly kind: "completed";
      readonly result: VoicetextBatchTranscriptionResult;
    }
  | {
      readonly errorCode: string;
      readonly jobId: string;
      readonly kind: "failed";
      readonly retryable: false;
    }
  | {
      readonly jobId: string;
      readonly kind: "pending";
      readonly nextAction: "poll" | "retry";
      readonly retryAfterMs: number;
    };

export interface VoicetextBatchSubmitRequest {
  readonly audio: Uint8Array;
  readonly idempotencyKey: string;
  readonly keyterms: readonly string[];
  readonly signal: AbortSignal;
}

export interface VoicetextBatchPollRequest {
  readonly jobId: string;
  readonly signal: AbortSignal;
}

/** HTTP boundary for the authenticated Deepgram batch-v2 service contract. */
export interface VoicetextBatchClient {
  poll(request: VoicetextBatchPollRequest): Promise<VoicetextBatchTaskResult>;

  submit(request: VoicetextBatchSubmitRequest): Promise<VoicetextBatchTaskResult>;
}

export type VoicetextBatchFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface FetchVoicetextBatchClientOptions {
  readonly endpoint: string;
  readonly token: string;
}

export class FetchVoicetextBatchClient implements VoicetextBatchClient {
  private readonly authorization: string;
  private readonly endpoint: URL;

  public constructor(
    options: FetchVoicetextBatchClientOptions,
    private readonly fetchImplementation: VoicetextBatchFetch = globalThis.fetch,
  ) {
    this.endpoint = validateBatchEndpoint(options.endpoint);
    const token = requireNonEmpty(options.token, "token");
    if (token.length > 8_192 || containsAsciiControlCharacter(token)) {
      throw new VoicetextAdapterError("invalid_input", "token is invalid", false);
    }
    this.authorization = `Bearer ${token}`;
  }

  public async submit(
    request: VoicetextBatchSubmitRequest,
  ): Promise<VoicetextBatchTaskResult> {
    validateIdempotencyKey(request.idempotencyKey);
    validateAudio(request.audio);
    const form = new FormData();
    form.set("contract_version", batchContractVersion);
    form.set("provider", batchProvider);
    form.set("model", batchModel);
    form.set("language", batchLanguage);
    form.set("keyterms", JSON.stringify(validateKeyterms(request.keyterms)));
    // Avoid passing the object-store locator or any caller-controlled filename
    // to the remote service. The authenticated body is the only audio egress.
    form.set(
      "file",
      new Blob([request.audio], { type: "audio/ogg" }),
      "speaker-track.ogg",
    );

    const response = await this.request(this.endpoint, {
      body: form,
      headers: {
        Authorization: this.authorization,
        "X-Idempotency-Key": request.idempotencyKey,
      },
      method: "POST",
      redirect: "error",
      signal: request.signal,
    });
    return await parseTaskResponse(response);
  }

  public async poll(
    request: VoicetextBatchPollRequest,
  ): Promise<VoicetextBatchTaskResult> {
    const jobId = validateJobId(request.jobId);
    const response = await this.request(batchJobEndpoint(this.endpoint, jobId), {
      headers: { Authorization: this.authorization },
      method: "GET",
      redirect: "error",
      signal: request.signal,
    });
    const result = await parseTaskResponse(response);
    if (result.jobId !== jobId) {
      throw invalidResponse();
    }
    return result;
  }

  private async request(url: URL, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImplementation(url, init);
    } catch (error: unknown) {
      if (init.signal?.aborted === true) {
        throw error;
      }
      throw new VoicetextAdapterError(
        "transport_error",
        "Voicetext batch transport failed",
        true,
        { cause: error },
      );
    }
  }
}

/** Converts the configured live WSS origin to its same-origin batch-v2 URL. */
export function batchEndpointFromWebSocketUrl(webSocketUrl: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(webSocketUrl);
  } catch (error: unknown) {
    throw new VoicetextAdapterError(
      "invalid_input",
      "Voicetext WebSocket endpoint must be an absolute URL",
      false,
      { cause: error },
    );
  }
  if (
    endpoint.protocol !== "wss:" ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0
  ) {
    throw new VoicetextAdapterError(
      "invalid_input",
      "Voicetext WebSocket endpoint must be a credential-free WSS URL",
      false,
    );
  }
  endpoint.protocol = "https:";
  endpoint.pathname = "/api/v1/transcribe/batch";
  return endpoint.toString();
}

async function parseTaskResponse(response: Response): Promise<VoicetextBatchTaskResult> {
  if (response.status === 409) {
    await discardResponse(response);
    throw new VoicetextAdapterError(
      "idempotency_conflict",
      "Voicetext rejected a conflicting batch idempotency key",
      false,
    );
  }
  if (response.status !== 200 && response.status !== 202) {
    const serviceErrorCode = response.headers.get("x-voicetext-error-code");
    await discardResponse(response);
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

function parsePending(value: unknown): VoicetextBatchTaskResult {
  const response = record(value, "batch pending response");
  if (response.success !== true || response.status !== "running") {
    throw invalidResponse();
  }
  const nextAction = response.next_action;
  if (nextAction !== "poll" && nextAction !== "retry") {
    throw invalidResponse();
  }
  return {
    jobId: validateJobId(response.job_id),
    kind: "pending",
    nextAction,
    retryAfterMs: boundedNonNegativeInteger(response.retry_after_ms),
  };
}

function parseFinal(value: unknown): VoicetextBatchTaskResult {
  const response = record(value, "batch final response");
  if (response.success === false && response.status === "failed" && response.retryable === false) {
    return {
      errorCode: safeErrorCode(response.error_code),
      jobId: validateJobId(response.job_id),
      kind: "failed",
      retryable: false,
    };
  }
  if (response.success !== true || response.status !== "completed") {
    throw invalidResponse();
  }
  const result = record(response.result, "batch transcription result");
  if (
    result.provider !== batchProvider ||
    result.model !== batchModel ||
    result.language !== batchLanguage ||
    !isBoundedString(result.text, maximumTranscriptCharacters)
  ) {
    throw invalidResponse();
  }
  const durationSeconds = nonNegativeFiniteNumber(result.duration_seconds);
  const utteranceValues = array(result.utterances, "batch utterances");
  if (utteranceValues.length > maximumUtterances) {
    throw invalidResponse();
  }
  return {
    jobId: validateJobId(response.job_id),
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
  if (endSeconds < startSeconds || !isBoundedString(utterance.transcript, maximumTranscriptCharacters)) {
    throw invalidResponse();
  }
  const confidence = utterance.confidence;
  if (
    confidence !== undefined &&
    (typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1)
  ) {
    throw invalidResponse();
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
    await discardResponse(response);
    throw invalidResponse();
  }
  if (response.body === null) {
    throw invalidResponse();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) {
        break;
      }
      const chunk: unknown = item.value;
      if (!(chunk instanceof Uint8Array)) {
        throw invalidResponse();
      }
      byteLength += chunk.byteLength;
      if (byteLength > maximumResponseBytes) {
        throw invalidResponse();
      }
      chunks.push(chunk);
    }
  } catch (error: unknown) {
    if (error instanceof VoicetextAdapterError) {
      throw error;
    }
    throw invalidResponse();
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw invalidResponse();
  }
}

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The status is already known and no response content is used.
  }
}

function batchJobEndpoint(endpoint: URL, jobId: string): URL {
  const jobEndpoint = new URL(endpoint);
  jobEndpoint.pathname = `${jobEndpoint.pathname}/${jobId}`;
  return jobEndpoint;
}

function validateBatchEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch (error: unknown) {
    throw new VoicetextAdapterError(
      "invalid_input",
      "Voicetext batch endpoint must be an absolute HTTP(S) URL",
      false,
      { cause: error },
    );
  }
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0 ||
    endpoint.pathname !== "/api/v1/transcribe/batch"
  ) {
    throw new VoicetextAdapterError(
      "invalid_input",
      "Voicetext batch endpoint must be a credential-free batch-v2 HTTP(S) URL",
      false,
    );
  }
  return endpoint;
}

function validateIdempotencyKey(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new VoicetextAdapterError(
      "invalid_input",
      "Voicetext batch idempotency key must be a lowercase SHA-256 hex value",
      false,
    );
  }
}

function validateAudio(value: Uint8Array): void {
  if (
    value.byteLength < 27 ||
    value.byteLength > maximumAudioBytes ||
    Buffer.from(value.subarray(0, 4)).toString("ascii") !== "OggS" ||
    value[4] !== 0 ||
    value.byteLength < 27 + (value[26] ?? 0)
  ) {
    throw new VoicetextAdapterError(
      "invalid_input",
      "Voicetext batch audio must be one valid Ogg container",
      false,
    );
  }
}

function validateKeyterms(value: readonly string[]): readonly string[] {
  if (value.length > 100) {
    throw new VoicetextAdapterError("invalid_input", "Voicetext batch keyterms exceed 100 values", false);
  }
  if (value.some((entry) => typeof entry !== "string")) {
    throw new VoicetextAdapterError("invalid_input", "Voicetext batch keyterms are invalid", false);
  }
  const normalized = [...new Set(value.map((entry) => entry.trim()))].toSorted();
  if (normalized.some((entry) => entry.length === 0 || Buffer.byteLength(entry, "utf8") > 200)) {
    throw new VoicetextAdapterError("invalid_input", "Voicetext batch keyterms are invalid", false);
  }
  return normalized;
}

function validateJobId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(value)) {
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

function boundedNonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 3_600_000) {
    throw invalidResponse();
  }
  return value;
}

function nonNegativeFiniteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalidResponse();
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

function invalidResponse(): VoicetextAdapterError {
  return new VoicetextAdapterError(
    "invalid_provider_response",
    "Voicetext batch endpoint returned an invalid response",
    false,
  );
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

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new VoicetextAdapterError("invalid_input", `${field} must not be empty`, false);
  }
  return normalized;
}

function containsAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}
