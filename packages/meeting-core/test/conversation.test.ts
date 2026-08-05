import { describe, expect, it } from "vitest";

import {
  CONVERSATION_ALIAS_ONLY_FALLBACK_PROMPT,
  CONVERSATION_QUEUE_TTL_MS,
  ConversationSession,
  detectAddressedConversation,
  shouldUseConversationDeliberationCue,
  type ConversationTurnInput,
} from "../src/domain/conversation.js";

function turn(turnId: string): ConversationTurnInput {
  return {
    meetingId: "meeting-1",
    prompt: `question-${turnId}`,
    speakerId: `speaker-${turnId}`,
    turnId,
  };
}

function activeSession(): ConversationSession {
  const session = new ConversationSession("meeting-1");
  expect(session.admit(turn("turn-1"), 0)).toMatchObject({ status: "active" });
  return session;
}

describe("addressed conversation policy", () => {
  it.each([
    ["Botic, answer in English.", "Botic", "answer in English."],
    ["bOtIk: answer in English.", "Botik", "answer in English."],
    ["Ботик, ответь по-русски.", "Ботик", "ответь по-русски."],
    ["(БОТИКА) ответь по-русски.", "Ботика", "ответь по-русски."],
    ["Ｂｏｔｉｃ, normalised Unicode works.", "Botic", "normalised Unicode works."],
    ["Ботек, ответь кратко.", "Ботик", "ответь кратко."],
    ["Ботэк, ответь кратко.", "Ботик", "ответь кратко."],
    ["Ботека, ответь кратко.", "Ботика", "ответь кратко."],
    ["Ботэка, ответь кратко.", "Ботика", "ответь кратко."],
    ["botek, answer briefly.", "Botik", "answer briefly."],
    ["botick, answer briefly.", "Botik", "answer briefly."],
    ["botica, answer briefly.", "Ботика", "answer briefly."],
    ["botika, answer briefly.", "Ботика", "answer briefly."],
    ["botyk, answer briefly.", "Botik", "answer briefly."],
    ["Ботык, ответь кратко.", "Ботик", "ответь кратко."],
    ["Ботыка, ответь кратко.", "Ботика", "ответь кратко."],
  ])("recognises normalized whole-word alias %s", (text, alias, prompt) => {
    expect(detectAddressedConversation(text)).toEqual({
      alias,
      prompt,
      usedFallbackPrompt: false,
    });
  });

  it("uses a fallback prompt for an alias-only turn", () => {
    expect(detectAddressedConversation("... Ботик?!")).toEqual({
      alias: "Ботик",
      prompt: CONVERSATION_ALIAS_ONLY_FALLBACK_PROMPT,
      usedFallbackPrompt: true,
    });
  });

  it.each([
    ["Ботик, который час?", "который час?"],
    ["Скажи, Ботик, который час?", "Скажи который час?"],
    ["Ты здесь? Скажи, Ботик, ответь.", "Ты здесь? Скажи ответь."],
    ["Как дела, Ботик?", "Как дела?"],
    ["Как дела, Ботик", "Как дела"],
  ])("recognises an explicit start, middle, or end address: %s", (text, prompt) => {
    expect(detectAddressedConversation(text)).toMatchObject({
      alias: "Ботик",
      prompt,
      usedFallbackPrompt: false,
    });
  });

  it.each([
    "ботиками, ответь",
    "ботиков, ответь",
    "бот, ответь",
    "robotik, answer",
    "superbotik, answer",
    "Вчера Ботик отвечал странно",
    "Я вчера видел Ботик.",
    "Как дела Ботик?",
    "Я спросил про Ботик?",
  ])(
    "rejects non-whole-word form %s",
    (text) => {
      expect(detectAddressedConversation(text)).toBeNull();
    },
  );

  it.each([
    "Как дела?",
    "Который час?",
    "Сколько будет два плюс два?",
    "Tell me a joke.",
  ])("keeps a simple prompt on the neutral acknowledgement only: %s", (prompt) => {
    expect(shouldUseConversationDeliberationCue(prompt)).toBe(false);
  });

  it.each([
    "Почему для этой задачи лучше использовать порт, а не прямой вызов адаптера?",
    "Сравни варианты архитектуры и объясни компромиссы.",
    "Why is this design more reliable than the alternative?",
    "Please compare these implementations and explain the trade-offs.",
    "Расскажи подробно про достаточно длинный запрос состоящий из шестнадцати отдельных слов чтобы задержка звучала естественно для слушателя сейчас.",
  ])("allows a deliberation cue for a reasoning prompt: %s", (prompt) => {
    expect(shouldUseConversationDeliberationCue(prompt)).toBe(true);
  });
});

describe("conversation admission", () => {
  it("keeps one active turn, queues the next finalized turn, and reuses duplicates", () => {
    const session = activeSession();

    expect(session.admit(turn("turn-2"), 1)).toEqual({
      expiresAtMs: 1 + CONVERSATION_QUEUE_TTL_MS,
      status: "queued",
      turn: turn("turn-2"),
    });
    expect(session.admit(turn("turn-3"), 2)).toEqual({ status: "busy", turnId: "turn-3" });
    expect(session.admit(turn("turn-1"), 3)).toEqual({
      disposition: "active",
      status: "reused",
      turnId: "turn-1",
    });
    expect(session.admit(turn("turn-2"), 4)).toEqual({
      disposition: "queued",
      status: "reused",
      turnId: "turn-2",
    });
    expect(session.admit(turn("turn-3"), 5)).toEqual({
      disposition: "busy",
      status: "reused",
      turnId: "turn-3",
    });

    expect(session.completeActive("turn-1", 6)).toEqual({
      next: turn("turn-2"),
      status: "completed",
      turn: turn("turn-1"),
    });
  });

  it("expires the queued turn exactly at its 15-second deadline", () => {
    const session = activeSession();
    expect(session.admit(turn("turn-2"), 0)).toMatchObject({
      expiresAtMs: CONVERSATION_QUEUE_TTL_MS,
      status: "queued",
    });

    expect(session.advance(CONVERSATION_QUEUE_TTL_MS - 1)).toBeNull();
    expect(session.advance(CONVERSATION_QUEUE_TTL_MS)).toEqual(turn("turn-2"));
    expect(session.admit(turn("turn-2"), CONVERSATION_QUEUE_TTL_MS)).toEqual({
      disposition: "expired",
      status: "reused",
      turnId: "turn-2",
    });
    expect(session.completeActive("turn-1", CONVERSATION_QUEUE_TTL_MS)).toEqual({
      next: null,
      status: "completed",
      turn: turn("turn-1"),
    });
  });
});

describe("interruption guard", () => {
  it("lets participants interrupt a thinking cue immediately without starting the answer guard", () => {
    const session = activeSession();

    expect(session.thinkingCueStarted("turn-1", 100)).toBe(true);
    expect(session.speechStarted(101)).toEqual({
      reason: "barge-in",
      status: "requested",
      turn: turn("turn-1"),
    });
  });

  it("starts the four-second guard only when the real answer playback begins", () => {
    const session = activeSession();

    expect(session.thinkingCueStarted("turn-1", 100)).toBe(true);
    expect(session.playbackStarted("turn-1", 500)).toBe(true);
    expect(session.speechStarted(501)).toEqual({ status: "ignored" });
    expect(session.speechActivity(4_499)).toEqual({ status: "ignored" });
    expect(session.speechActivity(4_500)).toMatchObject({
      reason: "barge-in",
      status: "requested",
    });
  });

  it("does not cancel speech fully contained within the four-second guard", () => {
    const session = activeSession();
    expect(session.playbackStarted("turn-1", 0)).toBe(true);

    expect(session.speechStarted(100)).toEqual({ status: "ignored" });
    expect(session.speechEnded(3_999)).toEqual({ status: "ignored" });
    expect(session.completeActive("turn-1", 4_000)).toMatchObject({ status: "completed" });
  });

  it("cancels speech that continues across the four-second boundary", () => {
    const session = activeSession();
    session.playbackStarted("turn-1", 0);

    expect(session.speechStarted(3_999)).toEqual({ status: "ignored" });
    expect(session.speechActivity(4_000)).toEqual({
      reason: "barge-in",
      status: "requested",
      turn: turn("turn-1"),
    });
  });

  it("uses event time when an earlier speech observation is processed later", () => {
    const session = activeSession();
    session.playbackStarted("turn-1", 100);
    session.advance(5_000);

    expect(session.speechStarted(4_099, 5_000)).toEqual({ status: "ignored" });
    expect(session.speechEnded(4_099, 5_000)).toEqual({ status: "ignored" });
    expect(session.speechStarted(4_100, 5_000)).toMatchObject({
      reason: "barge-in",
      status: "requested",
    });
  });

  it.each([4_000, 4_001])("cancels new speech starting at %ims", (nowMs) => {
    const session = activeSession();
    session.playbackStarted("turn-1", 0);

    expect(session.speechStarted(nowMs)).toMatchObject({
      reason: "barge-in",
      status: "requested",
    });
  });

  it("ignores speech observed before playback starts", () => {
    const session = activeSession();

    expect(session.speechStarted(20)).toEqual({ status: "ignored" });
    session.playbackStarted("turn-1", 100);
    expect(session.speechActivity(4_099)).toEqual({ status: "ignored" });
  });

  it("settles a finish/cancel race exactly once and promotes the queued turn", () => {
    const session = activeSession();
    session.playbackStarted("turn-1", 0);
    session.admit(turn("turn-2"), 1);

    expect(session.speechStarted(4_000)).toMatchObject({ status: "requested" });
    expect(session.completeActive("turn-1", 4_000)).toEqual({
      next: turn("turn-2"),
      status: "cancelled",
      turn: turn("turn-1"),
    });
    expect(session.completeActive("turn-1", 4_000)).toEqual({
      next: null,
      status: "ignored",
    });
    expect(session.cancelActive("turn-1", "barge-in", 4_000)).toEqual({
      status: "ignored",
    });
  });

  it("does not emit a late cancellation after a turn already finished", () => {
    const session = activeSession();
    session.playbackStarted("turn-1", 0);

    expect(session.completeActive("turn-1", 4_000)).toMatchObject({ status: "completed" });
    expect(session.cancelActive("turn-1", "barge-in", 4_000)).toEqual({
      status: "ignored",
    });
  });

  it("closes active and queued work without promoting the queued turn", () => {
    const session = activeSession();
    session.admit(turn("turn-2"), 1);

    expect(session.close("meeting-ended", 2)).toMatchObject({
      reason: "meeting-ended",
      status: "requested",
      turn: turn("turn-1"),
    });
    expect(session.completeActive("turn-1", 2)).toEqual({
      next: null,
      status: "cancelled",
      turn: turn("turn-1"),
    });
    expect(session.admit(turn("turn-2"), 3)).toEqual({
      disposition: "cancelled",
      status: "reused",
      turnId: "turn-2",
    });
  });
});
