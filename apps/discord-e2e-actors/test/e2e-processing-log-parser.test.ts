import { describe, expect, it } from "vitest";

import { parseProcessingEvidenceLogs } from "../src/e2e-processing-log-parser.js";

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
        policyVersion: "meeting-summary.subscription-runtime.v13",
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
    policyVersion: "meeting-summary.subscription-runtime.v13",
    purpose: "discord_meeting.summary.generate",
    reasoningEffort: "medium",
    runId: "summary-run-1",
    status: "completed",
    time: "2026-08-06T19:18:37.000Z",
  });
}
