import type {
  SummaryPublicationPort,
  SummaryPublicationRequest,
} from "@discord-meeting/meeting-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  DiscordProjectionConfigurationError,
  DiscordProjectionConflictError,
  DiscordSummaryPublicationAdapter,
  type DiscordProjectionReference,
  type PublishDiscordSummary,
} from "../src/index.js";

const request: SummaryPublicationRequest = {
  idempotencyKey: "meeting:42:publication:v1",
  meetingId: "meeting-42",
  publicationTargetId: "11111111111111111",
  transcript: {
    recordingId: "recording-42",
    transcriptId: "transcript-42",
    turns: [
      { endMs: 1_250, speakerId: "speaker-a", startMs: 0, text: "Релиз в пятницу", turnId: "turn-1" },
      { endMs: 2_800, speakerId: "speaker-b", startMs: 900, text: "Подготовлю дашборд", turnId: "turn-2" },
      { endMs: 4_200, speakerId: "speaker-a", startMs: 3_000, text: "Проверить транскрипцию", turnId: "turn-3" },
    ],
    version: 1,
  },
  summary: {
    actionItems: [
      {
        actionItemId: "action-1",
        deadline: "к четвергу",
        evidenceTurnIds: ["turn-2"],
        ownerSpeakerId: "speaker-b",
        text: "Подготовить дашборд к четвергу",
      },
      {
        actionItemId: "action-2",
        deadline: null,
        evidenceTurnIds: ["turn-3"],
        ownerSpeakerId: null,
        text: "Проверить точность транскрипции",
      },
    ],
    decisions: [
      {
        decisionId: "decision-1",
        evidenceTurnIds: ["turn-1", "turn-2"],
        text: "Выпустить ассистента в пятницу",
      },
    ],
    openQuestions: ["Достигнута ли целевая точность?"],
    overview: "Команда согласовала выпуск и владельцев подготовки.",
    summaryId: "summary-42",
    title: "  Итоги   встречи  ",
    topics: [
      {
        evidenceTurnIds: ["turn-1", "turn-2"],
        points: ["Релиз запланирован на пятницу", "Дашборд готовит speaker-b"],
        title: "Подготовка релиза",
      },
    ],
    transcriptId: "transcript-42",
    version: 1,
  },
};

class FakeProjector {
  readonly inputs: PublishDiscordSummary[] = [];

  constructor(
    private readonly outcome: DiscordProjectionReference | Error = {
      threadId: "22222222222222222",
      messageId: "33333333333333333",
    },
  ) {}

  async publish(input: PublishDiscordSummary): Promise<DiscordProjectionReference> {
    this.inputs.push(input);
    if (this.outcome instanceof Error) {
      throw this.outcome;
    }
    return this.outcome;
  }
}

describe("DiscordSummaryPublicationAdapter", () => {
  it("maps the core port request to one deterministic Russian Discord projection", async () => {
    const projector = new FakeProjector();
    const adapter: SummaryPublicationPort = new DiscordSummaryPublicationAdapter(projector);

    const first = await adapter.publish(request);
    const second = await adapter.publish(request);

    expect(first).toEqual({
      ok: true,
      value: {
        externalPublicationId:
          "discord:v1:thread:22222222222222222:message:33333333333333333",
      },
    });
    expect(second).toEqual(first);
    expect(projector.inputs).toHaveLength(2);
    expect(projector.inputs[0]).toEqual(projector.inputs[1]);
    expect(projector.inputs[0]).toEqual({
      projectionKey: "meeting:42:publication:v1",
      parentChannelId: "11111111111111111",
      threadTitle: "Итоги встречи",
      markdown: [
        "# Итоги встречи",
        "",
        "## Кратко",
        "Команда согласовала выпуск и владельцев подготовки.",
        "",
        "## Основные темы",
        "1. Подготовка релиза",
        "   - Релиз запланирован на пятницу",
        "   - Дашборд готовит speaker-b",
        "   - Доказательства: `turn-1` [00:00.000-00:01.250] `speaker-a`, `turn-2` [00:00.900-00:02.800] `speaker-b`",
        "",
        "## Решения",
        "1. Выпустить ассистента в пятницу",
        "   - Доказательства: `turn-1` [00:00.000-00:01.250] `speaker-a`, `turn-2` [00:00.900-00:02.800] `speaker-b`",
        "",
        "## Задачи",
        "1. Подготовить дашборд к четвергу",
        "   - Ответственный: `speaker-b`",
        "   - Срок: к четвергу",
        "   - Доказательства: `turn-2` [00:00.900-00:02.800] `speaker-b`",
        "2. Проверить точность транскрипции",
        "   - Ответственный: не назначен",
        "   - Срок: не указан",
        "   - Доказательства: `turn-3` [00:03.000-00:04.200] `speaker-a`",
        "",
        "## Открытые вопросы",
        "- Достигнута ли целевая точность?",
        "",
        "Встреча: `meeting-42` · Саммари: `summary-42` · Версия: 1",
      ].join("\n"),
    });
  });

  it("renders explicit empty states instead of omitting sections", async () => {
    const projector = new FakeProjector();
    const adapter = new DiscordSummaryPublicationAdapter(projector);

    await adapter.publish({
      ...request,
      summary: {
        ...request.summary,
        actionItems: [],
        decisions: [],
        openQuestions: [],
        topics: [],
      },
    });

    expect(projector.inputs[0]?.markdown).toContain("Зафиксированных решений нет.");
    expect(projector.inputs[0]?.markdown).toContain("Зафиксированных задач нет.");
    expect(projector.inputs[0]?.markdown).toContain("Основные темы не выделены.");
    expect(projector.inputs[0]?.markdown).toContain("Открытых вопросов нет.");
  });

  it("deterministically bounds oversized summaries to the Discord limit", async () => {
    const projector = new FakeProjector();
    const adapter = new DiscordSummaryPublicationAdapter(projector);

    const result = await adapter.publish({
      ...request,
      summary: {
        ...request.summary,
        overview: "Очень длинное описание встречи. ".repeat(400),
      },
    });

    expect(result.ok).toBe(true);
    expect(projector.inputs[0]?.markdown.length).toBeLessThanOrEqual(4_000);
    expect(projector.inputs[0]?.markdown).toContain(
      "Саммари сокращено из-за лимита Discord.",
    );
    expect(projector.inputs[0]?.markdown).toContain(
      "Встреча: `meeting-42` · Саммари: `summary-42` · Версия: 1",
    );
  });

  it.each([
    {
      error: new DiscordProjectionConflictError(
        "thread",
        "meeting-projection:01234567890123456789",
      ),
      expected: {
        code: "DISCORD_PUBLICATION_CONFLICT",
        message: "Discord publication has multiple projections for the same idempotency key",
        retryable: false,
      },
    },
    {
      error: new DiscordProjectionConfigurationError("Discord target is not a text channel"),
      expected: {
        code: "DISCORD_PUBLICATION_CONFIGURATION",
        message: "Discord target is not a text channel",
        retryable: false,
      },
    },
    {
      error: z.string().safeParse(42).error,
      expected: {
        code: "DISCORD_PUBLICATION_INVALID_INPUT",
        message: "Discord publication request is invalid",
        retryable: false,
      },
    },
    {
      error: Object.assign(new Error("rate limited"), { status: 429 }),
      expected: {
        code: "DISCORD_PUBLICATION_REQUEST_FAILED",
        message: "Discord publication request failed",
        retryable: true,
      },
    },
    {
      error: Object.assign(new Error("forbidden"), { status: 403 }),
      expected: {
        code: "DISCORD_PUBLICATION_REQUEST_FAILED",
        message: "Discord publication request failed",
        retryable: false,
      },
    },
    {
      error: Object.assign(new Error("projection was deleted"), { status: 404 }),
      expected: {
        code: "DISCORD_PUBLICATION_REQUEST_FAILED",
        message: "Discord publication request failed",
        retryable: true,
      },
    },
    {
      error: new Error("socket reset"),
      expected: {
        code: "DISCORD_PUBLICATION_REQUEST_FAILED",
        message: "Discord publication request failed",
        retryable: true,
      },
    },
  ])("maps provider failure without leaking provider details", async ({ error, expected }) => {
    const adapter = new DiscordSummaryPublicationAdapter(new FakeProjector(error));

    const result = await adapter.publish(request);

    expect(result).toEqual({ ok: false, failure: expected });
  });
});
