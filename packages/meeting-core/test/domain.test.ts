import { describe, expect, it } from "vitest";

import {
  DomainInvariantError,
  EvidenceBackedSummary,
  FinalTranscript,
  Meeting,
} from "../src/index.js";

const recording = {
  manifestLocator: "recordings/recording-1/manifest.json",
  recordingId: "recording-1",
  speakerAudio: [
    {
      audioLocator: "recordings/recording-1/speaker-a.flac",
      speakerId: "speaker-a",
      timelineOffsetMs: 0,
    },
    {
      audioLocator: "recordings/recording-1/speaker-b.flac",
      speakerId: "speaker-b",
      timelineOffsetMs: 900,
    },
  ],
} as const;

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

const summarySnapshot = {
  actionItems: [
    {
      actionItemId: "action-1",
      evidenceTurnIds: ["turn-2"],
      ownerSpeakerId: "speaker-b",
      text: "Prepare the release checklist.",
    },
  ],
  decisions: [
    {
      decisionId: "decision-1",
      evidenceTurnIds: ["turn-1"],
      text: "Ship the first version on Friday.",
    },
  ],
  openQuestions: [],
  overview: "The team agreed on a Friday release.",
  summaryId: "summary-1",
  title: "Release planning",
  transcriptId: "transcript-1",
  version: 1,
} as const;

function recordedMeeting(): Meeting {
  return Meeting.record({
    meetingId: "meeting-1",
    publicationTargetId: "results-channel",
    recording,
  });
}

describe("Meeting lifecycle", () => {
  it("allows only ordered transitions and treats identical completion as idempotent", () => {
    const meeting = recordedMeeting();
    const transcript = FinalTranscript.create(transcriptSnapshot);

    expect(() => meeting.beginSummary()).toThrow(DomainInvariantError);
    expect(() => meeting.completeTranscription(transcript)).toThrow(
      /must be running/u,
    );

    expect(meeting.beginTranscription()).toBe("started");
    expect(meeting.completeTranscription(transcript)).toBe(true);
    const completedRevision = meeting.revision;
    expect(meeting.completeTranscription(FinalTranscript.create(transcriptSnapshot))).toBe(
      false,
    );
    expect(meeting.revision).toBe(completedRevision);

    const summary = EvidenceBackedSummary.create(summarySnapshot, transcript);
    expect(meeting.beginSummary()).toBe("started");
    expect(meeting.completeSummary(summary)).toBe(true);
    expect(meeting.beginPublication()).toBe("started");

    const key = meeting.publicationIdempotencyKey();
    expect(
      meeting.completePublication({
        externalPublicationId: "thread-1",
        idempotencyKey: key,
      }),
    ).toBe(true);
    expect(
      meeting.completePublication({
        externalPublicationId: "thread-1",
        idempotencyKey: key,
      }),
    ).toBe(false);
  });

  it("retries only retryable failures and increments the attempt", () => {
    const retryable = recordedMeeting();
    retryable.beginTranscription();
    retryable.failTranscription({
      code: "STT_UNAVAILABLE",
      message: "temporary outage",
      retryable: true,
    });

    expect(retryable.beginTranscription()).toBe("started");
    expect(retryable.stage("transcription")).toMatchObject({
      attempts: 2,
      status: "running",
    });

    const terminal = recordedMeeting();
    terminal.beginTranscription();
    terminal.failTranscription({
      code: "UNSUPPORTED_AUDIO",
      message: "invalid codec",
      retryable: false,
    });
    expect(() => terminal.beginTranscription()).toThrow(/cannot be retried/u);
  });

  it("never allows a downstream transition to replace the recording", () => {
    const meeting = recordedMeeting();
    const original = meeting.recording.toSnapshot();
    meeting.beginTranscription();
    meeting.failTranscription({
      code: "STT_UNAVAILABLE",
      message: "temporary outage",
      retryable: true,
    });

    expect(meeting.recording.toSnapshot()).toEqual(original);
    expect(meeting.toSnapshot().recording).toEqual(original);
  });

  it("fails closed when persisted stages violate lifecycle ordering", () => {
    const snapshot = recordedMeeting().toSnapshot();

    expect(() =>
      Meeting.restore({
        ...snapshot,
        summaryStage: { attempts: 1, status: "running" },
      }),
    ).toThrow(/requires successful transcription/u);
  });
});

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
});

describe("Evidence-backed summary", () => {
  it("rejects decision evidence that does not reference an existing turn", () => {
    const transcript = FinalTranscript.create(transcriptSnapshot);

    expect(() =>
      EvidenceBackedSummary.create(
        {
          ...summarySnapshot,
          decisions: [
            {
              ...summarySnapshot.decisions[0],
              evidenceTurnIds: ["missing-turn"],
            },
          ],
        },
        transcript,
      ),
    ).toThrow(/unknown transcript turn/u);
  });

  it("requires evidence for every action item and a real transcript speaker owner", () => {
    const transcript = FinalTranscript.create(transcriptSnapshot);

    expect(() =>
      EvidenceBackedSummary.create(
        {
          ...summarySnapshot,
          actionItems: [
            {
              ...summarySnapshot.actionItems[0],
              evidenceTurnIds: [],
            },
          ],
        },
        transcript,
      ),
    ).toThrow(/at least one transcript turn/u);

    expect(() =>
      EvidenceBackedSummary.create(
        {
          ...summarySnapshot,
          actionItems: [
            {
              ...summarySnapshot.actionItems[0],
              ownerSpeakerId: "speaker-c",
            },
          ],
        },
        transcript,
      ),
    ).toThrow(/is not a transcript speaker/u);
  });

  it("derives a stable collision-safe publication identity", () => {
    const first = recordedMeeting();
    const transcript = FinalTranscript.create(transcriptSnapshot);
    first.beginTranscription();
    first.completeTranscription(transcript);
    first.beginSummary();
    first.completeSummary(EvidenceBackedSummary.create(summarySnapshot, transcript));

    const restored = Meeting.restore(first.toSnapshot());
    expect(restored.publicationIdempotencyKey()).toBe(
      first.publicationIdempotencyKey(),
    );
    expect(first.publicationIdempotencyKey()).toContain("meeting-summary-publication:v1");
  });
});
