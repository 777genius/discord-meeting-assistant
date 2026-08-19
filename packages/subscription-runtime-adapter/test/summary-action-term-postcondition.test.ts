import { describe, expect, it } from "vitest";

import { findPotentiallyTruncatedActionTerms } from "../src/index.js";

const vocabulary = [
  "Quanta",
  "Quanta ID",
  "Quanta Pages",
  "Redis",
  "Redis queue",
] as const;

describe("findPotentiallyTruncatedActionTerms", () => {
  it("finds Redis queue in contiguous owner context anchored after the full term", () => {
    expect(findPotentiallyTruncatedActionTerms(
      [{
        deadline: "до завтра",
        evidenceTurnIds: ["turn-redis", "turn-deadline"],
        ownerSpeakerId: "owner",
        text: "Проверить Redis и idempotency key",
      }],
      [
        turn("turn-queue", "owner", "Сначала проверю Redis queue.", 0),
        ...Array.from({ length: 12 }, (_, index) =>
          turn(`turn-fragment-${index}`, "owner", `Фрагмент ${index}.`, index + 1),
        ),
        turn("turn-redis", "owner", "Потом проверю Redis.", 13),
        turn("turn-deadline", "owner", "Сделаю до завтра.", 14),
      ],
      vocabulary,
    )).toEqual(["Redis queue"]);
  });

  it("normalizes NFKC and case before matching terms", () => {
    expect(findPotentiallyTruncatedActionTerms(
      [{
        deadline: null,
        evidenceTurnIds: ["turn-anchor"],
        ownerSpeakerId: "owner",
        text: "Проверить REDIS",
      }],
      [
        turn("turn-queue", "owner", "Проверю Ｒｅｄｉｓ queue.", 0),
        turn("turn-anchor", "owner", "Проверю REDIS.", 1),
      ],
      vocabulary,
    )).toEqual(["Redis queue"]);
  });

  it("does not match a vocabulary prefix inside a larger word", () => {
    expect(findPotentiallyTruncatedActionTerms(
      [{
        deadline: null,
        evidenceTurnIds: ["turn-anchor"],
        ownerSpeakerId: "owner",
        text: "Проверить Redistribution",
      }],
      [
        turn("turn-queue", "owner", "Проверю Redis queue.", 0),
        turn("turn-anchor", "owner", "Проверю Redistribution.", 1),
      ],
      vocabulary,
    )).toEqual([]);
  });

  it("does not use uncited speaker sections or another owner", () => {
    expect(findPotentiallyTruncatedActionTerms(
      [{
        deadline: null,
        evidenceTurnIds: ["turn-anchor"],
        ownerSpeakerId: "owner",
        text: "Проверить Redis",
      }],
      [
        turn("turn-queue", "other", "Проверить Redis queue.", 0),
        turn("turn-anchor", "owner", "Я проверю Redis.", 1),
        turn("turn-break", "other", "Хорошо.", 2),
        turn("turn-owner-later", "owner", "Redis queue важна.", 3),
      ],
      vocabulary,
    )).toEqual([]);
  });

  it("does not guess between Quanta ID and Quanta Pages", () => {
    expect(findPotentiallyTruncatedActionTerms(
      [{
        deadline: null,
        evidenceTurnIds: ["turn-quanta"],
        ownerSpeakerId: "owner",
        text: "Проверить Quanta",
      }],
      [
        turn("turn-products", "owner", "Проверю Quanta ID и Quanta Pages.", 0),
        turn("turn-quanta", "owner", "Затем проверю Quanta.", 1),
      ],
      vocabulary,
    )).toEqual([]);
  });

  it("accepts an action that already preserves the compound term", () => {
    expect(findPotentiallyTruncatedActionTerms(
      [{
        deadline: null,
        evidenceTurnIds: ["turn-queue"],
        ownerSpeakerId: "owner",
        text: "Проверить Redis queue",
      }],
      [turn("turn-queue", "owner", "Проверю Redis queue.", 0)],
      vocabulary,
    )).toEqual([]);
  });
});

function turn(turnId: string, speakerId: string, text: string, startMs: number) {
  return { endMs: startMs + 1, speakerId, startMs, text, turnId };
}
