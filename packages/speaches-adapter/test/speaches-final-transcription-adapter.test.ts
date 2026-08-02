import { describe, expect, it } from "vitest";

import type {
  BinaryAudioArtifact,
  BinaryAudioArtifactReader,
  BinaryAudioReadOptions,
} from "../src/binary-audio-artifact-reader.js";
import { SpeachesClientError } from "../src/errors.js";
import { SpeachesFinalTranscriptionAdapter } from "../src/speaches-final-transcription-adapter.js";
import type {
  SpeachesTranscriptionClient,
  SpeachesTranscriptionRequest,
} from "../src/speaches-transcription-client.js";

class MemoryArtifactReader implements BinaryAudioArtifactReader {
  public readonly reads: Array<{ locator: string; options: BinaryAudioReadOptions }> = [];

  public constructor(
    private readonly artifacts: Readonly<Record<string, BinaryAudioArtifact>>,
  ) {}

  public async read(
    audioLocator: string,
    options: BinaryAudioReadOptions,
  ): Promise<BinaryAudioArtifact> {
    this.reads.push({ locator: audioLocator, options });
    const resolvedArtifact = this.artifacts[audioLocator];
    if (resolvedArtifact === undefined) {
      throw new Error("artifact fixture not found");
    }
    return resolvedArtifact;
  }
}

class FakeSpeachesClient implements SpeachesTranscriptionClient {
  public readonly requests: SpeachesTranscriptionRequest[] = [];

  public constructor(
    private readonly responses: Readonly<Record<string, unknown>>,
  ) {}

  public async createTranscription(
    request: SpeachesTranscriptionRequest,
  ): Promise<unknown> {
    this.requests.push(request);
    return this.responses[request.fileName];
  }
}

describe("SpeachesFinalTranscriptionAdapter", () => {
  it("preserves speaker IDs, global chunk offsets, overlap, and stable IDs", async () => {
    const reader = new MemoryArtifactReader({
      "recording://speaker-a": artifact("speaker-a.flac", 0, [1, 2]),
      "recording://speaker-b": artifact("speaker-b.flac", 200, [3, 4]),
    });
    const client = new FakeSpeachesClient({
      "speaker-a.flac": verboseTranscript("ru", "Первый спикер", [
        { id: "a", start: 0, end: 2, text: " Первый спикер " },
      ]),
      "speaker-b.flac": verboseTranscript("ru", "Second speaker", [
        { id: 7, start: 0, end: 1, text: "Second speaker" },
      ]),
    });
    const adapter = new SpeachesFinalTranscriptionAdapter(client, reader, {
      language: "ru",
      model: "Systran/faster-whisper-small",
      vocabulary: ["Craig", "Meeting Platform", "Craig"],
    });

    const request = transcriptionRequest();
    const first = await adapter.transcribe(request);
    const second = await adapter.transcribe(request);

    expect(first).toEqual(second);
    expect(first).toEqual({
      ok: true,
      value: {
        transcriptId: "transcript:v1:7:job-key",
        version: 1,
        turns: [
          {
            endMs: 3_000,
            speakerId: "discord-user-a",
            startMs: 1_000,
            text: "Первый спикер",
            turnId: "turn:v1:7:job-key:1:1:1:1:1:a",
          },
          {
            endMs: 2_700,
            speakerId: "discord-user-b",
            startMs: 1_700,
            text: "Second speaker",
            turnId: "turn:v1:7:job-key:1:2:1:1:1:7",
          },
        ],
      },
    });
    expect(client.requests[0]).toMatchObject({
      hotwords: "Craig, Meeting Platform",
      idempotencyKey: "transcription-request:v1:7:job-key:1:1:1:1",
      language: "ru",
      model: "Systran/faster-whisper-small",
    });
    expect(reader.reads[0]?.options).toMatchObject({
      maxChunkBytes: 64 * 1_024 * 1_024,
      maxChunks: 128,
    });
  });

  it("does not double-add Craig offsets when cooked tracks retain one media timeline", async () => {
    const reader = new MemoryArtifactReader({
      "recording://speaker-a": artifact(
        "speaker-a.ogg",
        0,
        [1, 2],
        "recording-media-origin",
      ),
      "recording://speaker-b": artifact(
        "speaker-b.ogg",
        0,
        [3, 4],
        "recording-media-origin",
      ),
    });
    const client = new FakeSpeachesClient({
      "speaker-a.ogg": verboseTranscript("ru", "Speaker A", [
        { id: 1, start: 0, end: 12.6, text: "Speaker A" },
      ]),
      "speaker-b.ogg": verboseTranscript("ru", "Speaker B", [
        { id: 1, start: 14.032, end: 24.779, text: "Speaker B" },
      ]),
    });
    const adapter = new SpeachesFinalTranscriptionAdapter(client, reader, {
      model: "Systran/faster-whisper-small",
    });

    const result = await adapter.transcribe({
      ...transcriptionRequest(),
      recording: {
        ...transcriptionRequest().recording,
        speakerAudio: [speakerReference("a", 6_098), speakerReference("b", 20_601)],
      },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        turns: [
          { endMs: 18_698, speakerId: "discord-user-a", startMs: 6_098 },
          { endMs: 30_877, speakerId: "discord-user-b", startMs: 20_130 },
        ],
      },
    });
  });

  it("bounds provider concurrency across all speaker chunks", async () => {
    const reader = new MemoryArtifactReader({
      "recording://speaker-a": artifact("speaker-a.wav", 0, [1]),
      "recording://speaker-b": artifact("speaker-b.wav", 0, [2]),
      "recording://speaker-c": artifact("speaker-c.wav", 0, [3]),
    });
    const releases: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    const client: SpeachesTranscriptionClient = {
      createTranscription: async (request) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        active -= 1;
        return verboseTranscript("ru", request.fileName, [
          { id: 1, start: 0, end: 1, text: request.fileName },
        ]);
      },
    };
    const adapter = new SpeachesFinalTranscriptionAdapter(client, reader, {
      maxConcurrency: 2,
      model: "Systran/faster-whisper-small",
    });
    const pending = adapter.transcribe({
      ...transcriptionRequest(),
      recording: {
        ...transcriptionRequest().recording,
        speakerAudio: [
          speakerReference("a", 0),
          speakerReference("b", 0),
          speakerReference("c", 0),
        ],
      },
    });

    await waitFor(() => releases.length === 2);
    expect(maximumActive).toBe(2);
    releases.splice(0).forEach((release) => {
      release();
    });
    await waitFor(() => releases.length === 1);
    releases.splice(0).forEach((release) => {
      release();
    });

    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(maximumActive).toBe(2);
  });

  it("cancels in-flight provider work through AbortSignal", async () => {
    const reader = new MemoryArtifactReader({
      "recording://speaker-a": artifact("speaker-a.wav", 0, [1]),
      "recording://speaker-b": artifact("speaker-b.wav", 0, [2]),
    });
    let started = false;
    const client: SpeachesTranscriptionClient = {
      createTranscription: async ({ signal }) => {
        started = true;
        return await new Promise<unknown>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(signal.reason);
          }, { once: true });
        });
      },
    };
    const adapter = new SpeachesFinalTranscriptionAdapter(client, reader, {
      model: "Systran/faster-whisper-small",
    });
    const controller = new AbortController();
    const pending = adapter.transcribe({ ...transcriptionRequest(), signal: controller.signal });
    await waitFor(() => started);
    controller.abort(new Error("test cancellation"));

    await expect(pending).resolves.toEqual({
      ok: false,
      failure: {
        code: "SPEACHES_TRANSCRIPTION_CANCELLED",
        message: "Speaches transcription was cancelled",
        retryable: true,
      },
    });
  });

  it("classifies the configured provider deadline as retryable", async () => {
    const reader = new MemoryArtifactReader({
      "recording://speaker-a": artifact("speaker-a.wav", 0, [1]),
      "recording://speaker-b": artifact("speaker-b.wav", 0, [2]),
    });
    const client: SpeachesTranscriptionClient = {
      createTranscription: async ({ signal }) =>
        await new Promise<unknown>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(signal.reason);
          }, { once: true });
        }),
    };
    const adapter = new SpeachesFinalTranscriptionAdapter(client, reader, {
      maxConcurrency: 1,
      model: "Systran/faster-whisper-small",
      providerRequestTimeoutMs: 100,
    });

    await expect(adapter.transcribe(transcriptionRequest())).resolves.toEqual({
      ok: false,
      failure: {
        code: "SPEACHES_TRANSCRIPTION_TIMEOUT",
        message: "Speaches transcription request timed out",
        retryable: true,
      },
    });
  });

  it("fails closed on oversized non-media-safe chunks before provider I/O", async () => {
    const reader = new MemoryArtifactReader({
      "recording://speaker-a": artifact("speaker-a.wav", 0, [1, 2, 3]),
      "recording://speaker-b": artifact("speaker-b.wav", 0, [4]),
    });
    const client = new FakeSpeachesClient({});
    const adapter = new SpeachesFinalTranscriptionAdapter(client, reader, {
      maxBytesPerChunk: 2,
      maxBytesPerSpeaker: 4,
      maxTotalAudioBytes: 8,
      model: "Systran/faster-whisper-small",
    });

    const result = await adapter.transcribe(transcriptionRequest());

    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: "SPEACHES_TRANSCRIPTION_INVALID_INPUT",
        retryable: false,
      },
    });
    expect(client.requests).toEqual([]);
  });

  it.each([
    [503, true],
    [429, true],
    [400, false],
  ])("classifies HTTP %i retryability", async (status, retryable) => {
    const reader = new MemoryArtifactReader({
      "recording://speaker-a": artifact("speaker-a.wav", 0, [1]),
      "recording://speaker-b": artifact("speaker-b.wav", 0, [2]),
    });
    const client: SpeachesTranscriptionClient = {
      createTranscription: async () => {
        throw new SpeachesClientError("http", "provider failure", status);
      },
    };
    const adapter = new SpeachesFinalTranscriptionAdapter(client, reader, {
      model: "Systran/faster-whisper-small",
    });

    await expect(adapter.transcribe(transcriptionRequest())).resolves.toEqual({
      ok: false,
      failure: {
        code: "SPEACHES_TRANSCRIPTION_REQUEST_FAILED",
        message: "Speaches transcription request failed",
        retryable,
      },
    });
  });

  it("rejects provider text without segment timestamps", async () => {
    const reader = new MemoryArtifactReader({
      "recording://speaker-a": artifact("speaker-a.wav", 0, [1]),
      "recording://speaker-b": artifact("speaker-b.wav", 0, [2]),
    });
    const client = new FakeSpeachesClient({
      "speaker-a.wav": { text: "Untimed evidence" },
      "speaker-b.wav": { text: "" },
    });
    const adapter = new SpeachesFinalTranscriptionAdapter(client, reader, {
      model: "Systran/faster-whisper-small",
    });

    await expect(adapter.transcribe(transcriptionRequest())).resolves.toMatchObject({
      ok: false,
      failure: {
        code: "SPEACHES_TRANSCRIPTION_INVALID_PROVIDER_RESPONSE",
        retryable: false,
      },
    });
  });
});

function artifact(
  fileName: string,
  timelineOffsetMs: number,
  bytes: readonly number[],
  providerTimestampOrigin: BinaryAudioArtifact["providerTimestampOrigin"] = "speaker-track-origin",
): BinaryAudioArtifact {
  return {
    chunks: [{
      bytes: Uint8Array.from(bytes),
      fileName,
      mediaType: fileName.endsWith(".flac") ? "audio/flac" : "audio/wav",
      timelineOffsetMs,
    }],
    providerTimestampOrigin,
  };
}

function transcriptionRequest() {
  return {
    idempotencyKey: "job-key",
    meetingId: "meeting-1",
    recording: {
      manifestLocator: "recording://manifest",
      recordingId: "recording-1",
      speakerAudio: [speakerReference("a", 1_000), speakerReference("b", 1_500)],
    },
  } as const;
}

function speakerReference(speaker: string, timelineOffsetMs: number) {
  return {
    audioLocator: `recording://speaker-${speaker}`,
    speakerId: `discord-user-${speaker}`,
    timelineOffsetMs,
  } as const;
}

function verboseTranscript(
  language: string,
  text: string,
  segments: readonly Readonly<Record<string, unknown>>[],
) {
  return { language, segments, text };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (condition()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("condition was not reached");
}
