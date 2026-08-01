import { SpeachesClientError } from "./errors.js";

export interface SpeachesTranscriptionRequest {
  readonly audio: Uint8Array;
  readonly fileName: string;
  readonly hotwords?: string;
  readonly idempotencyKey: string;
  readonly language?: string;
  readonly mediaType: string;
  readonly model: string;
  readonly prompt?: string;
  readonly signal: AbortSignal;
}

export interface SpeachesTranscriptionClient {
  createTranscription(request: SpeachesTranscriptionRequest): Promise<unknown>;
}

export type SpeachesFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class FetchSpeachesTranscriptionClient implements SpeachesTranscriptionClient {
  private readonly endpoint: URL;

  public constructor(
    baseUrl: string,
    private readonly fetchImplementation: SpeachesFetch = globalThis.fetch,
  ) {
    this.endpoint = transcriptionEndpoint(baseUrl);
  }

  public async createTranscription(
    request: SpeachesTranscriptionRequest,
  ): Promise<unknown> {
    const form = new FormData();
    const audioCopy = Uint8Array.from(request.audio);
    form.set("file", new Blob([audioCopy], { type: request.mediaType }), request.fileName);
    form.set("model", request.model);
    form.set("response_format", "verbose_json");
    form.set("temperature", "0");
    form.set("timestamp_granularities[]", "segment");
    form.set("stream", "false");
    form.set("without_timestamps", "false");
    if (request.language !== undefined) {
      form.set("language", request.language);
    }
    if (request.prompt !== undefined) {
      form.set("prompt", request.prompt);
    }
    if (request.hotwords !== undefined) {
      form.set("hotwords", request.hotwords);
    }

    const response = await this.fetchImplementation(this.endpoint, {
      body: form,
      headers: { "Idempotency-Key": request.idempotencyKey },
      method: "POST",
      signal: request.signal,
    });

    if (!response.ok) {
      await response.body?.cancel();
      throw new SpeachesClientError(
        "http",
        `Speaches transcription endpoint returned HTTP ${response.status}`,
        response.status,
      );
    }

    try {
      return await response.json();
    } catch (error: unknown) {
      throw new SpeachesClientError(
        "invalid_response",
        "Speaches transcription endpoint returned non-JSON content",
        response.status,
        { cause: error },
      );
    }
  }
}

function transcriptionEndpoint(baseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch (error: unknown) {
    throw new SpeachesClientError(
      "invalid_response",
      "Speaches base URL must be an absolute URL",
      undefined,
      { cause: error },
    );
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new SpeachesClientError(
      "invalid_response",
      "Speaches base URL must be a credential-free HTTP(S) URL",
    );
  }

  return new URL("/v1/audio/transcriptions", parsed);
}
