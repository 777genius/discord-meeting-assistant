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
      maxOutputTokens: 4_096,
      maxPromptBytes: 1_024 * 1_024,
      timeoutMs: 600_000,
    } as const;

    const first = buildSubscriptionRuntimeSummaryRequest(input, options);
    const second = buildSubscriptionRuntimeSummaryRequest(input, options);

    expect(second).toEqual(first);
    expect(canonicalJsonSha256(second)).toBe(canonicalJsonSha256(first));
    expect(first.runId).toMatch(/^summary-request-[0-9a-f]{32}$/u);
    expect(first.context.metadata.policyVersion).toBe(
      "meeting-summary.subscription-runtime.v7",
    );
    expect(first.task.controls.outputSchemaName).toBe(
      "discord_meeting_summary_v3",
    );
    expect(first.task.outputSchemaName).toBe("discord_meeting_summary_v3");
    expect(first.task.controls.model).toBe("gpt-5.6-sol");
    expect(first.task.controls.reasoningEffort).toBe("medium");
    expect(canonicalJsonSha256(first.task.controls.outputSchema)).toBe(
      "0fce6806195914a23398610f8284cdfe99a32ba17d2c4ecc71c103e77fb13bfd",
    );
    expect(
      createHash("sha256").update(first.task.systemPrompt).digest("hex"),
    ).toBe("ad1df770820f372f350e395048c893e73f4a2841579b0a1152623b985bb99126");
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
          maxOutputTokens: 4_096,
          maxPromptBytes: 1_024,
          timeoutMs: 600_000,
        },
      ),
    ).toThrow("Transcript exceeds the configured summary prompt limit");
  });
});
