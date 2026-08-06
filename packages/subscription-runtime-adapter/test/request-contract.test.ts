import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildSubscriptionRuntimeSummaryRequest,
  canonicalJsonSha256,
} from "../src/index.js";

describe("subscription runtime request contract", () => {
  it("is deterministic for the same meeting summary identity", () => {
    const input = {
      idempotencyKey: "meeting:transcript:summary-v1",
      meetingId: "meeting",
      transcript: {
        recordingId: "recording",
        transcriptId: "transcript",
        turns: [
          {
            endMs: 1_000,
            speakerId: "speaker",
            startMs: 0,
            text: "Приняли решение.",
            turnId: "turn",
          },
        ],
        version: 1,
      },
    } as const;
    const options = {
      isolatedCwd: "/runtime/workspace",
      maxOutputTokens: 2_048,
      maxPromptBytes: 1_024 * 1_024,
      timeoutMs: 600_000,
    } as const;

    const first = buildSubscriptionRuntimeSummaryRequest(input, options);
    const second = buildSubscriptionRuntimeSummaryRequest(input, options);

    expect(second).toEqual(first);
    expect(canonicalJsonSha256(second)).toBe(canonicalJsonSha256(first));
    expect(first.runId).toMatch(/^summary-request-[0-9a-f]{32}$/u);
    expect(first.context.metadata.policyVersion).toBe(
      "meeting-summary.subscription-runtime.v9",
    );
    expect(first.task.controls.outputSchemaName).toBe(
      "discord_meeting_summary_v4",
    );
    expect(first.task.outputSchemaName).toBe("discord_meeting_summary_v4");
    expect(first.task.controls.maxOutputTokens).toBe(2_048);
    expect(first.task.controls.model).toBe("gpt-5.6-sol");
    expect(first.task.controls.reasoningEffort).toBe("medium");
    expect(first.task.controls.outputSchema).toMatchObject({
      properties: {
        actionItems: {
          items: {
            properties: {
              deadline: {
                anyOf: [{ maxLength: 96 }, { type: "null" }],
              },
              evidenceTurnIds: { maxItems: 2 },
              text: { maxLength: 160 },
            },
          },
          maxItems: 5,
        },
        decisions: { maxItems: 5 },
        openQuestions: { maxItems: 5 },
        overview: { maxLength: 320 },
        title: { maxLength: 96 },
        topics: {
          items: {
            properties: {
              evidenceTurnIds: { maxItems: 2 },
              points: { maxItems: 2 },
            },
          },
          maxItems: 4,
        },
      },
    });
    expect(first.task.systemPrompt).toContain("one strongest evidenceTurnId");
    expect(first.task.systemPrompt).toContain("Merge semantic duplicates");
    expect(first.task.systemPrompt).toContain("full transcript remains authoritative");
    expect(canonicalJsonSha256(first.task.controls.outputSchema)).toBe(
      "a9822807c85eae1a5fc542bad4b40b62adea5539eb3a4eef8078ac47d3a1c8ee",
    );
    expect(
      createHash("sha256").update(first.task.systemPrompt).digest("hex"),
    ).toBe("89183d5e5a4f7cb76799704a282a151059478dad64dcad9eee62d0bc06dfe762");
  });

  it("rejects an oversized transcript before transport", () => {
    expect(() =>
      buildSubscriptionRuntimeSummaryRequest(
        {
          idempotencyKey: "idempotency",
          meetingId: "meeting",
          transcript: {
            recordingId: "recording",
            transcriptId: "transcript",
            turns: [
              {
                endMs: 1,
                speakerId: "speaker",
                startMs: 0,
                text: "x".repeat(2_048),
                turnId: "turn",
              },
            ],
            version: 1,
          },
        },
        {
          isolatedCwd: "/runtime/workspace",
          maxOutputTokens: 2_048,
          maxPromptBytes: 1_024,
          timeoutMs: 600_000,
        },
      ),
    ).toThrow("Transcript exceeds the configured summary prompt limit");
  });
});
