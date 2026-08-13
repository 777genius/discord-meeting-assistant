import { describe, expect, it } from "vitest";

import { EvidenceBackedSummary } from "@discord-meeting/meeting-core/meeting-intelligence";
import {
  Meeting,
  MeetingLifecycleInvariantError,
} from "@discord-meeting/meeting-core/meeting-lifecycle";
import { FinalTranscript } from "@discord-meeting/meeting-core/transcription";

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

function recordedMeeting(): Meeting {
  return Meeting.record({
    actors: [
      { actorId: "speaker-a", kind: "human" },
      { actorId: "speaker-b", kind: "human" },
      { actorId: "botik", kind: "automation" },
    ],
    meetingId: "meeting-1",
    publicationTargetId: "results-channel",
    recording,
    source: { roomId: "room-1", scopeId: "scope-1" },
  });
}

describe("Meeting lifecycle", () => {
  it("retains normalized source and actor identity in every snapshot", () => {
    const snapshot = recordedMeeting().toSnapshot();

    expect(snapshot.source).toEqual({ roomId: "room-1", scopeId: "scope-1" });
    expect(snapshot.actors).toEqual([
      { actorId: "botik", kind: "automation" },
      { actorId: "speaker-a", kind: "human" },
      { actorId: "speaker-b", kind: "human" },
    ]);
    expect(Meeting.restore(snapshot).toSnapshot()).toEqual(snapshot);
  });

  it("maps absent legacy identity to explicit nulls without blocking old workflows", () => {
    const { actors: _actors, source: _source, ...legacy } = recordedMeeting().toSnapshot();
    const restored = Meeting.restore(legacy).toSnapshot();

    expect(restored.actors).toBeNull();
    expect(restored.source).toBeNull();
    expect(restored.transcriptionStage.status).toBe("pending");
  });

  it("fails closed for duplicate actors and conflicting actor kinds", () => {
    const base = {
      meetingId: "meeting-1",
      publicationTargetId: "results-channel",
      recording,
      source: { roomId: "room-1", scopeId: "scope-1" },
    } as const;

    expect(() => Meeting.record({
      ...base,
      actors: [
        { actorId: "speaker-a", kind: "human" },
        { actorId: "speaker-a", kind: "automation" },
      ],
    })).toThrow(expect.objectContaining({ code: "CONFLICTING_ACTOR_KIND" }));
    expect(() => Meeting.record({
      ...base,
      actors: [
        { actorId: "speaker-a", kind: "human" },
        { actorId: "speaker-a", kind: "human" },
      ],
    })).toThrow(expect.objectContaining({ code: "DUPLICATE_ACTOR" }));
  });

  it("allows only ordered transitions and treats identical completion as idempotent", () => {
    const meeting = recordedMeeting();
    const transcript = FinalTranscript.create(transcriptSnapshot);

    expect(() => meeting.beginSummary()).toThrow(MeetingLifecycleInvariantError);
    expect(() => meeting.completeTranscription(transcript)).toThrow(/must be running/u);

    expect(meeting.beginTranscription()).toBe("started");
    expect(meeting.completeTranscription(transcript)).toBe(true);
    const completedRevision = meeting.revision;
    expect(meeting.completeTranscription(FinalTranscript.create(transcriptSnapshot))).toBe(false);
    expect(meeting.revision).toBe(completedRevision);

    const summary = EvidenceBackedSummary.create(summarySnapshot, transcript);
    expect(meeting.beginSummary()).toBe("started");
    expect(meeting.completeSummary(summary)).toBe(true);
    expect(meeting.beginPublication()).toBe("started");

    const key = meeting.publicationIdempotencyKey();
    expect(meeting.completePublication({
      externalPublicationId: "thread-1",
      idempotencyKey: key,
    })).toBe(true);
    expect(meeting.completePublication({
      externalPublicationId: "thread-1",
      idempotencyKey: key,
    })).toBe(false);
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
    expect(retryable.stage("transcription")).toMatchObject({ attempts: 2, status: "running" });

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

    expect(() => Meeting.restore({
      ...snapshot,
      summaryStage: { attempts: 1, status: "running" },
    })).toThrow(/requires successful transcription/u);
  });

  it("restores legacy string questions without inventing evidence or losing text", () => {
    const meeting = recordedMeeting();
    const transcript = FinalTranscript.create(transcriptSnapshot);
    meeting.beginTranscription();
    meeting.completeTranscription(transcript);
    meeting.beginSummary();
    meeting.completeSummary(EvidenceBackedSummary.create(summarySnapshot, transcript));
    const snapshot = meeting.toSnapshot();
    const legacySnapshot = {
      ...snapshot,
      summary: {
        ...snapshot.summary,
        openQuestions: ["Who will verify the deployment?"],
      },
    } as unknown as Parameters<typeof Meeting.restore>[0];

    expect(() => EvidenceBackedSummary.create(legacySnapshot.summary!, transcript))
      .toThrow(/evidence-backed question contract/u);
    expect(Meeting.restore(legacySnapshot).toSnapshot().summary).toMatchObject({
      legacyUnverifiedOpenQuestions: ["Who will verify the deployment?"],
      openQuestions: [],
    });
  });

  it("derives a stable collision-safe publication identity", () => {
    const first = recordedMeeting();
    const transcript = FinalTranscript.create(transcriptSnapshot);
    first.beginTranscription();
    first.completeTranscription(transcript);
    first.beginSummary();
    first.completeSummary(EvidenceBackedSummary.create(summarySnapshot, transcript));

    const restored = Meeting.restore(first.toSnapshot());
    expect(restored.publicationIdempotencyKey()).toBe(first.publicationIdempotencyKey());
    expect(first.publicationIdempotencyKey()).toContain("meeting-summary-publication:v1");
  });

  it("owns validation failures for publishing-owned receipt identifiers", () => {
    const meeting = recordedMeeting();
    const transcript = FinalTranscript.create(transcriptSnapshot);
    meeting.beginTranscription();
    meeting.completeTranscription(transcript);
    meeting.beginSummary();
    meeting.completeSummary(EvidenceBackedSummary.create(summarySnapshot, transcript));
    meeting.beginPublication();

    expect(() =>
      meeting.completePublication({
        externalPublicationId: "   ",
        idempotencyKey: meeting.publicationIdempotencyKey(),
      }),
    ).toThrow(MeetingLifecycleInvariantError);
  });
});
