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
        policyVersion: "meeting-summary.subscription-runtime.v15",
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
  it("retains only completed lifecycle effects for one meeting", () => {
    const greeting = {
      greetingLocale: "ru", meetingId: "meeting-1",
      message: "Participant greeting playback settled", participantId: "participant-1",
      participantNameStatus: "unknown", time: "2026-08-06T19:18:37.000Z",
      turnId: "participant-greeting:participant-1",
    };
    const farewell = {
      evidenceTurnIds: ["turn-1"], locale: "ru", meetingId: "meeting-1",
      message: "Meeting farewell playback settled", playbackAttemptId: "farewell-1",
      reason: "explicit-group", time: "2026-08-06T19:19:37.000Z",
      turnId: "meeting-farewell:v1",
    };
    const output = [
      JSON.stringify({ ...greeting, meetingId: "other" }),
      JSON.stringify(greeting),
      JSON.stringify({ ...greeting, participantId: "participant-2", turnId: "participant-greeting:participant-2", greetingLocale: "en" }),
      JSON.stringify({ ...greeting, participantId: "participant-3", turnId: "participant-greeting:participant-3" }),
      JSON.stringify(farewell),
    ].join("\n");
    const events = parseConversationLifecycleEvidenceLogs(output, "meeting-1").events;
    expect(events).toHaveLength(4);
    expect(events[0]).not.toHaveProperty("greetingText");
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
    policyVersion: "meeting-summary.subscription-runtime.v15",
    purpose: "discord_meeting.summary.generate",
    reasoningEffort: "medium",
    runId: "summary-run-1",
    status: "completed",
    time: "2026-08-06T19:18:37.000Z",
  });
}
