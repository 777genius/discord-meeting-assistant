import {
  createFastCheckParameters,
  normalizeDeterministicSeedBank,
} from "@agent-teams/engineering-foundation";
import { assert, constantFrom, property, tuple } from "fast-check";
import { describe, expect, it } from "vitest";

import { MeetingFarewellPolicy } from "@discord-meeting/meeting-core/conversation";

const quotedFarewellSeedBank = normalizeDeterministicSeedBank({
  numRuns: 100,
  propertyId: "meeting.farewell-quoted-span-never-direct-intent",
  schemaVersion: 1,
  seeds: [-1_417_090_813, 729_441_107],
});

function observe(
  policy: MeetingFarewellPolicy,
  text: string,
  overrides: Partial<Parameters<MeetingFarewellPolicy["observe"]>[0]> = {},
) {
  return policy.observe({
    endMs: 1_000,
    presentParticipantCount: 3,
    speakerId: "speaker-1",
    text,
    turnId: `turn-${text}`,
    ...overrides,
  });
}

describe("MeetingFarewellPolicy fast path", () => {
  it.each([
    ["Всем пока!", "ru"],
    ["Спасибо всем, до встречи завтра", "ru"],
    ["Давайте на этом закончим встречу.", "ru"],
    ["Bye everyone!", "en"],
    ["Thanks everyone, see you tomorrow", "en"],
    ["Let's wrap the meeting here", "en"],
    ["Let's end the call", "en"],
    ["Good night everyone!", "en"],
    ["Ну всё, до завтра всем!", "ru"],
    ["Всем хорошего вечера!", "ru"],
    ["Take care everyone!", "en"],
  ])("immediately accepts an explicit group ending: %s", (text, locale) => {
    expect(observe(new MeetingFarewellPolicy(), text)).toMatchObject({
      locale,
      reason: "explicit-group",
      status: "trigger",
    });
  });

  it("accepts the second farewell-only turn from a different speaker", () => {
    const policy = new MeetingFarewellPolicy();
    expect(observe(policy, "Пока", { turnId: "turn-1" })).toMatchObject({
      status: "review",
    });
    expect(observe(policy, "Bye", {
      endMs: 4_000,
      speakerId: "speaker-2",
      turnId: "turn-2",
    })).toEqual({
      evidenceTurnIds: ["turn-1", "turn-2"],
      locale: "en",
      reason: "farewell-consensus",
      status: "trigger",
    });
  });

  it("accepts one farewell-only turn when one participant remains", () => {
    expect(observe(new MeetingFarewellPolicy(), "До встречи", {
      presentParticipantCount: 1,
    })).toMatchObject({ reason: "last-participant", status: "trigger" });
  });

  it("allows only one reserved voice attempt", () => {
    const policy = new MeetingFarewellPolicy();
    expect(policy.reserve()).toBe(true);
    expect(policy.reserve()).toBe(false);
    expect(observe(policy, "Всем пока")).toEqual({
      reason: "already-attempted",
      status: "ignored",
    });
  });

  it("releases only the attempt fence while retaining observed-turn deduplication", () => {
    const policy = new MeetingFarewellPolicy();
    expect(observe(policy, "Всем пока", { turnId: "farewell-1" }))
      .toMatchObject({ status: "trigger" });
    expect(policy.reserve()).toBe(true);

    policy.releaseReservation();

    expect(policy.reserve()).toBe(true);
    policy.releaseReservation();
    expect(observe(policy, "Всем пока", { turnId: "farewell-1" }))
      .toEqual({ reason: "duplicate", status: "ignored" });
    expect(observe(policy, "Bye everyone", { turnId: "farewell-2" }))
      .toMatchObject({ status: "trigger" });
  });
});

describe("MeetingFarewellPolicy false-positive fence", () => {
  it.each([
    '"Bye everyone"',
    '“Bye everyone!”',
    '«Всем пока!»',
    'The slide says "Bye everyone", but we are continuing',
    'На экране написано «Всем пока!», а встреча продолжается',
    'Please repeat “Bye, Alice” slowly',
    'Повтори «Пока, Саша» медленно',
  ])("rejects quoted farewell wording before normalization: %s", (text) => {
    expect(observe(new MeetingFarewellPolicy(), text)).toEqual({
      reason: "unsafe",
      status: "ignored",
    });
  });

  it("never turns a paired quoted farewell span into direct intent", () => {
    for (const seed of quotedFarewellSeedBank.seeds) {
      assert(property(tuple(
        constantFrom(["\"", "\""], ["“", "”"], ["„", "“"], ["«", "»"]),
        constantFrom("Bye everyone!", "Goodbye, Alice", "Всем пока!", "Пока, Саша"),
        constantFrom("", "Please repeat ", "На слайде написано "),
        constantFrom("", " before continuing", ", но мы продолжаем"),
      ), ([quotes, farewell, prefix, suffix]) => {
        expect(observe(
          new MeetingFarewellPolicy(),
          `${prefix}${quotes[0]}${farewell}${quotes[1]}${suffix}`,
        )).toEqual({ reason: "unsafe", status: "ignored" });
      }), createFastCheckParameters(quotedFarewellSeedBank, seed));
    }
  });

  it.each([
    "Пока не заканчиваем, ещё вопрос",
    "Он сказал всем пока",
    "Когда закончим, попрощаемся",
    "Заканчиваем?",
    "Пока, Саша",
    "Я пошёл, всем пока, а вы продолжайте",
    "We're not wrapping up yet",
    "She said goodbye to everyone",
    "If we wrap, I'll say goodbye",
    "Should we wrap?",
    "Bye Alex",
    "I have to go, bye everyone, you continue",
    "If you are done, say bye everyone",
    "Let's wrap up this bug and continue",
    "Давайте на этом закончим эту тему и перейдём дальше",
  ])("suppresses unsafe context: %s", (text) => {
    expect(observe(new MeetingFarewellPolicy(), text)).toMatchObject({
      status: "ignored",
    });
  });

  it("sends longer unresolved wording to semantic review", () => {
    expect(observe(new MeetingFarewellPolicy(), "Ну ладно, увидимся завтра, наверное")).toMatchObject({
      status: "review",
    });
    expect(observe(new MeetingFarewellPolicy(), "Пока база грузится, продолжим обсуждение")).toMatchObject({
      status: "review",
    });
  });

  it.each([
    "На сегодня всё",
    "Давайте на этом закончим",
    "That's all for today",
    "We're done for today",
    "Let's call it a day",
  ])("uses semantic context for a generic speaker or topic ending: %s", (text) => {
    expect(observe(new MeetingFarewellPolicy(), text)).toMatchObject({
      status: "review",
    });
  });

  it("does not form consensus from the same speaker or an expired turn", () => {
    const policy = new MeetingFarewellPolicy();
    observe(policy, "Bye", { endMs: 1_000, turnId: "turn-1" });
    expect(observe(policy, "Goodbye", {
      endMs: 2_000,
      turnId: "turn-2",
    })).toMatchObject({ status: "review" });
    expect(observe(policy, "See you", {
      endMs: 7_001,
      speakerId: "speaker-2",
      turnId: "turn-3",
    })).toMatchObject({ status: "review" });
  });

  it("does not form consensus across intervening meeting speech", () => {
    const policy = new MeetingFarewellPolicy();
    observe(policy, "Bye", { endMs: 1_000, turnId: "turn-1" });
    observe(policy, "One more thing about the release", {
      endMs: 2_000,
      speakerId: "speaker-3",
      turnId: "turn-2",
    });

    expect(observe(policy, "Goodbye", {
      endMs: 3_000,
      speakerId: "speaker-2",
      turnId: "turn-3",
    })).toMatchObject({ status: "review" });
  });
});
