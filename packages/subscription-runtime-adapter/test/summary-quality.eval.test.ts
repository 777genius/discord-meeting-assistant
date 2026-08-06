import { describe, expect, it } from "vitest";

import { buildSubscriptionRuntimeSummaryRequest } from "../src/index.js";

const options = {
  isolatedCwd: "/runtime/workspace",
  maxOutputTokens: 2_048,
  maxPromptBytes: 1_024 * 1_024,
  timeoutMs: 600_000,
} as const;

function requestFor(texts: readonly string[]) {
  return buildSubscriptionRuntimeSummaryRequest(
    {
      idempotencyKey: "summary-quality-eval",
      meetingId: "meeting-quality-eval",
      transcript: {
        recordingId: "recording-quality-eval",
        transcriptId: "transcript-quality-eval",
        turns: texts.map((text, index) => ({
          endMs: (index + 1) * 2_000,
          speakerId: `speaker-${index % 2}`,
          startMs: index * 2_000,
          text,
          turnId: `turn-${index + 1}`,
        })),
        version: 1,
      },
    },
    options,
  );
}

describe("final summary quality evals", () => {
  it("selects Russian for a Russian transcript with embedded technical terms", () => {
    const request = requestFor([
      "Старые URL должны продолжить работать после миграции.",
      "Параметр code передаем явно, а публичный Quanta ID не показываем.",
      "Landing slug оставляем человекочитаемым.",
    ]);
    const prompt = JSON.parse(request.task.prompt) as { outputLanguage: string };

    expect(prompt.outputLanguage).toBe(
      "Natural Russian; preserve technical terms exactly",
    );
  });

  it("selects Ukrainian from lexical markers without exclusive letters", () => {
    const request = requestFor(["Будь ласка, додай код та залиш посилання."]);
    const prompt = JSON.parse(request.task.prompt) as { outputLanguage: string };

    expect(prompt.outputLanguage).toBe(
      "Natural Ukrainian; preserve technical terms exactly",
    );
  });

  it("keeps material acceptance details and contextual evidence in the admitted policy", () => {
    const request = requestFor(["Предлагаю оставить старые ссылки.", "Да, можем."]);

    expect(request.task.systemPrompt).toContain("exact parameters");
    expect(request.task.systemPrompt).toContain("compatibility or migration behavior");
    expect(request.task.systemPrompt).toContain("privacy constraints");
    expect(request.task.systemPrompt).toContain("code, URL parameters, slugs");
    expect(request.task.systemPrompt).toContain("cite both the nearest supporting context turn");
    expect(request.task.systemPrompt).toContain("outputLanguage supplied in the prompt");
  });

  it("selects English for an English transcript and falls back for balanced language", () => {
    const englishPrompt = JSON.parse(
      requestFor(["Keep old links working and use a readable landing slug."]).task.prompt,
    ) as { outputLanguage: string };
    const balancedPrompt = JSON.parse(
      requestFor(["тест test"]).task.prompt,
    ) as { outputLanguage: string };

    expect(englishPrompt.outputLanguage).toContain("Natural English");
    expect(balancedPrompt.outputLanguage).toBe(
      "The dominant natural language of the transcript; preserve technical terms exactly",
    );
  });
});
