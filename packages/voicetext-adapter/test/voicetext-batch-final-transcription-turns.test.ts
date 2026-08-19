import { describe, expect, it } from "vitest";

import { validateVoicetextBatchFinalTranscriptionOptions } from "../src/voicetext-batch-final-transcription-configuration.js";
import {
  mapVoicetextBatchProviderReadableSegments,
  mapVoicetextBatchProviderTurns,
  stableVoicetextBatchIdempotencyKey,
} from "../src/voicetext-batch-final-transcription-turns.js";

const input = (
  utterances: readonly {
    readonly endSeconds: number;
    readonly startSeconds: number;
    readonly transcript: string;
  }[],
  maxSegmentOverlapMs = 2_000,
) => ({
  idempotencyKey: "job-key",
  options: validateVoicetextBatchFinalTranscriptionOptions({ maxSegmentOverlapMs }),
  reference: {
    audioLocator: "s3://recording/speaker-a.ogg",
    speakerId: "discord-user-a",
    timelineOffsetMs: 10_000,
  },
  result: {
    durationSeconds: 12,
    readableSegments: [],
    utterances,
  },
  speakerIndex: 0,
});

describe("Voicetext batch final turn normalization", () => {
  it("freezes the legacy batch-v2 idempotency salt and digest", () => {
    expect(stableVoicetextBatchIdempotencyKey(
      "job-key",
      "recording-1",
      "speaker-a",
    )).toBe("8a2e9d6f65b93de8b11512886a3c623cc9442532471ea84e4d23488813513369");
  });

  it("merges a bounded fully contained segment without losing its text", () => {
    const turns = mapVoicetextBatchProviderTurns(input([
      { endSeconds: 10, startSeconds: 5, transcript: "первая реплика" },
      { endSeconds: 9.5, startSeconds: 8.5, transcript: "вложенная реплика" },
    ]));

    expect(turns).toEqual([{
      endMs: 20_000,
      speakerId: "discord-user-a",
      sourceUtteranceIndices: [0, 1],
      stableTurnId: "turn:v2:7:job-key:1:1:1:1",
      startMs: 15_000,
      text: "первая реплика вложенная реплика",
    }]);
  });

  it("merges a fully contained refinement beyond the partial-overlap bound", () => {
    const turns = mapVoicetextBatchProviderTurns(input([
      { endSeconds: 12, startSeconds: 0, transcript: "coarse hypothesis" },
      { endSeconds: 2, startSeconds: 1, transcript: "detailed refinement" },
    ], 0));

    expect(turns).toEqual([{
      endMs: 22_000,
      speakerId: "discord-user-a",
      sourceUtteranceIndices: [0, 1],
      stableTurnId: "turn:v2:7:job-key:1:1:1:1",
      startMs: 10_000,
      text: "coarse hypothesis detailed refinement",
    }]);
  });

  it("ignores an empty degenerate hypothesis without advancing the timeline", () => {
    const turns = mapVoicetextBatchProviderTurns(input([
      { endSeconds: 8, startSeconds: 5, transcript: "первая реплика" },
      { endSeconds: 7, startSeconds: 7, transcript: "   " },
      { endSeconds: 10, startSeconds: 8, transcript: "вторая реплика" },
    ], 0));

    expect(turns).toMatchObject([
      { startMs: 15_000, endMs: 18_000, text: "первая реплика" },
      { startMs: 18_000, endMs: 20_000, text: "вторая реплика" },
    ]);
  });

  it("orders utterances by timestamp while retaining stable source IDs", () => {
    const turns = mapVoicetextBatchProviderTurns(input([
      { endSeconds: 10, startSeconds: 9, transcript: "вторая реплика" },
      { endSeconds: 8, startSeconds: 7, transcript: "первая реплика" },
    ]));

    expect(turns).toMatchObject([
      { startMs: 17_000, text: "первая реплика", stableTurnId: "turn:v2:7:job-key:1:1:1:2" },
      { startMs: 19_000, text: "вторая реплика", stableTurnId: "turn:v2:7:job-key:1:1:1:1" },
    ]);
  });

  it("retains contained utterance provenance for readable segments", () => {
    const mappingInput = input([
      { endSeconds: 10, startSeconds: 5, transcript: "first phrase" },
      { endSeconds: 9.5, startSeconds: 8.5, transcript: "contained phrase" },
    ]);
    const withReadableSegment = {
      ...mappingInput,
      result: {
        ...mappingInput.result,
        readableSegments: [{
          endSeconds: 9.5,
          sourceUtteranceIndices: [1],
          startSeconds: 8.5,
          transcript: "contained phrase",
        }],
      },
    };
    const turns = mapVoicetextBatchProviderTurns(withReadableSegment);

    expect(mapVoicetextBatchProviderReadableSegments(withReadableSegment, turns))
      .toMatchObject([{
        sourceTurnIds: [turns[0]?.stableTurnId],
        text: "contained phrase",
      }]);
  });

  it("does not discard substring-only contained text", () => {
    const turns = mapVoicetextBatchProviderTurns(input([
      { endSeconds: 10, startSeconds: 5, transcript: "theater" },
      { endSeconds: 9.5, startSeconds: 8.5, transcript: "he" },
    ]));

    expect(turns).toMatchObject([{ text: "theater he" }]);
  });
});
