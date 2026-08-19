import { VoicetextAdapterError } from "./errors.js";
import {
  defaultVoicetextBatchProfile,
  voicetextBatchContractIdentity,
  type VoicetextBatchProfile,
  type VoicetextBatchTaskResult,
} from "./voicetext-batch-contract.js";
import {
  invalidVoicetextBatchResponse,
  parseVoicetextBatchTaskResponse,
  validateVoicetextBatchJobId,
} from "./voicetext-batch-response.js";

export type {
  VoicetextBatchProfile,
  VoicetextBatchReadableSegment,
  VoicetextBatchTaskResult,
  VoicetextBatchTranscriptionResult,
  VoicetextBatchUtterance,
} from "./voicetext-batch-contract.js";

const maximumAudioBytes = 64 * 1_024 * 1_024;

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

/** HTTP boundary for one authenticated, profile-fixed VoiceText batch job. */
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
  readonly profile?: VoicetextBatchProfile;
  readonly token: string;
}

export class FetchVoicetextBatchClient implements VoicetextBatchClient {
  private readonly authorization: string;
  private readonly identity: ReturnType<typeof voicetextBatchContractIdentity>;
  private readonly endpoint: URL;

  public constructor(
    options: FetchVoicetextBatchClientOptions,
    private readonly fetchImplementation: VoicetextBatchFetch = globalThis.fetch,
  ) {
    this.endpoint = validateBatchEndpoint(options.endpoint);
    this.identity = voicetextBatchContractIdentity(options.profile ?? defaultVoicetextBatchProfile);
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
    const multipart = deterministicMultipartBody(
      request.audio,
      request.idempotencyKey,
      this.identity,
      validateKeyterms(request.keyterms),
    );

    const response = await this.request(this.endpoint, {
      body: multipart.body,
      headers: {
        Authorization: this.authorization,
        "Content-Type": multipart.contentType,
        "X-Idempotency-Key": request.idempotencyKey,
      },
      method: "POST",
      redirect: "error",
      signal: request.signal,
    });
    return await parseVoicetextBatchTaskResponse(response, this.identity);
  }

  public async poll(
    request: VoicetextBatchPollRequest,
  ): Promise<VoicetextBatchTaskResult> {
    const jobId = validateVoicetextBatchJobId(request.jobId);
    const response = await this.request(batchJobEndpoint(this.endpoint, jobId), {
      headers: { Authorization: this.authorization },
      method: "GET",
      redirect: "error",
      signal: request.signal,
    });
    const result = await parseVoicetextBatchTaskResponse(response, this.identity);
    if (result.jobId !== jobId) {
      throw invalidVoicetextBatchResponse();
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

function deterministicMultipartBody(
  audio: Uint8Array,
  idempotencyKey: string,
  identity: ReturnType<typeof voicetextBatchContractIdentity>,
  keyterms: readonly string[],
): Readonly<{ body: Blob; contentType: string }> {
  let boundary = `discord-meeting-${idempotencyKey}`;
  const audioBytes = Buffer.from(audio);
  while (audioBytes.includes(Buffer.from(`\r\n--${boundary}`, "utf8"))) {
    boundary += "-x";
    if (boundary.length > 200) {
      throw new VoicetextAdapterError("invalid_input", "audio cannot be encoded safely", false);
    }
  }
  const fields = [
    ["contract_version", identity.contractVersion],
    ["provider", identity.provider],
    ["model", identity.model],
    ["language", identity.language],
    ["keyterms", JSON.stringify(keyterms)],
  ] as const;
  const parts: Array<string | Uint8Array> = fields.map(([name, value]) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speaker-track.ogg"\r\n` +
      "Content-Type: audio/ogg\r\n\r\n",
    audio,
    `\r\n--${boundary}--\r\n`,
  );
  return Object.freeze({
    body: new Blob(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  });
}

/** Converts the configured live WSS origin to its same-origin batch URL. */
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
      "Voicetext batch endpoint must be a credential-free batch HTTP(S) URL",
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
