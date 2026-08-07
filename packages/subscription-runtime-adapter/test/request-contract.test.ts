import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildSubscriptionRuntimeSummaryRequest,
  canonicalJsonSha256,
  providerMeetingSummarySchema,
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
      maxOutputTokens: 8_192,
      maxPromptBytes: 1_024 * 1_024,
      timeoutMs: 600_000,
    } as const;

    const first = buildSubscriptionRuntimeSummaryRequest(input, options);
    const second = buildSubscriptionRuntimeSummaryRequest(input, options);

    expect(second).toEqual(first);
    expect(canonicalJsonSha256(second)).toBe(canonicalJsonSha256(first));
    expect(first.runId).toMatch(/^summary-request-[0-9a-f]{32}$/u);
    expect(first.context.metadata.policyVersion).toBe(
      "meeting-summary.subscription-runtime.v15",
    );
    expect(first.task.controls.outputSchemaName).toBe(
      "discord_meeting_summary_v4",
    );
    expect(first.task.outputSchemaName).toBe("discord_meeting_summary_v4");
    expect(first.task.controls.maxOutputTokens).toBe(8_192);
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
              evidenceTurnIds: { maxItems: 8 },
              text: { maxLength: 160 },
            },
          },
          maxItems: 5,
        },
        decisions: {
          items: {
            properties: { evidenceTurnIds: { maxItems: 4 } },
          },
          maxItems: 5,
        },
        openQuestions: {
          items: {
            properties: { evidenceTurnIds: { maxItems: 4 } },
          },
          maxItems: 5,
        },
        overview: { maxLength: 320 },
        title: { maxLength: 96 },
        topics: {
          items: {
            properties: {
              evidenceTurnIds: { maxItems: 4 },
              points: { maxItems: 2 },
            },
          },
          maxItems: 4,
        },
      },
    });
    expect(first.task.systemPrompt).toContain("one strongest evidenceTurnId");
    expect(first.task.systemPrompt).toContain("Merge only true semantic duplicates");
    expect(first.task.systemPrompt).toContain("full transcript remains authoritative");
    expect(canonicalJsonSha256(first.task.controls.outputSchema)).toBe(
      "6392e2f6d2898dca426cb216f8e780a7b9e1204e1e500c9e0f3e905fbb49e0a1",
    );
    expect(
      createHash("sha256").update(first.task.systemPrompt).digest("hex"),
    ).toBe("5297b00d2c3e129b672f73a7d60c7b74187e300ce1fdf17df70fe991b3ad503b");
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
          maxOutputTokens: 8_192,
          maxPromptBytes: 1_024,
          timeoutMs: 600_000,
        },
      ),
    ).toThrow("Transcript exceeds the configured summary prompt limit");
  });

  it("admits enough bounded evidence for one fragmented semantic item", () => {
    const summary = {
      actionItems: [],
      decisions: [],
      openQuestions: [],
      overview: "Обсудили проверку очереди.",
      title: "Проверка очереди",
      topics: [],
    };
    const fourEvidence = ["turn-1", "turn-2", "turn-3", "turn-4"];
    const fiveEvidence = [...fourEvidence, "turn-5"];
    const eightEvidence = [...fiveEvidence, "turn-6", "turn-7", "turn-8"];
    const nineEvidence = [...eightEvidence, "turn-9"];

    expect(providerMeetingSummarySchema.safeParse({
      ...summary,
      actionItems: [{
        deadline: "до пятницы",
        evidenceTurnIds: eightEvidence,
        ownerSpeakerId: "speaker-1",
        text: "Проверить очередь и оставить результат в Discord thread",
      }],
    }).success).toBe(true);
    expect(providerMeetingSummarySchema.safeParse({
      ...summary,
      actionItems: [{
        deadline: "до пятницы",
        evidenceTurnIds: nineEvidence,
        ownerSpeakerId: "speaker-1",
        text: "Проверить очередь и оставить результат в Discord thread",
      }],
    }).success).toBe(false);

    const cases = [
      {
        createItem: (evidenceTurnIds: string[]) => ({
          evidenceTurnIds,
          text: "Выпустить версию",
        }),
        field: "decisions",
      },
      {
        createItem: (evidenceTurnIds: string[]) => ({
          evidenceTurnIds,
          text: "Нужен ли повторный запуск?",
        }),
        field: "openQuestions",
      },
      {
        createItem: (evidenceTurnIds: string[]) => ({
          evidenceTurnIds,
          points: ["Craig recording запускает PostgreSQL pipeline"],
          title: "Обработка записи",
        }),
        field: "topics",
      },
    ] as const;

    for (const testCase of cases) {
      expect(providerMeetingSummarySchema.safeParse({
        ...summary,
        [testCase.field]: [testCase.createItem(fourEvidence)],
      }).success).toBe(true);
      expect(providerMeetingSummarySchema.safeParse({
        ...summary,
        [testCase.field]: [testCase.createItem(fiveEvidence)],
      }).success).toBe(false);
    }
  });
});
