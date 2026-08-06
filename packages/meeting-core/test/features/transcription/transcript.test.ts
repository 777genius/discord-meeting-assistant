import { describe, expect, it } from "vitest";

import {
  FinalTranscript,
  TranscriptionInvariantError,
} from "@discord-meeting/meeting-core/transcription";

const transcriptSnapshot = {
  recordingId: "recording-1",
  transcriptId: "transcript-1",
  turns: [
    {
      endMs: 1_500,
      speakerId: "speaker-a",
      startMs: 0,
      text: "Ship the first version on Friday.",
      turnId: "turn-1",
    },
    {
      endMs: 2_100,
      speakerId: "speaker-b",
      startMs: 900,
      text: "I will own the release checklist.",
      turnId: "turn-2",
    },
  ],
  version: 1,
} as const;

describe("Final transcript", () => {
  it("preserves speaker-attributed overlapping turns without merging them", () => {
    const transcript = FinalTranscript.create(transcriptSnapshot);

    expect(transcript.turns).toHaveLength(2);
    expect(transcript.turns.map(({ speakerId }) => speakerId)).toEqual([
      "speaker-a",
      "speaker-b",
    ]);
    expect(transcript.overlappingPairs()).toHaveLength(1);
    expect(transcript.toSnapshot()).toEqual(transcriptSnapshot);
  });

  it("owns validation failures for recording-owned speaker identifiers", () => {
    expect(() =>
      FinalTranscript.create({
        ...transcriptSnapshot,
        turns: [{ ...transcriptSnapshot.turns[0], speakerId: "   " }],
      }),
    ).toThrow(TranscriptionInvariantError);
  });
});
