import { describe, expect, it } from "vitest";

import type { AudioContent, AudioContentReader } from "../src/audio-content-reader.js";
import { OpenAiFinalTranscriptionAdapter } from "../src/openai-final-transcription-adapter.js";
import type {
  OpenAiTranscriptionClient,
  OpenAiTranscriptionRequest,
} from "../src/openai-client.js";

class FakeAudioContentReader implements AudioContentReader {
  public readonly locators: string[] = [];
  public readonly signals: Array<AbortSignal | undefined> = [];

  public constructor(private readonly content: Readonly<Record<string, AudioContent>>) {}

  public async read(
    audioLocator: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<AudioContent> {
    this.locators.push(audioLocator);
    this.signals.push(options.signal);
    const content = this.content[audioLocator];
    if (content === undefined) {
      throw new Error("fixture not found");
    }
    return content;
  }
}

class FakeOpenAiTranscriptionClient implements OpenAiTranscriptionClient {
  public readonly requests: OpenAiTranscriptionRequest[] = [];

  public constructor(private readonly responses: Readonly<Record<string, unknown>>) {}

  public async createTranscription(request: OpenAiTranscriptionRequest): Promise<unknown> {
    this.requests.push(request);
    return this.responses[request.fileName];
  }
}

describe("OpenAiFinalTranscriptionAdapter", () => {
  it("preserves speaker identities, meeting timing, and overlapping turns", async () => {
    const reader = new FakeAudioContentReader({
      "recording://speaker-a": {
        bytes: new Uint8Array([1, 2]),
        fileName: "speaker-a.flac",
        mediaType: "audio/flac",
      },
      "recording://speaker-b": {
        bytes: new Uint8Array([3, 4]),
        fileName: "speaker-b.flac",
        mediaType: "audio/flac",
      },
    });
    const client = new FakeOpenAiTranscriptionClient({
      "speaker-a.flac": {
        duration: 4,
        language: "en",
        text: "First speaker",
        segments: [{ id: 7, start: 0, end: 2.5, text: " First speaker " }],
      },
      "speaker-b.flac": {
        duration: 3,
        language: "en",
        text: "Second speaker",
        segments: [{ id: 3, start: 0.2, end: 1, text: "Second speaker" }],
      },
    });
    const adapter = new OpenAiFinalTranscriptionAdapter(client, reader, {
      language: "en",
      vocabulary: ["Craig", "Meeting Platform"],
    });

    const result = await adapter.transcribe({
      idempotencyKey: "transcription-key",
      meetingId: "meeting-1",
      recording: {
        recordingId: "recording-1",
        manifestLocator: "recording://manifest",
        speakerAudio: [
          {
            audioLocator: "recording://speaker-a",
            speakerId: "discord-user-a",
            timelineOffsetMs: 0,
          },
          {
            audioLocator: "recording://speaker-b",
            speakerId: "discord-user-b",
            timelineOffsetMs: 1_000,
          },
        ],
      },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        transcriptId: "transcript:17:transcription-key",
        version: 1,
        turns: [
          {
            turnId: "turn:17:transcription-key:1",
            speakerId: "discord-user-a",
            startMs: 0,
            endMs: 2_500,
            text: "First speaker",
          },
          {
            turnId: "turn:17:transcription-key:2",
            speakerId: "discord-user-b",
            startMs: 1_200,
            endMs: 2_000,
            text: "Second speaker",
          },
        ],
      },
    });
    expect(reader.locators).toEqual(["recording://speaker-a", "recording://speaker-b"]);
    expect(client.requests).toHaveLength(2);
    expect(client.requests[0]).toMatchObject({
      idempotencyKey: "transcription-request:17:transcription-key:1",
      model: "whisper-1",
      language: "en",
      prompt: "Vocabulary: Craig, Meeting Platform",
      fileName: "speaker-a.flac",
      mediaType: "audio/flac",
    });
  });

  it("fails closed when provider text has no segment timestamps", async () => {
    const reader = new FakeAudioContentReader({
      "recording://speaker-a": {
        bytes: new Uint8Array([1]),
        fileName: "speaker-a.wav",
        mediaType: "audio/wav",
      },
    });
    const client = new FakeOpenAiTranscriptionClient({
      "speaker-a.wav": {
        duration: 1,
        language: "en",
        text: "Untimed evidence",
      },
    });
    const adapter = new OpenAiFinalTranscriptionAdapter(client, reader);

    const result = await adapter.transcribe({
      idempotencyKey: "transcription-key",
      meetingId: "meeting-1",
      recording: {
        recordingId: "recording-1",
        manifestLocator: "recording://manifest",
        speakerAudio: [
          {
            audioLocator: "recording://speaker-a",
            speakerId: "speaker-a",
            timelineOffsetMs: 0,
          },
        ],
      },
    });

    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: "OPENAI_TRANSCRIPTION_INVALID_PROVIDER_RESPONSE",
        retryable: false,
      },
    });
  });

  it("classifies an OpenAI availability failure as retryable", async () => {
    const reader = new FakeAudioContentReader({
      "recording://speaker-a": {
        bytes: new Uint8Array([1]),
        fileName: "speaker-a.ogg",
        mediaType: "audio/ogg",
      },
    });
    const client: OpenAiTranscriptionClient = {
      createTranscription: async () => {
        throw Object.assign(new Error("provider unavailable"), { status: 503 });
      },
    };
    const adapter = new OpenAiFinalTranscriptionAdapter(client, reader);

    const result = await adapter.transcribe({
      idempotencyKey: "transcription-key",
      meetingId: "meeting-1",
      recording: {
        recordingId: "recording-1",
        manifestLocator: "recording://manifest",
        speakerAudio: [
          {
            audioLocator: "recording://speaker-a",
            speakerId: "speaker-a",
            timelineOffsetMs: 0,
          },
        ],
      },
    });

    expect(result).toEqual({
      ok: false,
      failure: {
        code: "OPENAI_TRANSCRIPTION_REQUEST_FAILED",
        message: "OpenAI transcription request failed",
        retryable: true,
      },
    });
  });

  it("rejects audio above the OpenAI 25 MB upload limit before provider I/O", async () => {
    const reader = new FakeAudioContentReader({
      "recording://speaker-a": {
        bytes: new Uint8Array(25 * 1_024 * 1_024 + 1),
        fileName: "speaker-a.mp3",
        mediaType: "audio/mpeg",
      },
    });
    const client = new FakeOpenAiTranscriptionClient({});
    const adapter = new OpenAiFinalTranscriptionAdapter(client, reader);

    const result = await adapter.transcribe({
      idempotencyKey: "transcription-key",
      meetingId: "meeting-1",
      recording: {
        recordingId: "recording-1",
        manifestLocator: "recording://manifest",
        speakerAudio: [
          {
            audioLocator: "recording://speaker-a",
            speakerId: "speaker-a",
            timelineOffsetMs: 0,
          },
        ],
      },
    });

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "OPENAI_TRANSCRIPTION_INVALID_INPUT", retryable: false },
    });
    expect(client.requests).toEqual([]);
  });

  it("cancels queued and in-flight work through the shared AbortSignal", async () => {
    const controller = new AbortController();
    const cancellation = new Error("worker cancelled");
    const reader = new FakeAudioContentReader({
      "recording://speaker-a": {
        bytes: new Uint8Array([1]),
        fileName: "speaker-a.ogg",
        mediaType: "audio/ogg",
      },
      "recording://speaker-b": {
        bytes: new Uint8Array([2]),
        fileName: "speaker-b.ogg",
        mediaType: "audio/ogg",
      },
    });
    let notifyProviderStarted: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      notifyProviderStarted = resolve;
    });
    const requests: OpenAiTranscriptionRequest[] = [];
    const client: OpenAiTranscriptionClient = {
      createTranscription: async (request) => {
        requests.push(request);
        notifyProviderStarted();
        await new Promise<void>((resolve) => {
          request.signal?.addEventListener("abort", () => {
            resolve();
          }, { once: true });
        });
        request.signal?.throwIfAborted();
        return {};
      },
    };
    const adapter = new OpenAiFinalTranscriptionAdapter(client, reader, {
      maxConcurrency: 1,
    });
    const processing = adapter.transcribe({
      idempotencyKey: "transcription-key",
      meetingId: "meeting-1",
      recording: {
        recordingId: "recording-1",
        manifestLocator: "recording://manifest",
        speakerAudio: [
          {
            audioLocator: "recording://speaker-a",
            speakerId: "speaker-a",
            timelineOffsetMs: 0,
          },
          {
            audioLocator: "recording://speaker-b",
            speakerId: "speaker-b",
            timelineOffsetMs: 0,
          },
        ],
      },
      signal: controller.signal,
    });

    await providerStarted;
    controller.abort(cancellation);

    await expect(processing).rejects.toBe(cancellation);
    expect(reader.locators).toEqual(["recording://speaker-a"]);
    expect(reader.signals).toEqual([controller.signal]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.signal).toBe(controller.signal);
  });
});
