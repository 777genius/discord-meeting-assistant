import {
  type SummaryPublicationPort,
  type SummaryPublicationRequest,
} from "@discord-meeting/meeting-core/publishing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createMeetingDiscordFinalSummaryProjectionKey,
  createMeetingDiscordProjectionKey,
  discordProjectionBodySchema,
  DISCORD_TRANSCRIPT_ATTACHMENT_MAX_BYTES,
  DiscordProjectionConfigurationError,
  DiscordProjectionConflictError,
  DiscordSummaryPublicationAdapter,
  renderRussianSummaryMarkdown,
  toDiscordMessagePayload,
  type DiscordProjectionReference,
  type PublishDiscordSummary,
} from "../src/index.js";

const request: SummaryPublicationRequest = {
  idempotencyKey: "meeting:42:publication:v1",
  meetingId: "meeting-42",
  publicationTargetId: "11111111111111111",
  transcript: {
    readableSegments: [],
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
    openQuestions: [
      {
        evidenceTurnIds: ["turn-3"],
        id: "question-1",
        text: "Достигнута ли целевая точность?",
      },
    ],
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
      kind: "thread",
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

describe("DiscordSummaryPublicationAdapter transcript projection", () => {
  it("uses compact readable segments only for the final Discord timeline", async () => {
    const projector = new FakeProjector();
    const adapter = new DiscordSummaryPublicationAdapter(projector);

    await adapter.publish({
      ...request,
      transcript: {
        ...request.transcript,
        readableSegments: [
          {
            endMs: 1_250,
            segmentId: "segment-1",
            speakerId: "speaker-a",
            startMs: 0,
            text: "Релиз в пятницу.",
            sourceTurnIds: ["turn-1"],
          },
          {
            endMs: 2_800,
            segmentId: "segment-2",
            speakerId: "speaker-b",
            startMs: 900,
            text: "Подготовлю дашборд.",
            sourceTurnIds: ["turn-2"],
          },
          {
            endMs: 4_200,
            segmentId: "segment-3",
            speakerId: "speaker-a",
            startMs: 3_000,
            text: "Проверить транскрипцию.",
            sourceTurnIds: ["turn-3"],
          },
        ],
      },
    });

    const timeline = projector.inputs[0]?.liveCaptionsMarkdown ?? "";
    const attachment = projector.inputs[0]?.transcriptAttachment?.content ?? "";
    expect(timeline).toContain(
      "✓ `00:00-00:01` **speaker-a:** Релиз в пятницу.",
    );
    expect(timeline).toContain("**speaker-b:** Подготовлю дашборд.");
    expect(attachment).toContain("## `00:00-00:01` · speaker-a");
    expect(attachment).toContain("## `00:00-00:02` · speaker-b");
    expect(attachment).toContain("Подготовлю дашборд");
  });

  it("keeps the raw-turn final timeline when readable segments are empty", async () => {
    const projector = new FakeProjector();
    const adapter = new DiscordSummaryPublicationAdapter(projector);

    await adapter.publish({
      ...request,
      transcript: { ...request.transcript, readableSegments: [] },
    });

    expect(projector.inputs[0]?.liveCaptionsMarkdown).toContain(
      "✓ `00:00-00:02` **speaker-b:** Подготовлю дашборд",
    );
  });
});

describe("DiscordSummaryPublicationAdapter", () => {
  it("maps the core port request to one separate deterministic Discord projection by default", async () => {
    const projector = new FakeProjector();
    const adapter: SummaryPublicationPort = new DiscordSummaryPublicationAdapter(projector);

    const first = await adapter.publish(request);
    const second = await adapter.publish(request);

    expect(first).toEqual({
      ok: true,
      value: {
        externalPublicationId:
          "discord:v2:thread:22222222222222222:message:33333333333333333",
      },
    });
    expect(second).toEqual(first);
    expect(projector.inputs).toHaveLength(2);
    expect(projector.inputs[0]).toEqual(projector.inputs[1]);
    expect(projector.inputs[0]).toEqual({
      projectionKey: createMeetingDiscordFinalSummaryProjectionKey(
        "meeting-42",
        "11111111111111111",
      ),
      parentChannelId: "11111111111111111",
      threadTitle: "Итоги встречи",
      markdown: [
        "# Итоги встречи",
        "",
        "## Кратко",
        "Команда согласовала выпуск и владельцев подготовки.",
        "",
        "## Ключевые темы и детали",
        "1. Подготовка релиза",
        "   - Релиз запланирован на пятницу",
        "   - Дашборд готовит speaker-b",
        "   - **00:00-00:01 · speaker-a:** «Релиз в пятницу»",
        "   - **00:00-00:02 · speaker-b:** «Подготовлю дашборд»",
        "",
        "## Решения",
        "1. Выпустить ассистента в пятницу",
        "   - **00:00-00:01 · speaker-a:** «Релиз в пятницу»",
        "   - **00:00-00:02 · speaker-b:** «Подготовлю дашборд»",
        "",
        "## Задачи",
        "1. Подготовить дашборд к четвергу",
        "   - Ответственный: speaker-b",
        "   - Срок: к четвергу",
        "   - **00:00-00:02 · speaker-b:** «Подготовлю дашборд»",
        "2. Проверить точность транскрипции",
        "   - Ответственный: не назначен",
        "   - Срок: не указан",
        "   - **00:03-00:04 · speaker-a:** «Проверить транскрипцию»",
        "",
        "## Открытые вопросы",
        "1. Достигнута ли целевая точность?",
        "   - **00:03-00:04 · speaker-a:** «Проверить транскрипцию»",
      ].join("\n"),
      liveCaptionsMarkdown: [
        "## 🗣️ Транскрипт встречи",
        "",
        "✓ `00:00-00:01` **speaker-a:** Релиз в пятницу",
        "✓ `00:00-00:02` **speaker-b:** Подготовлю дашборд",
        "✓ `00:03-00:04` **speaker-a:** Проверить транскрипцию",
        "",
        "_Финальный транскрипт составлен по записи встречи. Полная версия приложена: `meeting-transcript.md`._",
      ].join("\n"),
      transcriptAttachment: {
        filename: "meeting-transcript.md",
        content: [
          "# Транскрипт встречи",
          "",
          "_Финальный транскрипт составлен по записи встречи._",
          "",
          "## `00:00-00:01` · speaker-a",
          "",
          "Релиз в пятницу",
          "",
          "## `00:00-00:02` · speaker-b",
          "",
          "Подготовлю дашборд",
          "",
          "## `00:03-00:04` · speaker-a",
          "",
          "Проверить транскрипцию",
        ].join("\n"),
      },
    });
    expect(projector.inputs[0]?.markdown).not.toContain("turn-1");
    expect(projector.inputs[0]?.markdown).not.toContain("summary-42");
  });

  it("passes a settled live receipt as the authoritative final reference", async () => {
    const projector = new FakeProjector();
    const adapter = new DiscordSummaryPublicationAdapter(projector, {
      finalPublicationMode: "replace-live",
    });

    await adapter.publish({
      ...request,
      currentExternalPublicationId:
        "discord:v1:thread:22222222222222222:message:33333333333333333",
    });

    expect(projector.inputs[0]?.currentReference).toEqual({
      kind: "thread",
      threadId: "22222222222222222",
      messageId: "33333333333333333",
    });
    expect(projector.inputs[0]?.projectionKey).toBe(
      createMeetingDiscordProjectionKey("meeting-42", "11111111111111111"),
    );
    expect(projector.inputs[0]?.legacyProjectionKeys).toEqual([
      "meeting:42:publication:v1",
    ]);
  });
});

describe("DiscordSummaryPublicationAdapter rendering", () => {
  it("ignores the live receipt when the default keeps the final summary separate", async () => {
    const projector = new FakeProjector();
    const adapter = new DiscordSummaryPublicationAdapter(projector);

    await adapter.publish({
      ...request,
      currentExternalPublicationId:
        "discord:v1:thread:22222222222222222:message:33333333333333333",
    });

    expect(projector.inputs[0]?.currentReference).toBeUndefined();
    expect(projector.inputs[0]?.legacyProjectionKeys).toBeUndefined();
    expect(projector.inputs[0]?.projectionKey).toBe(
      createMeetingDiscordFinalSummaryProjectionKey(
        "meeting-42",
        "11111111111111111",
      ),
    );
  });

  it("renders Discord speakers as quiet mentions with human time intervals", async () => {
    const projector = new FakeProjector();
    const adapter = new DiscordSummaryPublicationAdapter(projector);
    const speakerId = "1533228054724346087";

    await adapter.publish({
      ...request,
      transcript: {
        ...request.transcript,
        turns: [{
          endMs: 25_300,
          speakerId,
          startMs: 18_740,
          text: "Проверю Discord thread и Redis queue.",
          turnId: "turn:v1:internal",
        }],
      },
      summary: {
        ...request.summary,
        actionItems: [{
          ...request.summary.actionItems[0]!,
          evidenceTurnIds: ["turn:v1:internal"],
          ownerSpeakerId: speakerId,
        }],
        decisions: [],
        topics: [],
      },
    });

    expect(projector.inputs[0]?.markdown).toContain(
      "Owner: <@1533228054724346087>",
    );
    expect(projector.inputs[0]?.markdown).toContain(
      "**00:18-00:25 · <@1533228054724346087>:** «Проверю Discord thread и Redis queue.»",
    );
    expect(projector.inputs[0]?.markdown).not.toContain("Основание:");
    expect(projector.inputs[0]?.markdown).not.toContain("turn:v1:internal");
    expect(projector.inputs[0]?.transcriptAttachment).toEqual({
      content: [
        "# Meeting transcript",
        "",
        "_Final transcript based on the meeting recording._",
        "",
        "## `00:18-00:25` · <@1533228054724346087>",
        "",
        "Проверю Discord thread и Redis queue.",
      ].join("\n"),
      filename: "meeting-transcript.md",
    });
    expect(projector.inputs[0]?.transcriptAttachment?.content).not.toContain(
      "turn:v1:internal",
    );
  });

  it("orders final topics by their earliest valid evidence timestamp", () => {
    const markdown = renderRussianSummaryMarkdown({
      ...request,
      transcript: {
        ...request.transcript,
        turns: [
          {
            endMs: 175_000,
            speakerId: "speaker-early",
            startMs: 170_000,
            text: "Ранняя тема в 02:50.",
            turnId: "turn-early",
          },
          {
            endMs: 281_000,
            speakerId: "speaker-late",
            startMs: 276_000,
            text: "Поздняя тема в 04:36.",
            turnId: "turn-late",
          },
        ],
      },
      summary: {
        ...request.summary,
        actionItems: [],
        decisions: [],
        openQuestions: [],
        topics: [
          {
            evidenceTurnIds: ["turn-late"],
            points: ["Эта тема пришла позже."],
            title: "Поздняя тема",
          },
          {
            evidenceTurnIds: ["turn-early"],
            points: ["Эта тема должна быть первой."],
            title: "Ранняя тема",
          },
          {
            evidenceTurnIds: ["missing-turn"],
            points: ["Без валидной временной привязки."],
            title: "Без тайминга",
          },
        ],
      },
    });

    expect(markdown.indexOf("1. Ранняя тема")).toBeLessThan(markdown.indexOf("2. Поздняя тема"));
    expect(markdown.indexOf("2. Поздняя тема")).toBeLessThan(markdown.indexOf("3. Без тайминга"));
    expect(markdown).toContain("**02:50-02:55 · speaker-early:**");
    expect(markdown).toContain("**04:36-04:41 · speaker-late:**");
    expect(markdown).not.toContain("Основание:");
  });

  it("orders decisions, tasks, and questions by their earliest evidence timestamp", () => {
    const markdown = renderRussianSummaryMarkdown({
      ...request,
      summary: {
        ...request.summary,
        actionItems: request.summary.actionItems.toReversed(),
        decisions: [
          {
            decisionId: "decision-late",
            evidenceTurnIds: ["turn-3"],
            text: "Позднее решение",
          },
          {
            decisionId: "decision-early",
            evidenceTurnIds: ["turn-1"],
            text: "Раннее решение",
          },
        ],
        openQuestions: [
          {
            evidenceTurnIds: ["turn-3"],
            id: "question-late",
            text: "Поздний вопрос?",
          },
          {
            evidenceTurnIds: ["turn-1"],
            id: "question-early",
            text: "Ранний вопрос?",
          },
        ],
        topics: [],
      },
    });

    expect(markdown.indexOf("1. Раннее решение")).toBeLessThan(
      markdown.indexOf("2. Позднее решение"),
    );
    expect(markdown.indexOf("1. Подготовить дашборд")).toBeLessThan(
      markdown.indexOf("2. Проверить точность"),
    );
    expect(markdown.indexOf("1. Ранний вопрос?")).toBeLessThan(
      markdown.indexOf("2. Поздний вопрос?"),
    );
  });
});

describe("Discord recording playback link", () => {
  it("appends a stable recording link without coupling publication to audio", async () => {
    const projector = new FakeProjector();
    const adapter = new DiscordSummaryPublicationAdapter(projector, {
      recordingPlaybackUrl: (meetingId) =>
        `https://recordings.example.com/recordings/playback#signed-${meetingId}`,
    });

    await expect(adapter.publish(request)).resolves.toMatchObject({ ok: true });

    expect(projector.inputs[0]?.markdown).toMatch(
      /## Запись\n\[Прослушать запись\]\(https:\/\/recordings\.example\.com\/recordings\/playback#signed-meeting-42\)$/u,
    );
  });

  it.each([
    {
      footer: "## Recording\n[Listen to the recording]",
      text: "We agreed to release the dashboard on Friday.",
    },
    {
      footer: "## Запис\n[Прослухати запис]",
      text: "Це запис зустрічі, його треба прослухати.",
    },
  ])("localizes the recording footer from the transcript", ({ footer, text }) => {
    const recordingUrl = "https://recordings.example.com/recordings/playback#token";
    const markdown = renderRussianSummaryMarkdown({
      ...request,
      transcript: {
        ...request.transcript,
        turns: [{ ...request.transcript.turns[0]!, text }],
      },
    }, recordingUrl);

    expect(markdown).toContain(`${footer}(${recordingUrl})`);
  });
});

describe("DiscordSummaryPublicationAdapter rendering bounds", () => {
  it("preserves the recording footer when a long summary is shortened", async () => {
    const projector = new FakeProjector();
    const recordingUrl = "https://recordings.example.com/recordings/playback#signed-token";
    const adapter = new DiscordSummaryPublicationAdapter(projector, {
      recordingPlaybackUrl: () => recordingUrl,
    });

    await adapter.publish({
      ...request,
      summary: { ...request.summary, overview: "Очень длинный обзор. ".repeat(500) },
    });

    const markdown = projector.inputs[0]?.markdown ?? "";
    expect(markdown.length).toBeLessThanOrEqual(4_000);
    expect(markdown).toContain("Саммари сокращено из-за лимита Discord");
    expect(markdown.endsWith(`[Прослушать запись](${recordingUrl})`)).toBe(true);
  });

  it("omits a recording footer that cannot fit within the Discord limit", async () => {
    const projector = new FakeProjector();
    const recordingUrl = `https://recordings.example.com/#${"x".repeat(4_000)}`;
    const adapter = new DiscordSummaryPublicationAdapter(projector, {
      recordingPlaybackUrl: () => recordingUrl,
    });

    await adapter.publish({
      ...request,
      summary: { ...request.summary, overview: "Очень длинный обзор. ".repeat(500) },
    });

    const markdown = projector.inputs[0]?.markdown ?? "";
    expect(markdown.length).toBeLessThanOrEqual(4_000);
    expect(markdown).toContain("Саммари сокращено из-за лимита Discord");
    expect(markdown).not.toContain(recordingUrl);
  });

  it("keeps the authoritative, speaker-attributed timeline beside the final summary", async () => {
    const projector = new FakeProjector();
    const adapter = new DiscordSummaryPublicationAdapter(projector);
    const speakers = [
      "1533227577286852649",
      "1533228054724346087",
      "1533775868567224456",
    ];

    await adapter.publish({
      ...request,
      transcript: {
        ...request.transcript,
        turns: speakers.map((speakerId, index) => ({
          endMs: (index + 1) * 5_000,
          speakerId,
          startMs: index * 5_000,
          text: `Реплика участника ${index + 1}`,
          turnId: `turn-${index + 1}`,
        })),
      },
    });

    const timeline = projector.inputs[0]?.liveCaptionsMarkdown ?? "";
    expect(timeline).toContain("## 🗣️ Транскрипт встречи");
    for (const speakerId of speakers) {
      expect(timeline).toContain(`<@${speakerId}>`);
    }
    expect(timeline).toContain("`00:10-00:15`");
    expect(timeline).toContain("Полная версия приложена: `meeting-transcript.md`.");
  });

  it("keeps every final caption in the attachment when the embed is shortened", async () => {
    const projector = new FakeProjector();
    const adapter = new DiscordSummaryPublicationAdapter(projector);
    const turns = Array.from({ length: 45 }, (_, index) => ({
      endMs: (index + 1) * 1_000,
      speakerId: `speaker-${index % 6}`,
      startMs: index * 1_000,
      text: `Caption ${index}: ${"full source text ".repeat(24)}`,
      turnId: `internal-turn-${index}`,
    }));

    await adapter.publish({
      ...request,
      transcript: { ...request.transcript, turns: turns.toReversed() },
    });

    const preview = projector.inputs[0]?.liveCaptionsMarkdown ?? "";
    const attachment = projector.inputs[0]?.transcriptAttachment;
    const attachmentContent = attachment?.content ?? "";
    expect(preview.length).toBeLessThanOrEqual(1_900);
    expect(preview).not.toContain("captions did not fit.");
    expect(preview).toContain("available in the attached full transcript.");
    expect(attachment?.filename).toBe("meeting-transcript.md");
    expect(attachmentContent).toContain("Caption 0:");
    expect(attachmentContent).toContain("Caption 44:");
    expect(attachmentContent).toContain("full source text ".repeat(24).trim());
    expect(attachmentContent.indexOf("Caption 0:")).toBeLessThan(
      attachmentContent.indexOf("Caption 44:"),
    );
    expect(attachmentContent).not.toContain("internal-turn-");

    const payload = toDiscordMessagePayload({
      markdown: "# Meeting summary",
      transcriptAttachment: attachment!,
    });
    const file = payload.files?.[0];
    expect(file).toMatchObject({ name: "meeting-transcript.md" });
    if (typeof file !== "object" || !("attachment" in file)) {
      throw new Error("expected a Discord attachment payload");
    }
    const payloadAttachment = file as { readonly attachment: Buffer };
    expect(Buffer.isBuffer(payloadAttachment.attachment)).toBe(true);
    expect(payloadAttachment.attachment.toString("utf8")).toBe(attachmentContent);
  });

  it("rejects an attachment above the conservative Discord upload limit without truncating it", () => {
    expect(discordProjectionBodySchema.safeParse({
      markdown: "# Meeting summary",
      transcriptAttachment: {
        content: "a".repeat(DISCORD_TRANSCRIPT_ATTACHMENT_MAX_BYTES + 1),
        filename: "meeting-transcript.md",
      },
    }).success).toBe(false);
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

    expect(projector.inputs[0]?.markdown).toContain("Решения не зафиксированы.");
    expect(projector.inputs[0]?.markdown).toContain("Задачи не зафиксированы.");
    expect(projector.inputs[0]?.markdown).toContain("Ключевые темы не выделены.");
    expect(projector.inputs[0]?.markdown).toContain("Открытые вопросы не зафиксированы.");
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
    expect(projector.inputs[0]?.markdown).not.toContain("summary-42");
  });

  it("keeps a Unicode thread title within Discord's code-unit limit", async () => {
    const projector = new FakeProjector();
    const adapter = new DiscordSummaryPublicationAdapter(projector);

    await adapter.publish({
      ...request,
      summary: { ...request.summary, title: "🧑‍🚀".repeat(80) },
    });

    const title = projector.inputs[0]?.threadTitle ?? "";
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title).not.toMatch(/[\uD800-\uDBFF]$/u);
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
