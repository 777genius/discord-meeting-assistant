import { describe, expect, it } from "vitest";

import { validateVoicetextBatchFinalTranscriptionOptions } from "../src/voicetext-batch-final-transcription-configuration.js";
import { mapVoicetextBatchProviderTurns } from "../src/voicetext-batch-final-transcription-turns.js";

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
  it("merges a bounded fully contained segment without losing its text", () => {
    const turns = mapVoicetextBatchProviderTurns(input([
      { endSeconds: 10, startSeconds: 5, transcript: "первая реплика" },
      { endSeconds: 9.5, startSeconds: 8.5, transcript: "вложенная реплика" },
    ]));

    expect(turns).toEqual([{
      endMs: 20_000,
      speakerId: "discord-user-a",
      sourceUtteranceIndex: 0,
      stableTurnId: "turn:v2:7:job-key:1:1:1:1",
      startMs: 15_000,
      text: "первая реплика вложенная реплика",
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
});
