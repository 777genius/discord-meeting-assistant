import { describe, expect, it } from "vitest";

import { EvidenceBackedSummary } from "@discord-meeting/meeting-core/meeting-intelligence";
import { FinalTranscript } from "@discord-meeting/meeting-core/transcription";

const transcript = FinalTranscript.create({
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
});

const summarySnapshot = {
  actionItems: [
    {
      actionItemId: "action-1",
      deadline: "Friday",
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
  openQuestions: [
    {
      evidenceTurnIds: ["turn-2"],
      id: "question-1",
      text: "Who will verify the deployment?",
    },
  ],
  overview: "The team agreed on a Friday release.",
  summaryId: "summary-1",
  title: "Release planning",
  topics: [
    {
      evidenceTurnIds: ["turn-1", "turn-2"],
      points: ["Friday release", "Release checklist ownership"],
      title: "Release readiness",
    },
  ],
  transcriptId: "transcript-1",
  version: 1,
} as const;

describe("Evidence-backed summary", () => {
  it("requires every structured topic to reference real transcript evidence", () => {
    expect(() =>
      EvidenceBackedSummary.create(
        {
          ...summarySnapshot,
          topics: [
            {
              ...summarySnapshot.topics[0],
              evidenceTurnIds: ["missing-turn"],
            },
          ],
        },
        transcript,
      ),
    ).toThrow(/unknown transcript turn/u);
  });

  it("normalizes legacy persisted summaries without topics or deadlines", () => {
    const legacySummary = {
      ...summarySnapshot,
      actionItems: summarySnapshot.actionItems.map(({ deadline: _, ...item }) => item),
    };
    const { topics: _, ...legacySnapshot } = legacySummary;

    expect(EvidenceBackedSummary.create(legacySnapshot, transcript).toSnapshot())
      .toMatchObject({
        actionItems: [{ deadline: null }],
        topics: [],
      });
  });

  it("rejects decision evidence that does not reference an existing turn", () => {
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

    expect(() =>
      EvidenceBackedSummary.create(
        {
          ...summarySnapshot,
          actionItems: [
            {
              ...summarySnapshot.actionItems[0],
              deadline: "   ",
            },
          ],
        },
        transcript,
      ),
    ).toThrow(/deadline must not be empty/u);
  });

  it("requires every open question to have a unique id and real evidence", () => {
    expect(() =>
      EvidenceBackedSummary.create(
        {
          ...summarySnapshot,
          openQuestions: [
            {
              ...summarySnapshot.openQuestions[0],
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
          openQuestions: [
            {
              ...summarySnapshot.openQuestions[0],
              evidenceTurnIds: ["missing-turn"],
            },
          ],
        },
        transcript,
      ),
    ).toThrow(/unknown transcript turn/u);

    expect(() =>
      EvidenceBackedSummary.create(
        {
          ...summarySnapshot,
          openQuestions: [
            summarySnapshot.openQuestions[0],
            {
              ...summarySnapshot.openQuestions[0],
              text: "Is a rollback drill required?",
            },
          ],
        },
        transcript,
      ),
    ).toThrow(/IDs must be unique/u);
  });
});
