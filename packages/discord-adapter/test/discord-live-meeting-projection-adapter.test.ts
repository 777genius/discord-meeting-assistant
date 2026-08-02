import type { LiveMeetingProjectionRequest } from "@discord-meeting/meeting-core";
import { describe, expect, it } from "vitest";

import {
  createMeetingDiscordProjectionKey,
  discordProjectionBodySchema,
  DiscordLiveMeetingProjectionAdapter,
  renderRussianLiveCaptionsMarkdown,
  renderRussianLiveSummaryMarkdown,
  toDiscordMessagePayload,
  type DiscordProjectionReference,
  type PublishDiscordSummary,
} from "../src/index.js";

const request: LiveMeetingProjectionRequest = {
  captions: [
    {
      endMs: 8_100,
      isFinal: false,
      speakerId: "1533228054724346087",
      startMs: 5_200,
      text: "Проверю Discord thread и Redis queue.",
    },
    {
      endMs: 11_400,
      isFinal: true,
      speakerId: "participant-b",
      startMs: 8_300,
      text: "Подготовлю дашборд к четвергу.",
    },
  ],
  currentExternalPublicationId: "discord:v1:thread:22222222222222222:message:33333333333333333",
  elapsedMs: 300_000,
  idempotencyKey: "meeting-live-projection:v1|meeting-42",
  meetingId: "meeting-42",
  publicationTargetId: "11111111111111111",
  revision: 4,
  status: "active",
  summary: {
    actionItems: [{
      actionItemId: "action-1",
      deadline: "к четвергу",
      evidenceTurnIds: ["turn-2"],
      ownerSpeakerId: "1533228054724346087",
      text: "Подготовить дашборд",
    }],
    decisions: [{
      decisionId: "decision-1",
      evidenceTurnIds: ["turn-1"],
      text: "Выпустить версию в пятницу",
    }],
    openQuestions: [{
      evidenceTurnIds: ["turn-2"],
      id: "question-1",
      text: "Нужен ли Live Pipecat Assistant после V1?",
    }],
    overview: "Команда согласовала план релиза и проверку очереди.",
    revision: 1,
    title: "Встреча по релизу",
    topics: [{
      evidenceTurnIds: ["turn-1"],
      points: ["Релиз планируется в пятницу"],
      title: "Подготовка релиза",
    }],
  },
  updatedAtMs: 1_760_000_000_000,
};

class FakeLiveProjector {
  readonly inputs: PublishDiscordSummary[] = [];

  async publish(input: PublishDiscordSummary): Promise<DiscordProjectionReference> {
    this.inputs.push(input);
    return { threadId: "22222222222222222", messageId: "33333333333333333" };
  }
}

describe("DiscordLiveMeetingProjectionAdapter", () => {
  it("maps a live core projection into the same stable Discord projection as the final summary", async () => {
    const projector = new FakeLiveProjector();
    const adapter = new DiscordLiveMeetingProjectionAdapter(projector);

    const result = await adapter.publish(request);

    expect(result).toEqual({
      ok: true,
      value: {
        externalPublicationId:
          "discord:v1:thread:22222222222222222:message:33333333333333333",
      },
    });
    expect(projector.inputs).toHaveLength(1);
    expect(projector.inputs[0]).toMatchObject({
      projectionKey: createMeetingDiscordProjectionKey("meeting-42", "11111111111111111"),
      legacyProjectionKeys: ["meeting-live-projection:v1|meeting-42"],
      currentReference: {
        threadId: "22222222222222222",
        messageId: "33333333333333333",
      },
    });
    expect(projector.inputs[0]?.markdown).toContain("## Предварительное саммари");
    expect(projector.inputs[0]?.liveCaptionsMarkdown).toContain("## 🎙️ Сейчас говорят");
    expect(projector.inputs[0]?.liveCaptionsMarkdown).toContain("<@1533228054724346087>");
    expect(projector.inputs[0]?.liveCaptionsMarkdown).toContain("`00:05`");
  });

  it("shows a clear placeholder while a live summary is not ready", () => {
    const markdown = renderRussianLiveSummaryMarkdown({
      elapsedMs: 300_000,
      status: "active",
      summary: null,
    });

    expect(markdown).toContain("Первые выводы появятся после первых минут разговора.");
    expect(markdown).toContain("_Длительность: 05:00_");
  });

  it("bounds Unicode captions and summary descriptions without splitting surrogate pairs", () => {
    const longEmoji = "🧑‍🚀".repeat(2_000);
    const captions = renderRussianLiveCaptionsMarkdown([{
      endMs: 9_000,
      isFinal: false,
      speakerId: "1533228054724346087",
      startMs: 8_000,
      text: longEmoji,
    }]);
    const summary = renderRussianLiveSummaryMarkdown({
      ...request,
      summary: { ...request.summary!, overview: longEmoji },
    });

    expect(captions.length).toBeLessThanOrEqual(1_900);
    expect(summary.length).toBeLessThanOrEqual(4_000);
    expect(hasLoneSurrogate(captions)).toBe(false);
    expect(hasLoneSurrogate(summary)).toBe(false);
    expect(captions).toContain("🎙️ Сейчас говорят");
    expect(summary).toContain("Предварительное саммари сокращено из-за лимита Discord.");
  });

  it("enforces per-embed and aggregate limits while disabling pings for both embeds", () => {
    expect(discordProjectionBodySchema.safeParse({
      markdown: "a".repeat(4_096),
      liveCaptionsMarkdown: "b".repeat(1_905),
    }).success).toBe(false);

    const payload = toDiscordMessagePayload({
      markdown: "# Саммари",
      liveCaptionsMarkdown: "## 🎙️ Сейчас говорят\n\n<@1533228054724346087>: тест",
    });

    expect(payload.allowedMentions).toEqual({ parse: [], repliedUser: false });
    expect(payload.embeds).toHaveLength(2);
    expect(payload.embeds.every((embed) => embed.description.length <= 4_096)).toBe(true);
    expect(payload.embeds.reduce((total, embed) => total + embed.description.length, 0))
      .toBeLessThanOrEqual(6_000);
  });
});

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) {
        return true;
      }
      index += 1;
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      return true;
    }
  }
  return false;
}
