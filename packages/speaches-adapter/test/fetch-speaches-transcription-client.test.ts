import { describe, expect, it } from "vitest";

import { SpeachesClientError } from "../src/errors.js";
import {
  FetchSpeachesTranscriptionClient,
  type SpeachesFetch,
} from "../src/speaches-transcription-client.js";

describe("FetchSpeachesTranscriptionClient provider contract", () => {
  it("sends the Speaches v0.9 verbose timestamp contract without credentials", async () => {
    let capturedInput: string | URL | Request | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImplementation: SpeachesFetch = async (input, init) => {
      capturedInput = input;
      capturedInit = init;
      return Response.json({
        language: "ru",
        segments: [{ id: 1, start: 0, end: 1, text: "Привет, Craig" }],
        text: "Привет, Craig",
      });
    };
    const client = new FetchSpeachesTranscriptionClient(
      "http://127.0.0.1:8000",
      fetchImplementation,
    );
    const signal = new AbortController().signal;

    const result = await client.createTranscription({
      audio: Uint8Array.from([1, 2, 3]),
      fileName: "speaker-a.flac",
      hotwords: "Craig, Meeting Platform",
      idempotencyKey: "request-1",
      language: "ru",
      mediaType: "audio/flac",
      model: "Systran/faster-whisper-small",
      prompt: "Vocabulary: Craig, Meeting Platform",
      signal,
    });

    expect(capturedInput).toBeInstanceOf(URL);
    if (!(capturedInput instanceof URL)) {
      throw new Error("expected provider request URL");
    }
    expect(capturedInput.href).toBe("http://127.0.0.1:8000/v1/audio/transcriptions");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.signal).toBe(signal);
    expect(capturedInit?.headers).toEqual({ "Idempotency-Key": "request-1" });
    expect(JSON.stringify(capturedInit?.headers).toLowerCase()).not.toContain("authorization");

    const form = capturedInit?.body;
    expect(form).toBeInstanceOf(FormData);
    if (!(form instanceof FormData)) {
      throw new Error("expected multipart form data");
    }
    expect(form.get("model")).toBe("Systran/faster-whisper-small");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.get("timestamp_granularities[]")).toBe("segment");
    expect(form.get("without_timestamps")).toBe("false");
    expect(form.get("language")).toBe("ru");
    expect(form.get("prompt")).toBe("Vocabulary: Craig, Meeting Platform");
    expect(form.get("hotwords")).toBe("Craig, Meeting Platform");
    expect(form.get("file")).toMatchObject({
      name: "speaker-a.flac",
      size: 3,
      type: "audio/flac",
    });
    expect(result).toMatchObject({ text: "Привет, Craig" });
  });

  it("surfaces HTTP status for adapter retry classification", async () => {
    const client = new FetchSpeachesTranscriptionClient(
      "http://speaches:8000",
      async () => new Response("unavailable", { status: 503 }),
    );

    await expect(client.createTranscription(basicRequest())).rejects.toMatchObject({
      kind: "http",
      status: 503,
    });
  });

  it("rejects a successful non-JSON provider response", async () => {
    const client = new FetchSpeachesTranscriptionClient(
      "http://speaches:8000",
      async () => new Response("not-json", { status: 200 }),
    );

    await expect(client.createTranscription(basicRequest())).rejects.toEqual(
      expect.objectContaining<Partial<SpeachesClientError>>({
        kind: "invalid_response",
        status: 200,
      }),
    );
  });
});

function basicRequest() {
  return {
    audio: Uint8Array.from([1]),
    fileName: "speaker.wav",
    idempotencyKey: "request-1",
    mediaType: "audio/wav",
    model: "Systran/faster-whisper-small",
    signal: new AbortController().signal,
  } as const;
}
