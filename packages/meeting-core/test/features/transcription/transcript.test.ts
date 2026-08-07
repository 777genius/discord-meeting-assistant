import { describe, expect, it } from "vitest";

import {
  FinalTranscript,
  TranscriptionInvariantError,
  type TranscriptReadableSegmentSnapshot,
} from "@discord-meeting/meeting-core/transcription";

const transcriptSnapshot = {
  readableSegments: [
    {
      endMs: 900,
      segmentId: "segment-1",
      sourceTurnIds: ["turn-1"],
      speakerId: "speaker-a",
      startMs: 0,
      text: "Ship the first version",
    },
    {
      endMs: 1_500,
      segmentId: "segment-2",
      sourceTurnIds: ["turn-1"],
      speakerId: "speaker-a",
      startMs: 900,
      text: "on Friday.",
    },
    {
      endMs: 2_100,
      segmentId: "segment-3",
      sourceTurnIds: ["turn-2"],
      speakerId: "speaker-b",
      startMs: 900,
      text: "I will own the release checklist.",
    },
  ],
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

const [firstReadableSegment, secondReadableSegment, thirdReadableSegment] =
  transcriptSnapshot.readableSegments;

function withInvalidFirstReadableSegment(
  segment: TranscriptReadableSegmentSnapshot,
): readonly TranscriptReadableSegmentSnapshot[] {
  return [segment, secondReadableSegment, thirdReadableSegment];
}

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

  it("allows one raw evidence turn to back multiple readable segments", () => {
    const transcript = FinalTranscript.create(transcriptSnapshot);

    expect(transcript.readableSegments.slice(0, 2).map(({ sourceTurnIds }) => sourceTurnIds)).toEqual([
      ["turn-1"],
      ["turn-1"],
    ]);
    expect(transcript.turns).toHaveLength(2);
  });

  it("normalizes legacy snapshots without readable segments to an empty list", () => {
    const { readableSegments: _legacyOmission, ...legacySnapshot } = transcriptSnapshot;

    expect(FinalTranscript.create(legacySnapshot).toSnapshot()).toEqual({
      ...legacySnapshot,
      readableSegments: [],
    });
  });

  it("discards structurally malformed derived metadata without losing raw turns", () => {
    const transcript = FinalTranscript.create({
      ...transcriptSnapshot,
      readableSegments: [{}] as unknown as readonly TranscriptReadableSegmentSnapshot[],
    });

    expect(transcript.readableSegments).toEqual([]);
    expect(transcript.turns).toHaveLength(2);
  });

  it("owns validation failures for recording-owned speaker identifiers", () => {
    expect(() =>
      FinalTranscript.create({
        ...transcriptSnapshot,
        turns: [{ ...transcriptSnapshot.turns[0], speakerId: "   " }],
      }),
    ).toThrow(TranscriptionInvariantError);
  });

  it.each<readonly [string, readonly TranscriptReadableSegmentSnapshot[]]>([
    [
      "duplicate segment IDs",
      [
        firstReadableSegment,
        { ...secondReadableSegment, segmentId: firstReadableSegment.segmentId },
        thirdReadableSegment,
      ],
    ],
    [
      "blank segment IDs",
      withInvalidFirstReadableSegment({ ...firstReadableSegment, segmentId: "   " }),
    ],
    [
      "blank segment speakers",
      withInvalidFirstReadableSegment({ ...firstReadableSegment, speakerId: "   " }),
    ],
    [
      "blank segment text",
      withInvalidFirstReadableSegment({ ...firstReadableSegment, text: "   " }),
    ],
    [
      "empty source turn references",
      withInvalidFirstReadableSegment({ ...firstReadableSegment, sourceTurnIds: [] }),
    ],
    [
      "blank source turn IDs",
      withInvalidFirstReadableSegment({ ...firstReadableSegment, sourceTurnIds: ["   "] }),
    ],
    [
      "duplicate source turn IDs",
      withInvalidFirstReadableSegment({
        ...firstReadableSegment,
        sourceTurnIds: ["turn-1", "turn-1"],
      }),
    ],
    [
      "duplicate normalized source turn IDs",
      withInvalidFirstReadableSegment({
        ...firstReadableSegment,
        sourceTurnIds: ["turn-1", "\t turn-1 "],
      }),
    ],
    [
      "non-positive intervals",
      withInvalidFirstReadableSegment({ ...firstReadableSegment, endMs: 0 }),
    ],
    [
      "unknown source turns",
      withInvalidFirstReadableSegment({
        ...firstReadableSegment,
        sourceTurnIds: ["turn-missing"],
      }),
    ],
    [
      "source turns from another speaker",
      withInvalidFirstReadableSegment({ ...firstReadableSegment, sourceTurnIds: ["turn-2"] }),
    ],
    [
      "intervals outside the source turn envelope",
      withInvalidFirstReadableSegment({ ...firstReadableSegment, endMs: 1_501 }),
    ],
    [
      "partial turn coverage",
      [firstReadableSegment, secondReadableSegment],
    ],
  ])("atomically discards %s", (_case, readableSegments) => {
    expect(
      FinalTranscript.create({ ...transcriptSnapshot, readableSegments }).readableSegments,
    ).toEqual([]);
  });
});
