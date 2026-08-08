import type { SummaryPublicationRequest } from "@discord-meeting/meeting-core/publishing";
import { describe, expect, it } from "vitest";

import {
  renderRussianFullSummaryAttachmentMarkdown,
  renderRussianSummaryMarkdown,
} from "../src/index.js";

function requestWith(
  turns: SummaryPublicationRequest["transcript"]["turns"],
  topic: SummaryPublicationRequest["summary"]["topics"][number],
): SummaryPublicationRequest {
  return {
    idempotencyKey: "summary-quality-eval",
    meetingId: "meeting-quality-eval",
    publicationTargetId: "1533228891827736657",
    summary: {
      actionItems: [],
      decisions: [],
      openQuestions: [],
      overview: "Зафиксированы требования к публичным ссылкам.",
      summaryId: "summary-quality-eval",
      title: "Публичный лендинг",
      topics: [topic],
      transcriptId: "transcript-quality-eval",
      version: 1,
    },
    transcript: {
      recordingId: "recording-quality-eval",
      transcriptId: "transcript-quality-eval",
      turns,
      version: 1,
    },
  };
}

describe("Discord summary quality evals", () => {
  it("quotes the relevant part of a long source turn instead of its generic opening", () => {
    const longTurn = [
      "Сначала мы долго обсуждали общий подход, сроки, дизайн и несколько второстепенных идей, которые не относятся к принятому контракту.",
      "Ключевое требование: старые ссылки продолжают работать, реферальный параметр code передается явно, публичный Quanta ID запрещен, а landing slug остается человекочитаемым.",
      "После этого команда перешла к другой теме и обсудила оформление презентации.",
    ].join(" ");
    const markdown = renderRussianFullSummaryAttachmentMarkdown(requestWith(
      [{
        endMs: 20_000,
        speakerId: "speaker-a",
        startMs: 1_000,
        text: longTurn,
        turnId: "turn-long",
      }],
      {
        evidenceTurnIds: ["turn-long"],
        points: [
          "Старые ссылки работают; code явный; публичный Quanta ID запрещен",
          "Landing slug остается человекочитаемым",
        ],
        title: "Ключевые требования ссылок",
      },
    ));

    expect(markdown).toContain("## Ключевые темы и детали");
    expect(markdown).toContain("реферальный параметр code");
    expect(markdown).toContain("публичный Quanta ID запрещен");
    expect(markdown).not.toContain("Сначала мы долго обсуждали общий подход");
  });

  it("adds nearby proposal context when the only cited evidence is a short assent", () => {
    const markdown = renderRussianFullSummaryAttachmentMarkdown(requestWith(
      [
        {
          endMs: 8_000,
          speakerId: "speaker-a",
          startMs: 1_000,
          text: "Предлагаю оставить старые ссылки рабочими и не публиковать Quanta ID.",
          turnId: "turn-proposal",
        },
        {
          endMs: 10_000,
          speakerId: "speaker-b",
          startMs: 9_000,
          text: "Да, думаю можем.",
          turnId: "turn-assent",
        },
      ],
      {
        evidenceTurnIds: ["turn-assent"],
        points: ["Старые ссылки остаются рабочими", "Quanta ID не публикуется"],
        title: "Совместимость и приватность",
      },
    ));

    expect(markdown).toContain("Предлагаю оставить старые ссылки рабочими");
    expect(markdown).toContain("Да, думаю можем.");
    expect(markdown.indexOf("Предлагаю")).toBeLessThan(markdown.indexOf("Да, думаю"));
  });

  it("adds nearby proposal context for a Ukrainian short assent", () => {
    const markdown = renderRussianFullSummaryAttachmentMarkdown(requestWith(
      [
        {
          endMs: 8_000,
          speakerId: "speaker-a",
          startMs: 1_000,
          text: "Будь ласка, залиш старі посилання робочими.",
          turnId: "turn-proposal",
        },
        {
          endMs: 10_000,
          speakerId: "speaker-b",
          startMs: 9_000,
          text: "Добре, можемо.",
          turnId: "turn-assent",
        },
      ],
      {
        evidenceTurnIds: ["turn-assent"],
        points: ["Старі посилання залишаються робочими"],
        title: "Сумісність",
      },
    ));

    expect(markdown).toContain("Будь ласка, залиш старі посилання робочими.");
    expect(markdown).toContain("Добре, можемо.");
  });

  it("renders presentation labels in the dominant transcript language", () => {
    const russian = renderRussianSummaryMarkdown(requestWith(
      [{
        endMs: 2_000,
        speakerId: "speaker-a",
        startMs: 1_000,
        text: "Обсудили публичный лендинг и старые ссылки.",
        turnId: "turn-ru",
      }],
      {
        evidenceTurnIds: ["turn-ru"],
        points: ["Старые ссылки продолжают работать"],
        title: "Совместимость",
      },
    ));
    const english = renderRussianSummaryMarkdown({
      ...requestWith(
        [{
          endMs: 2_000,
          speakerId: "speaker-a",
          startMs: 1_000,
          text: "We discussed the public landing page and legacy links.",
          turnId: "turn-en",
        }],
        {
          evidenceTurnIds: ["turn-en"],
          points: ["Legacy links remain supported"],
          title: "Compatibility",
        },
      ),
      summary: {
        ...requestWith([], {
          evidenceTurnIds: [],
          points: [],
          title: "Compatibility",
        }).summary,
        overview: "The public landing page keeps legacy links working.",
        title: "Public landing page",
        topics: [{
          evidenceTurnIds: ["turn-en"],
          points: ["Legacy links remain supported"],
          title: "Compatibility",
        }],
      },
    });

    expect(russian).toContain("## Кратко");
    expect(russian).toContain("## Ключевые темы и детали");
    expect(english).toContain("## Overview");
    expect(english).toContain("## Key topics and details");
  });

  it("renders Ukrainian labels and missing evidence without exclusive letters", () => {
    const markdown = renderRussianFullSummaryAttachmentMarkdown(requestWith(
      [{
        endMs: 2_000,
        speakerId: "speaker-a",
        startMs: 1_000,
        text: "Будь ласка, додай код та залиш посилання.",
        turnId: "turn-uk",
      }],
      {
        evidenceTurnIds: ["turn-missing"],
        points: ["Код треба додати"],
        title: "Завдання",
      },
    ));

    expect(markdown).toContain("## Коротко");
    expect(markdown).toContain("Початкова репліка недоступна.");
    expect(markdown).not.toContain("The source utterance is unavailable.");
  });
});
