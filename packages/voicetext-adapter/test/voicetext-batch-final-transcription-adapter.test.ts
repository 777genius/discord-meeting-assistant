import { describe, expect, it } from "vitest";

import { VoicetextAdapterError } from "../src/errors.js";
import type {
  CompleteOggArtifactReader,
  OggArtifactReadOptions,
} from "../src/ogg-artifact-reader.js";
import {
  VoicetextBatchFinalTranscriptionAdapter,
  type VoicetextBatchPollingScheduler,
} from "../src/voicetext-batch-final-transcription-adapter.js";
import type {
  VoicetextBatchClient,
  VoicetextBatchPollRequest,
  VoicetextBatchSubmitRequest,
  VoicetextBatchTaskResult,
} from "../src/voicetext-batch-client.js";

const jobId = "00000000-0000-4000-8000-000000000001";

class MemoryOggReader implements CompleteOggArtifactReader {
  public readonly reads: Array<{ locator: string; options: OggArtifactReadOptions }> = [];

  public constructor(private readonly artifacts: Readonly<Record<string, Uint8Array>>) {}

  public async read(audioLocator: string, options: OggArtifactReadOptions) {
    this.reads.push({ locator: audioLocator, options });
    const bytes = this.artifacts[audioLocator];
    if (bytes === undefined) {
      throw new Error("missing Ogg artifact fixture");
    }
    return { bytes, complete: true, container: "ogg" } as const;
  }
}

class TestPollingScheduler implements VoicetextBatchPollingScheduler {
  public readonly delaysMs: number[] = [];
  private timeMs = 0;

  public nowMs(): number {
    return this.timeMs;
  }

  public async sleep(delayMs: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.delaysMs.push(delayMs);
    this.timeMs += delayMs;
  }
}

class ScriptedBatchClient implements VoicetextBatchClient {
  public readonly polls: VoicetextBatchPollRequest[] = [];
  public readonly submissions: VoicetextBatchSubmitRequest[] = [];

  public constructor(
    private readonly submitHandler: (
      request: VoicetextBatchSubmitRequest,
    ) => Promise<VoicetextBatchTaskResult>,
    private readonly pollHandler: (
      request: VoicetextBatchPollRequest,
    ) => Promise<VoicetextBatchTaskResult> = async () => {
      throw new Error("unexpected batch poll");
    },
  ) {}

  public async submit(request: VoicetextBatchSubmitRequest): Promise<VoicetextBatchTaskResult> {
    this.submissions.push(request);
    return await this.submitHandler(request);
  }

  public async poll(request: VoicetextBatchPollRequest): Promise<VoicetextBatchTaskResult> {
    this.polls.push(request);
    return await this.pollHandler(request);
  }
}

describe("VoicetextBatchFinalTranscriptionAdapter", () => {
  it("re-submits the same Ogg body and stable key after the backend reports an expired lease", async () => {
    const scheduler = new TestPollingScheduler();
    let submitCount = 0;
    const client = new ScriptedBatchClient(
      async () => {
        submitCount += 1;
        return submitCount === 1
          ? pending("poll", 1_000)
          : completed({
              durationSeconds: 1,
              utterances: [{ endSeconds: 0.75, startSeconds: 0.25, transcript: "готовим релиз" }],
            });
      },
      async () => pending("retry", 1_500),
    );
    const reader = new MemoryOggReader({ "s3://recording/speaker-a.ogg": validOgg(1) });
    const adapter = new VoicetextBatchFinalTranscriptionAdapter(
      client,
      reader,
      { keyterms: ["Craig"] },
      scheduler,
    );

    const result = await adapter.transcribe(requestFixture());

    expect(result).toEqual({
      ok: true,
      value: {
        readableSegments: [],
        transcriptId: "transcript:v3:7:job-key",
        turns: [{
          endMs: 10_750,
          speakerId: "discord-user-a",
          startMs: 10_250,
          text: "готовим релиз",
          turnId: "turn:v3:7:job-key:1:1:1:1",
        }],
        version: 2,
      },
    });
    expect(client.submissions).toHaveLength(2);
    expect(client.polls).toHaveLength(1);
    const firstPoll = client.polls[0];
    if (firstPoll === undefined) {
      throw new Error("expected one batch poll");
    }
    expect(firstPoll.jobId).toBe(jobId);
    expect(firstPoll.signal).toBeInstanceOf(AbortSignal);
    expect(client.submissions[0]?.idempotencyKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(client.submissions[1]?.idempotencyKey).toBe(client.submissions[0]?.idempotencyKey);
    expect(client.submissions[1]?.audio).toEqual(client.submissions[0]?.audio);
    expect(reader.reads).toHaveLength(2);
    expect(scheduler.delaysMs).toEqual([1_000, 2_000]);
  });

  it("retries a transient batch request with the same idempotency key and bounded backoff", async () => {
    const scheduler = new TestPollingScheduler();
    let submitCount = 0;
    const client = new ScriptedBatchClient(async () => {
      submitCount += 1;
      if (submitCount === 1) {
        throw new VoicetextAdapterError("request_failed", "batch service unavailable", true);
      }
      return completed({
        durationSeconds: 1,
        utterances: [{ endSeconds: 1, startSeconds: 0, transcript: "retry recovered" }],
      });
    });
    const adapter = new VoicetextBatchFinalTranscriptionAdapter(
      client,
      new MemoryOggReader({ "s3://recording/speaker-a.ogg": validOgg(1) }),
      {},
      scheduler,
    );

    await expect(adapter.transcribe(requestFixture())).resolves.toMatchObject({ ok: true });
    expect(client.submissions).toHaveLength(2);
    expect(client.submissions[1]?.idempotencyKey).toBe(client.submissions[0]?.idempotencyKey);
    expect(client.submissions[1]?.audio).toEqual(client.submissions[0]?.audio);
    expect(scheduler.delaysMs).toEqual([1_000]);
  });

  it("fails closed when a re-read artifact changes before a provider re-submit", async () => {
    let readCount = 0;
    const reader: CompleteOggArtifactReader = {
      read: async () => {
        readCount += 1;
        return {
          bytes: validOgg(readCount),
          complete: true,
          container: "ogg",
        } as const;
      },
    };
    const client = new ScriptedBatchClient(async () => pending("retry", 0));
    const adapter = new VoicetextBatchFinalTranscriptionAdapter(
      client,
      reader,
      {},
      new TestPollingScheduler(),
    );

    await expect(adapter.transcribe(requestFixture())).resolves.toEqual({
      failure: {
        code: "VOICETEXT_TRANSCRIPTION_INVALID_INPUT",
        message: "authoritative speaker artifact changed while retrying",
        retryable: false,
      },
      ok: false,
    });
    expect(client.submissions).toHaveLength(1);
  });

  it("honors a retryable 429 Retry-After hint before re-uploading with the same key", async () => {
    const scheduler = new TestPollingScheduler();
    let submitCount = 0;
    const client = new ScriptedBatchClient(async () => {
      submitCount += 1;
      if (submitCount === 1) {
        throw new VoicetextAdapterError("rate_limited", "batch rate limited", true, {
          retryAfterMs: 15_000,
        });
      }
      return completed({
        durationSeconds: 1,
        utterances: [{ endSeconds: 1, startSeconds: 0, transcript: "rate limit recovered" }],
      });
    });
    const adapter = new VoicetextBatchFinalTranscriptionAdapter(
      client,
      new MemoryOggReader({ "s3://recording/speaker-a.ogg": validOgg(1) }),
      {},
      scheduler,
    );

    await expect(adapter.transcribe(requestFixture())).resolves.toMatchObject({ ok: true });
    expect(client.submissions).toHaveLength(2);
    expect(client.submissions[1]?.idempotencyKey).toBe(client.submissions[0]?.idempotencyKey);
    expect(scheduler.delaysMs).toEqual([15_000]);
  });

  it("submits two speaker tracks concurrently and preserves their absolute evidence timeline", async () => {
    const first = deferred<VoicetextBatchTaskResult>();
    const second = deferred<VoicetextBatchTaskResult>();
    const pendingByMarker = new Map<number, Deferred<VoicetextBatchTaskResult>>([
      [1, first],
      [2, second],
    ]);
    const client = new ScriptedBatchClient(async (request) => {
      const deferredResult = pendingByMarker.get(request.audio[5] ?? -1);
      if (deferredResult === undefined) {
        throw new Error("unexpected Ogg marker");
      }
      return await deferredResult.promise;
    });
    const adapter = new VoicetextBatchFinalTranscriptionAdapter(
      client,
      new MemoryOggReader({
        "s3://recording/speaker-a.ogg": validOgg(1),
        "s3://recording/speaker-b.ogg": validOgg(2),
      }),
      {},
      new TestPollingScheduler(),
    );

    const processing = adapter.transcribe(requestFixture([
      { audioLocator: "s3://recording/speaker-a.ogg", speakerId: "discord-user-a", timelineOffsetMs: 1_000 },
      { audioLocator: "s3://recording/speaker-b.ogg", speakerId: "discord-user-b", timelineOffsetMs: 1_500 },
    ]));
    await waitForSubmissions(client, 2);
    expect(client.submissions).toHaveLength(2);

    first.resolve(completed({
      durationSeconds: 1,
      utterances: [{ endSeconds: 1, startSeconds: 0, transcript: "первый трек" }],
    }));
    second.resolve(completed({
      durationSeconds: 1,
      utterances: [{ endSeconds: 0.5, startSeconds: 0, transcript: "второй трек" }],
    }));

    await expect(processing).resolves.toEqual({
      ok: true,
      value: {
        readableSegments: [],
        transcriptId: "transcript:v3:7:job-key",
        turns: [
          {
            endMs: 2_000,
            speakerId: "discord-user-a",
            startMs: 1_000,
            text: "первый трек",
            turnId: "turn:v3:7:job-key:1:1:1:1",
          },
          {
            endMs: 2_000,
            speakerId: "discord-user-b",
            startMs: 1_500,
            text: "второй трек",
            turnId: "turn:v3:7:job-key:1:2:1:1",
          },
        ],
        version: 2,
      },
    });
  });

  it("atomically drops a partial multi-speaker readable projection", async () => {
    const client = new ScriptedBatchClient(async (request) =>
      request.audio[5] === 1
        ? completed({
            durationSeconds: 1,
            readableSegments: [{
              endSeconds: 1,
              sourceUtteranceIndices: [0],
              startSeconds: 0,
              transcript: "первый трек",
            }],
            utterances: [{ endSeconds: 1, startSeconds: 0, transcript: "первый трек" }],
          })
        : completed({
            durationSeconds: 1,
            utterances: [{ endSeconds: 1, startSeconds: 0, transcript: "второй трек" }],
          })
    );
    const adapter = new VoicetextBatchFinalTranscriptionAdapter(
      client,
      new MemoryOggReader({
        "s3://recording/speaker-a.ogg": validOgg(1),
        "s3://recording/speaker-b.ogg": validOgg(2),
      }),
      {},
      new TestPollingScheduler(),
    );

    const result = await adapter.transcribe(requestFixture([
      {
        audioLocator: "s3://recording/speaker-a.ogg",
        speakerId: "discord-user-a",
        timelineOffsetMs: 0,
      },
      {
        audioLocator: "s3://recording/speaker-b.ogg",
        speakerId: "discord-user-b",
        timelineOffsetMs: 1_000,
      },
    ]));

    expect(result).toMatchObject({
      ok: true,
      value: {
        readableSegments: [],
        turns: [
          { speakerId: "discord-user-a", text: "первый трек" },
          { speakerId: "discord-user-b", text: "второй трек" },
        ],
      },
    });
  });

});

describe("VoicetextBatchFinalTranscriptionAdapter capacity and timing", () => {
  it("bounds reads and uploads to the configured worker pool instead of pre-reading a meeting", async () => {
    const speakers = Array.from({ length: 10 }, (_, index) => ({
      audioLocator: `s3://recording/speaker-${String(index + 1)}.ogg`,
      speakerId: `discord-user-${String(index + 1)}`,
      timelineOffsetMs: index * 1_000,
    }));
    const pendingByMarker = new Map(
      speakers.map((_, index) => [index + 1, deferred<VoicetextBatchTaskResult>()]),
    );
    const client = new ScriptedBatchClient(async (request) => {
      const deferredResult = pendingByMarker.get(request.audio[5] ?? -1);
      if (deferredResult === undefined) {
        throw new Error("unexpected Ogg marker");
      }
      return await deferredResult.promise;
    });
    const reader = new MemoryOggReader(Object.fromEntries(
      speakers.map((speaker, index) => [speaker.audioLocator, validOgg(index + 1)]),
    ));
    const adapter = new VoicetextBatchFinalTranscriptionAdapter(
      client,
      reader,
      { maxConcurrency: 6 },
      new TestPollingScheduler(),
    );

    const processing = adapter.transcribe(requestFixture(speakers));
    await waitForSubmissions(client, 6);
    expect(reader.reads).toHaveLength(6);
    for (const marker of [1, 2, 3, 4]) {
      const deferredResult = pendingByMarker.get(marker);
      if (deferredResult === undefined) {
        throw new Error("missing deferred batch result");
      }
      deferredResult.resolve(completed({
        durationSeconds: 1,
        utterances: [{ endSeconds: 1, startSeconds: 0, transcript: "готово" }],
      }));
      await waitForSubmissions(client, 6 + marker);
    }
    expect(reader.reads).toHaveLength(10);
    for (const marker of [5, 6, 7, 8, 9, 10]) {
      const deferredResult = pendingByMarker.get(marker);
      if (deferredResult === undefined) {
        throw new Error("missing deferred batch result");
      }
      deferredResult.resolve(completed({
        durationSeconds: 1,
        utterances: [{ endSeconds: 1, startSeconds: 0, transcript: "готово" }],
      }));
    }

    await expect(processing).resolves.toMatchObject({ ok: true });
  });

  it("rejects a twelfth speaker track before reading or submitting audio", async () => {
    const speakers = Array.from({ length: 12 }, (_, index) => ({
      audioLocator: `s3://recording/speaker-${String(index + 1)}.ogg`,
      speakerId: `discord-user-${String(index + 1)}`,
      timelineOffsetMs: index * 1_000,
    }));
    const reader = new MemoryOggReader({});
    const client = new ScriptedBatchClient(async () => completed({
      durationSeconds: 1,
      utterances: [],
    }));
    const adapter = new VoicetextBatchFinalTranscriptionAdapter(
      client,
      reader,
      {},
      new TestPollingScheduler(),
    );

    await expect(adapter.transcribe(requestFixture(speakers))).resolves.toMatchObject({
      failure: {
        code: "VOICETEXT_TRANSCRIPTION_INVALID_INPUT",
      },
      ok: false,
    });
    expect(reader.reads).toEqual([]);
    expect(client.submissions).toEqual([]);
  });

  it("normalizes an adjacent f32-style batch timestamp seam without creating an overlap", async () => {
    const client = new ScriptedBatchClient(async () => completed({
      durationSeconds: 6,
      utterances: [
        { endSeconds: 5.7599998, startSeconds: 5, transcript: "первая реплика" },
        { endSeconds: 6, startSeconds: 5.7599998, transcript: "вторая реплика" },
      ],
    }));
    const adapter = new VoicetextBatchFinalTranscriptionAdapter(
      client,
      new MemoryOggReader({ "s3://recording/speaker-a.ogg": validOgg(1) }),
      { maxSegmentOverlapMs: 0 },
      new TestPollingScheduler(),
    );

    await expect(adapter.transcribe(requestFixture())).resolves.toEqual({
      ok: true,
      value: {
        readableSegments: [],
        transcriptId: "transcript:v3:7:job-key",
        turns: [
          {
            endMs: 15_760,
            speakerId: "discord-user-a",
            startMs: 15_000,
            text: "первая реплика",
            turnId: "turn:v3:7:job-key:1:1:1:1",
          },
          {
            endMs: 16_000,
            speakerId: "discord-user-a",
            startMs: 15_760,
            text: "вторая реплика",
            turnId: "turn:v3:7:job-key:1:1:1:2",
          },
        ],
        version: 2,
      },
    });
  });

  it("clamps the exact 1.355-second Nova-3 provider overlap from production", async () => {
    const client = new ScriptedBatchClient(async () => completed({
      durationSeconds: 300,
      utterances: [
        { endSeconds: 292.6, startSeconds: 290, transcript: "проверяем очередь Redis" },
        { endSeconds: 294.925, startSeconds: 291.245, transcript: "проверяем idempotency key" },
      ],
    }));
    const adapter = new VoicetextBatchFinalTranscriptionAdapter(
      client,
      new MemoryOggReader({ "s3://recording/speaker-a.ogg": validOgg(1) }),
      { maxSegmentOverlapMs: 1_355 },
      new TestPollingScheduler(),
    );

    await expect(adapter.transcribe(requestFixture())).resolves.toEqual({
      ok: true,
      value: {
        readableSegments: [],
        transcriptId: "transcript:v3:7:job-key",
        turns: [
          {
            endMs: 302_600,
            speakerId: "discord-user-a",
            startMs: 300_000,
            text: "проверяем очередь Redis",
            turnId: "turn:v3:7:job-key:1:1:1:1",
          },
          {
            endMs: 304_925,
            speakerId: "discord-user-a",
            startMs: 302_600,
            text: "проверяем idempotency key",
            turnId: "turn:v3:7:job-key:1:1:1:2",
          },
        ],
        version: 2,
      },
    });
  });

  it("rejects a raw overlap above the configured bound", async () => {
    const client = new ScriptedBatchClient(async () => completed({
      durationSeconds: 12,
      utterances: [
        { endSeconds: 10, startSeconds: 5, transcript: "первая реплика" },
        { endSeconds: 11, startSeconds: 7.999, transcript: "перекрывающаяся реплика" },
      ],
    }));
    const adapter = new VoicetextBatchFinalTranscriptionAdapter(
      client,
      new MemoryOggReader({ "s3://recording/speaker-a.ogg": validOgg(1) }),
      {},
      new TestPollingScheduler(),
    );

    await expect(adapter.transcribe(requestFixture())).resolves.toEqual({
      failure: {
        code: "VOICETEXT_TRANSCRIPTION_INVALID_PROVIDER_RESPONSE",
        message: "Voicetext batch final segments are overlapping or zero-length",
        retryable: false,
      },
      ok: false,
    });
  });

  it("rejects a fully contained provider segment with no forward progress after clamping", async () => {
    const client = new ScriptedBatchClient(async () => completed({
      durationSeconds: 12,
      utterances: [
        { endSeconds: 10, startSeconds: 5, transcript: "первая реплика" },
        { endSeconds: 9.5, startSeconds: 8.5, transcript: "вложенная реплика" },
      ],
    }));
    const adapter = new VoicetextBatchFinalTranscriptionAdapter(
      client,
      new MemoryOggReader({ "s3://recording/speaker-a.ogg": validOgg(1) }),
      {},
      new TestPollingScheduler(),
    );

    await expect(adapter.transcribe(requestFixture())).resolves.toEqual({
      failure: {
        code: "VOICETEXT_TRANSCRIPTION_INVALID_PROVIDER_RESPONSE",
        message: "Voicetext batch final segments are overlapping or zero-length",
        retryable: false,
      },
      ok: false,
    });
  });

  it("bounds the segment-overlap normalizer configuration", () => {
    const client = new ScriptedBatchClient(async () => completed({
      durationSeconds: 1,
      utterances: [{ endSeconds: 1, startSeconds: 0, transcript: "unused" }],
    }));
    const reader = new MemoryOggReader({ "s3://recording/speaker-a.ogg": validOgg(1) });

    expect(() => new VoicetextBatchFinalTranscriptionAdapter(
      client,
      reader,
      { maxSegmentOverlapMs: -1 },
      new TestPollingScheduler(),
    )).toThrow("maxSegmentOverlapMs must be an integer between 0 and 10000");
    expect(() => new VoicetextBatchFinalTranscriptionAdapter(
      client,
      reader,
      { maxSegmentOverlapMs: 10_001 },
      new TestPollingScheduler(),
    )).toThrow("maxSegmentOverlapMs must be an integer between 0 and 10000");
  });

});

describe("VoicetextBatchFinalTranscriptionAdapter failure isolation", () => {
  it("bounds final batch provider concurrency and speaker tracks from one through ten", () => {
    const client = new ScriptedBatchClient(async () => completed({
      durationSeconds: 1,
      utterances: [{ endSeconds: 1, startSeconds: 0, transcript: "unused" }],
    }));
    const reader = new MemoryOggReader({ "s3://recording/speaker-a.ogg": validOgg(1) });

    expect(() => new VoicetextBatchFinalTranscriptionAdapter(
      client,
      reader,
      { maxConcurrency: 0 },
      new TestPollingScheduler(),
    )).toThrow("maxConcurrency must be an integer between 1 and 10");
    expect(() => new VoicetextBatchFinalTranscriptionAdapter(
      client,
      reader,
      { maxConcurrency: 11 },
      new TestPollingScheduler(),
    )).toThrow("maxConcurrency must be an integer between 1 and 10");
    expect(() => new VoicetextBatchFinalTranscriptionAdapter(
      client,
      reader,
      { maxSpeakerTracks: 12 },
      new TestPollingScheduler(),
    )).toThrow("maxSpeakerTracks must be an integer between 1 and 11");
  });

  it("fails the entire final transcription when one concurrent speaker track fails", async () => {
    const client = new ScriptedBatchClient(async (request) => {
      await Promise.resolve();
      if (request.audio[5] === 2) {
        throw new VoicetextAdapterError("provider_error", "speaker batch failed", true);
      }
      return completed({
        durationSeconds: 1,
        utterances: [{ endSeconds: 1, startSeconds: 0, transcript: "must not leak partially" }],
      });
    });
    const adapter = new VoicetextBatchFinalTranscriptionAdapter(
      client,
      new MemoryOggReader({
        "s3://recording/speaker-a.ogg": validOgg(1),
        "s3://recording/speaker-b.ogg": validOgg(2),
      }),
      {},
      new TestPollingScheduler(),
    );

    const result = await adapter.transcribe(requestFixture([
      { audioLocator: "s3://recording/speaker-a.ogg", speakerId: "discord-user-a", timelineOffsetMs: 0 },
      { audioLocator: "s3://recording/speaker-b.ogg", speakerId: "discord-user-b", timelineOffsetMs: 0 },
    ]));

    expect(client.submissions).toHaveLength(2);
    expect(result).toEqual({
      failure: {
        code: "VOICETEXT_TRANSCRIPTION_PROVIDER_ERROR",
        message: "speaker batch failed",
        retryable: true,
      },
      ok: false,
    });
  });

  it("cancels a sibling and leaves queued speakers unsubmitted after the first failure", async () => {
    const firstFailure = deferred<VoicetextBatchTaskResult>();
    let siblingAborted = false;
    const client = new ScriptedBatchClient(async (request) => {
      const marker = request.audio[5];
      if (marker === 1) {
        return await firstFailure.promise;
      }
      if (marker === 2) {
        return await new Promise<VoicetextBatchTaskResult>((_resolve, reject) => {
          const onAbort = () => {
            siblingAborted = true;
            reject(request.signal.reason);
          };
          request.signal.addEventListener("abort", onAbort, { once: true });
          if (request.signal.aborted) {
            onAbort();
          }
        });
      }
      throw new Error("queued third speaker must not be submitted");
    });
    const adapter = new VoicetextBatchFinalTranscriptionAdapter(
      client,
      new MemoryOggReader({
        "s3://recording/speaker-a.ogg": validOgg(1),
        "s3://recording/speaker-b.ogg": validOgg(2),
        "s3://recording/speaker-c.ogg": validOgg(3),
      }),
      {},
      new TestPollingScheduler(),
    );

    const processing = adapter.transcribe(requestFixture([
      { audioLocator: "s3://recording/speaker-a.ogg", speakerId: "discord-user-a", timelineOffsetMs: 0 },
      { audioLocator: "s3://recording/speaker-b.ogg", speakerId: "discord-user-b", timelineOffsetMs: 0 },
      { audioLocator: "s3://recording/speaker-c.ogg", speakerId: "discord-user-c", timelineOffsetMs: 0 },
    ]));
    await waitForSubmissions(client, 2);
    firstFailure.reject(new VoicetextAdapterError(
      "provider_error",
      "first speaker batch failed",
      false,
    ));

    await expect(processing).resolves.toEqual({
      failure: {
        code: "VOICETEXT_TRANSCRIPTION_PROVIDER_ERROR",
        message: "first speaker batch failed",
        retryable: false,
      },
      ok: false,
    });
    expect(siblingAborted).toBe(true);
    expect(client.submissions).toHaveLength(2);
    expect(client.submissions.map((submission) => submission.audio[5])).toEqual([1, 2]);
  });

  it("does not race the default scheduler delay against its batch deadline", async () => {
    let submitCount = 0;
    const client = new ScriptedBatchClient(async () => {
      submitCount += 1;
      return submitCount === 1
        ? pending("retry", 0)
        : completed({
            durationSeconds: 1,
            utterances: [{ endSeconds: 1, startSeconds: 0, transcript: "retry succeeded" }],
          });
    });
    const adapter = new VoicetextBatchFinalTranscriptionAdapter(
      client,
      new MemoryOggReader({ "s3://recording/speaker-a.ogg": validOgg(1) }),
      {
        maxPollBackoffMs: 100,
        pollInitialBackoffMs: 100,
        pollTimeoutMs: 500,
      },
    );

    await expect(adapter.transcribe(requestFixture())).resolves.toMatchObject({ ok: true });
    expect(client.submissions).toHaveLength(2);
  });

  it("fails closed before submitting an artifact that exceeds its configured memory cap", async () => {
    const client = new ScriptedBatchClient(async () => completed({
      durationSeconds: 1,
      utterances: [{ endSeconds: 1, startSeconds: 0, transcript: "must not submit" }],
    }));
    const reader = new MemoryOggReader({ "s3://recording/speaker-a.ogg": validOgg(1, 28) });
    const adapter = new VoicetextBatchFinalTranscriptionAdapter(
      client,
      reader,
      { maxArtifactBytesPerSpeaker: 27, maxTotalArtifactBytes: 27 },
      new TestPollingScheduler(),
    );

    await expect(adapter.transcribe(requestFixture())).resolves.toEqual({
      failure: {
        code: "VOICETEXT_TRANSCRIPTION_INVALID_INPUT",
        message: "authoritative speaker artifact is not a bounded Ogg stream",
        retryable: false,
      },
      ok: false,
    });
    expect(reader.reads[0]?.options.maxBytes).toBe(27);
    expect(client.submissions).toEqual([]);
  });

  it("rejects an aggregate artifact capacity reservation before bounded workers start", async () => {
    const speakers = Array.from({ length: 5 }, (_, index) => ({
      audioLocator: `s3://recording/speaker-${String(index + 1)}.ogg`,
      speakerId: `discord-user-${String(index + 1)}`,
      timelineOffsetMs: index * 1_000,
    }));
    const reader = new MemoryOggReader(Object.fromEntries(
      speakers.map((speaker, index) => [speaker.audioLocator, validOgg(index + 1)]),
    ));
    const client = new ScriptedBatchClient(async () => completed({
      durationSeconds: 1,
      utterances: [{ endSeconds: 1, startSeconds: 0, transcript: "must not submit" }],
    }));
    const adapter = new VoicetextBatchFinalTranscriptionAdapter(
      client,
      reader,
      {
        maxArtifactBytesPerSpeaker: 27,
        maxConcurrency: 10,
        maxTotalArtifactBytes: 4 * 27,
      },
      new TestPollingScheduler(),
    );

    await expect(adapter.transcribe(requestFixture(speakers))).resolves.toMatchObject({
      failure: {
        code: "VOICETEXT_TRANSCRIPTION_LIMIT_EXCEEDED",
        retryable: false,
      },
      ok: false,
    });
    expect(reader.reads).toEqual([]);
    expect(client.submissions).toEqual([]);
  });
});

function requestFixture(speakerAudio = [
  { audioLocator: "s3://recording/speaker-a.ogg", speakerId: "discord-user-a", timelineOffsetMs: 10_000 },
]) {
  return {
    idempotencyKey: "job-key",
    meetingId: "meeting-1",
    recording: {
      manifestLocator: "s3://recording/manifest.json",
      recordingId: "recording-1",
      speakerAudio,
    },
  };
}

function pending(nextAction: "poll" | "retry", retryAfterMs: number): VoicetextBatchTaskResult {
  return { jobId, kind: "pending", nextAction, retryAfterMs };
}

function completed(result: {
  readonly durationSeconds: number;
  readonly readableSegments?: readonly {
    readonly endSeconds: number;
    readonly sourceUtteranceIndices: readonly number[];
    readonly startSeconds: number;
    readonly transcript: string;
  }[];
  readonly utterances: readonly {
    readonly endSeconds: number;
    readonly startSeconds: number;
    readonly transcript: string;
  }[];
}): VoicetextBatchTaskResult {
  return {
    jobId,
    kind: "completed",
    result: {
      durationSeconds: result.durationSeconds,
      readableSegments: result.readableSegments ?? [],
      utterances: result.utterances,
    },
  };
}

function validOgg(marker: number, byteLength = 27): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  bytes.set([79, 103, 103, 83]);
  bytes[5] = marker;
  return bytes;
}

function deferred<Value>(): Deferred<Value> {
  let resolveDeferred!: (value: Value) => void;
  let rejectDeferred!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  return { promise, reject: rejectDeferred, resolve: resolveDeferred };
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: Value) => void;
}

async function waitForSubmissions(client: ScriptedBatchClient, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (client.submissions.length === expected) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`expected ${expected} concurrent batch submissions`);
}
