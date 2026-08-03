import { describe, expect, it } from "vitest";

import {
  isMessageInsideLiveCaptureWindow,
  liveDiscordProjectionFingerprint,
  normalizeLiveDiscordProjection,
} from "../src/live-discord-observer.js";

const firstObservedAt = Date.UTC(2026, 7, 2, 12, 0, 8);
const messageCreatedAt = Date.UTC(2026, 7, 2, 12, 0, 3);
const messageEditedAt = Date.UTC(2026, 7, 2, 12, 0, 7);

describe("live Discord projection normalization", () => {
  it("retains only the human-visible projection in a stable non-secret form", () => {
    const projection = normalizeLiveDiscordProjection({
      message: {
        authorId: "1533224474609057793",
        content: "  Предварительное\r\nсаммари Cafe\u0301  ",
        createdAtMilliseconds: messageCreatedAt,
        editedAtMilliseconds: messageEditedAt,
        embeds: [{
          description: "  Обсуждаем\rпубликацию  ",
          fields: [{
            inline: undefined,
            name: "  [00:05]\r\nАнна ",
            value: "  Проверить Redis  ",
          }],
          title: "  Сейчас говорят ",
        }],
        id: "33333333333333333",
      },
      observedAtMilliseconds: firstObservedAt,
      resultChannelId: "11111111111111111",
      container: {
        kind: "thread",
        id: "44444444444444444",
        name: " Итоги live ",
        parentId: "11111111111111111",
      },
    });

    expect(projection).toEqual({
      channel: { id: "11111111111111111" },
      message: {
        authorId: "1533224474609057793",
        content: "Предварительное\nсаммари Café",
        createdAt: "2026-08-02T12:00:03.000Z",
        editedAt: "2026-08-02T12:00:07.000Z",
        embeds: [{
          description: "Обсуждаем\nпубликацию",
          fields: [{ inline: false, name: "[00:05]\nАнна", value: "Проверить Redis" }],
          title: "Сейчас говорят",
        }],
        id: "33333333333333333",
      },
      observedAt: "2026-08-02T12:00:08.000Z",
      container: {
        kind: "thread",
        id: "44444444444444444",
        name: "Итоги live",
        parentId: "11111111111111111",
      },
    });
  });

  it("uses visible projection content, not observation or edit metadata, for mutation identity", () => {
    const original = normalizeLiveDiscordProjection({
      message: message("Первая версия", messageEditedAt),
      observedAtMilliseconds: firstObservedAt,
      resultChannelId: "11111111111111111",
      container: thread,
    });
    const sameProjectionLater = normalizeLiveDiscordProjection({
      message: message("Первая версия", messageEditedAt + 1_000),
      observedAtMilliseconds: firstObservedAt + 2_000,
      resultChannelId: "11111111111111111",
      container: thread,
    });
    const editedProjection = normalizeLiveDiscordProjection({
      message: message("Вторая версия", messageEditedAt + 2_000),
      observedAtMilliseconds: firstObservedAt + 4_000,
      resultChannelId: "11111111111111111",
      container: thread,
    });

    expect(liveDiscordProjectionFingerprint(sameProjectionLater))
      .toBe(liveDiscordProjectionFingerprint(original));
    expect(liveDiscordProjectionFingerprint(editedProjection))
      .not.toBe(liveDiscordProjectionFingerprint(original));
  });

  it("accepts an embed-only Discord projection", () => {
    const projection = normalizeLiveDiscordProjection({
      message: {
        ...message("", null),
        embeds: [{
          description: "Live-субтитры",
          fields: [],
          title: "Встреча идёт",
        }],
      },
      observedAtMilliseconds: firstObservedAt,
      resultChannelId: "11111111111111111",
      container: thread,
    });

    expect(projection.message.content).toBe("");
    expect(projection.message.embeds).toHaveLength(1);
  });

  it("admits only the SUT's messages created within the bounded observation window", () => {
    const candidate = message("Обновление", null);

    expect(isMessageInsideLiveCaptureWindow(
      candidate,
      "1533224474609057793",
      messageCreatedAt,
      messageCreatedAt + 10_000,
    )).toBe(true);
    expect(isMessageInsideLiveCaptureWindow(
      { ...candidate, authorId: "different-bot" },
      "1533224474609057793",
      messageCreatedAt,
      messageCreatedAt + 10_000,
    )).toBe(false);
    expect(isMessageInsideLiveCaptureWindow(
      { ...candidate, createdAtMilliseconds: messageCreatedAt - 1 },
      "1533224474609057793",
      messageCreatedAt,
      messageCreatedAt + 10_000,
    )).toBe(false);
  });

  it("keeps a direct result-channel message distinct from a thread projection", () => {
    const projection = normalizeLiveDiscordProjection({
      message: message("Прямое обновление", null),
      observedAtMilliseconds: firstObservedAt,
      resultChannelId: "11111111111111111",
      container: { kind: "channel-message", parentChannelId: "11111111111111111" },
    });

    expect(projection.container).toEqual({
      kind: "channel-message",
      parentChannelId: "11111111111111111",
    });
  });
});

const thread = {
  kind: "thread",
  id: "44444444444444444",
  name: "Итоги live",
  parentId: "11111111111111111",
} as const;

function message(content: string, editedAtMilliseconds: number | null) {
  return {
    authorId: "1533224474609057793",
    content,
    createdAtMilliseconds: messageCreatedAt,
    editedAtMilliseconds,
    embeds: [],
    id: "33333333333333333",
  };
}
