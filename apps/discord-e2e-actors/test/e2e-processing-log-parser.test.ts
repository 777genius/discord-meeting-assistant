import { describe, expect, it } from "vitest";

import {
  parseConversationLifecycleEvidenceLogs,
  parseProcessingEvidenceLogs,
} from "../src/e2e-processing-log-parser.js";

describe("parseProcessingEvidenceLogs", () => {
  it("retains only correlated successful stages and completed final-summary executions", () => {
    const lines = [
      "not-json",
      stage("other-meeting", "transcription", 99),
      stage("meeting-1", "transcription", 2_161),
      runtime("meeting-1", 44_206),
      stage("meeting-1", "summary", 44_213),
      stage("meeting-1", "publication", 1_169),
    ];

    expect(parseProcessingEvidenceLogs(lines.join("\n"), "meeting-1")).toEqual({
      stages: [
        { durationMs: 2_161, observedAt: "2026-08-06T19:18:37.000Z", outcome: "succeeded", stage: "transcription" },
        { durationMs: 44_213, observedAt: "2026-08-06T19:18:37.000Z", outcome: "succeeded", stage: "summary" },
        { durationMs: 1_169, observedAt: "2026-08-06T19:18:37.000Z", outcome: "succeeded", stage: "publication" },
      ],
      summaryRuntimeExecutions: [{
        durationMs: 44_206,
        model: "gpt-5.6-sol",
        observedAt: "2026-08-06T19:18:37.000Z",
        outputSchemaName: "discord_meeting_summary_v4",
        policyVersion: "meeting-summary.subscription-runtime.v16",
        purpose: "discord_meeting.summary.generate",
        reasoningEffort: "medium",
        runId: "summary-run-1",
        status: "completed",
      }],
    });
  });

  it("fails closed when required observations are absent", () => {
    expect(() => parseProcessingEvidenceLogs(stage("meeting-1", "summary", 10), "meeting-1"))
      .toThrow();
  });
});

describe("parseConversationLifecycleEvidenceLogs", () => {
  it("separates completed semantic effects from participant lifecycle receipts", () => {
    const greeting = {
      greetingLocale: "ru", greetingText: "Привет, Саша!", meetingId: "meeting-1",
      message: "Participant greeting playback settled", participantId: "participant-1",
      participantName: "Саша", participantNameStatus: "unknown",
      time: "2026-08-06T19:18:37.000Z",
      turnId: "participant-greeting:participant-1",
    };
    const farewell = {
      evidenceTurnIds: ["turn-1"], locale: "ru", meetingId: "meeting-1",
      message: "Meeting farewell playback settled", playbackAttemptId: "farewell-1",
      reason: "explicit-group", time: "2026-08-06T19:19:37.000Z",
      turnId: "meeting-farewell:v1",
    };
    const addressed = {
      meetingId: "meeting-1", message: "Live conversation turn observed",
      outcome: "active", speakerId: "participant-4",
      time: "2026-08-06T19:18:47.000Z", turnId: "human-question-1",
    };
    const participantLifecycle = {
      eventType: "participant.left", meetingId: "meeting-1",
      message: "Live participant lifecycle accepted",
      occurredAt: "2026-08-06T19:18:40.000Z", participantId: "participant-2",
      time: "2026-08-06T19:18:40.010Z",
    };
    const output = [
      JSON.stringify({ ...greeting, meetingId: "other" }),
      JSON.stringify(greeting),
      JSON.stringify({ ...greeting, participantId: "participant-2", turnId: "participant-greeting:participant-2:retry-1", greetingLocale: "en" }),
      JSON.stringify({ ...greeting, participantId: "participant-3", turnId: "participant-greeting:participant-3" }),
      JSON.stringify(addressed),
      JSON.stringify(participantLifecycle),
      JSON.stringify({
        ...participantLifecycle,
        eventType: "participant.joined",
        occurredAt: "2026-08-06T19:18:41.000Z",
        time: "2026-08-06T19:18:41.010Z",
      }),
      JSON.stringify(farewell),
    ].join("\n");
    const parsed = parseConversationLifecycleEvidenceLogs(output, "meeting-1");
    const events = parsed.events;
    expect(events).toHaveLength(5);
    expect(events[0]).not.toHaveProperty("greetingText");
    expect(events[0]).not.toHaveProperty("participantName");
    expect(events[1]).toMatchObject({
      participantId: "participant-2",
      turnId: "participant-greeting:participant-2:retry-1",
    });
    expect(events[3]).toMatchObject({
      participantId: "participant-4",
      turnId: "human-question-1",
      type: "addressed-answer",
    });
    expect(parsed.participantLifecycleReceipts).toEqual([
      expect.objectContaining({
        eventType: "participant.left",
        occurredAt: "2026-08-06T19:18:40.000Z",
        participantId: "participant-2",
        type: "participant-lifecycle",
      }),
      expect.objectContaining({
        eventType: "participant.joined",
        occurredAt: "2026-08-06T19:18:41.000Z",
        participantId: "participant-2",
        type: "participant-lifecycle",
      }),
    ]);
  });

  it("retains structured answer playback receipts for the correlated meeting", () => {
    const shared = {
      meetingId: "meeting-1",
      playbackAttemptId: "answer-attempt-1",
      playbackKind: "answer",
      time: "2026-08-06T19:18:47.000Z",
      turnId: "human-question-1",
    };
    const output = [
      ...Array.from({ length: 4 }, (_, index) => JSON.stringify({
        greetingLocale: index === 0 ? "en" : "ru",
        meetingId: "meeting-1",
        message: "Participant greeting playback settled",
        participantId: `participant-${String(index + 1)}`,
        participantNameStatus: index < 2 ? "known" : "unknown",
        time: "2026-08-06T19:18:37.000Z",
        turnId: `participant-greeting:participant-${String(index + 1)}`,
      })),
      JSON.stringify({
        ...shared,
        message: "Conversation playback started",
        playbackStartedAtEpochMs: 1_754_509_527_000,
        playbackStartedAtMonotonicMs: 4_000,
      }),
      JSON.stringify({
        ...shared,
        message: "Conversation playback finished",
        playbackFinishedAtEpochMs: 1_754_509_527_700,
        playbackFinishedAtMonotonicMs: 4_700,
      }),
      JSON.stringify({
        ...shared,
        message: "Conversation playback settled",
        playbackSettledAtEpochMs: 1_754_509_527_800,
        playbackSettledAtMonotonicMs: 4_800,
        settlement: "played",
      }),
      JSON.stringify({
        ...shared,
        meetingId: "other-meeting",
        message: "Conversation playback settled",
        playbackSettledAtEpochMs: 1_754_509_527_800,
        playbackSettledAtMonotonicMs: 4_800,
        settlement: "played",
      }),
      JSON.stringify({
        ...shared,
        message: "Conversation playback started",
        playbackAttemptId: "thinking-cue-attempt-1",
        playbackKind: "thinking-cue",
        playbackStartedAtEpochMs: 1_754_509_526_000,
        playbackStartedAtMonotonicMs: 3_000,
        thinkingCuePcmSha256: "b".repeat(64),
      }),
      JSON.stringify({
        ...shared,
        message: "Conversation playback finished",
        playbackAttemptId: "thinking-cue-attempt-1",
        playbackFinishedAtEpochMs: 1_754_509_526_500,
        playbackFinishedAtMonotonicMs: 3_500,
        playbackKind: "thinking-cue",
        thinkingCuePcmSha256: "b".repeat(64),
      }),
    ].join("\n");

    expect(parseConversationLifecycleEvidenceLogs(output, "meeting-1").playbackReceipts)
      .toEqual([
        expect.objectContaining({
          playbackAttemptId: "answer-attempt-1",
          playbackKind: "answer",
          status: "started",
          turnId: "human-question-1",
        }),
        expect.objectContaining({
          playbackAttemptId: "answer-attempt-1",
          playbackKind: "answer",
          status: "finished",
          turnId: "human-question-1",
        }),
        expect.objectContaining({
          playbackAttemptId: "answer-attempt-1",
          playbackKind: "answer",
          settlement: "played",
          status: "settled",
          turnId: "human-question-1",
        }),
        expect.objectContaining({
          playbackAttemptId: "thinking-cue-attempt-1",
          playbackKind: "thinking-cue",
          status: "started",
          thinkingCuePcmSha256: "b".repeat(64),
        }),
        expect.objectContaining({
          playbackAttemptId: "thinking-cue-attempt-1",
          playbackKind: "thinking-cue",
          status: "finished",
          thinkingCuePcmSha256: "b".repeat(64),
        }),
      ]);
  });

  it("retains grounded epochs, citations, literal provenance and cancellation reason", () => {
    const common = {
      meetingId: "meeting-1",
      time: "2026-08-06T19:18:47.000Z",
      turnId: "human-question-1",
    };
    const output = [
      ...Array.from({ length: 4 }, (_, index) => JSON.stringify({
        greetingLocale: "ru",
        meetingId: "meeting-1",
        message: "Participant greeting playback settled",
        participantId: `participant-${String(index + 1)}`,
        participantNameStatus: "unknown",
        time: "2026-08-06T19:18:37.000Z",
        turnId: `participant-greeting:participant-${String(index + 1)}`,
      })),
      JSON.stringify({
        ...common,
        citationTurnIds: ["authoritative-turn-7"],
        evidenceEpoch: "evidence-7",
        knowledgeEpoch: "knowledge-9",
        message: "Grounded knowledge answer validated",
        participantId: "participant-4",
        playbackProvenance: "literal_tts",
        status: "validated",
      }),
      JSON.stringify({
        ...common,
        message: "Grounded knowledge answer cancelled",
        reason: "disconnected",
        status: "cancelled",
      }),
    ].join("\n");

    expect(parseConversationLifecycleEvidenceLogs(output, "meeting-1").groundedAnswers)
      .toEqual([
        expect.objectContaining({
          citationTurnIds: ["authoritative-turn-7"],
          evidenceEpoch: "evidence-7",
          knowledgeEpoch: "knowledge-9",
          playbackProvenance: "literal_tts",
          status: "validated",
        }),
        expect.objectContaining({ reason: "disconnected", status: "cancelled" }),
      ]);
  });
});

function stage(meetingId: string, stageName: string, durationMilliseconds: number): string {
  return JSON.stringify({
    durationMilliseconds,
    meetingId,
    message: "Meeting processing stage completed",
    outcome: "succeeded",
    stage: stageName,
    time: "2026-08-06T19:18:37.000Z",
  });
}

function runtime(meetingId: string, durationMs: number): string {
  return JSON.stringify({
    durationMs,
    meetingId,
    message: "Subscription runtime task completed",
    model: "gpt-5.6-sol",
    outputSchemaName: "discord_meeting_summary_v4",
    policyVersion: "meeting-summary.subscription-runtime.v16",
    purpose: "discord_meeting.summary.generate",
    reasoningEffort: "medium",
    runId: "summary-run-1",
    status: "completed",
    time: "2026-08-06T19:18:37.000Z",
  });
}
