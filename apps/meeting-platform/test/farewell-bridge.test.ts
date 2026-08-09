import { describe, expect, it } from "vitest";

import type {
  LiveConversationConfiguration,
  LiveFarewellClassificationInput,
  LiveRuntimeLogger,
} from "../src/live-runtime/contracts.js";
import { FarewellBridge } from "../src/live-runtime/farewell-bridge.js";

class CoordinatorProbe {
  public readonly cueCalls: unknown[] = [];

  public advanceMeeting(): void {}
  public closeMeeting(): Promise<void> { return Promise.resolve(); }
  public handleFinalizedTurn() { return Promise.resolve({ status: "ignored" as const }); }
  public handleProactiveTurn() { return Promise.resolve({ status: "ignored" as const }); }
  public playPreparedCue(input: unknown) {
    this.cueCalls.push(structuredClone(input));
    return Promise.resolve({ status: "active" as const });
  }
  public speechActivity() { return Promise.resolve({ status: "ignored" as const }); }
  public speechEnded() { return Promise.resolve({ status: "ignored" as const }); }
  public speechStarted() { return Promise.resolve({ status: "ignored" as const }); }
  public whenIdle(): Promise<void> { return Promise.resolve(); }
}

const logger: LiveRuntimeLogger = {
  debug: () => {},
  error: () => {},
  info: () => {},
  warn: () => {},
};

function fixture(classify?: (input: LiveFarewellClassificationInput) => Promise<"en" | "reject" | "ru">) {
  let nowMs = 1_000;
  const coordinator = new CoordinatorProbe();
  const configuration: LiveConversationConfiguration = {
    coordinator,
    farewells: {
      ...(classify === undefined ? {} : { classifier: { classify } }),
      cues: {
        select: ({ locale, meetingId }) => ({
          cueId: `farewell-${locale}-v1`,
          pcmChunks: [Uint8Array.of(1, 2)],
          playbackAttemptId: `farewell-${meetingId}-${locale}`,
        }),
      },
      participantNames: {},
    },
    locale: "auto",
    nowMilliseconds: () => nowMs,
    systemPrompt: "Answer briefly.",
    voiceProfileId: "voice-profile",
  };
  const bridge = new FarewellBridge({
    configuration,
    isMeetingFinishing: () => false,
    logger,
    meetingId: "recording-1",
  });
  bridge.participantsPresent(["speaker-1", "speaker-2", "speaker-3"]);
  return {
    bridge,
    coordinator,
    setNowMs(value: number) { nowMs = value; },
  };
}

function finalEvent(text: string, speakerId = "speaker-1") {
  return {
    endMs: 900,
    isFinal: true,
    meetingId: "recording-1",
    speakerId,
    startMs: 800,
    text,
  } as const;
}

describe("FarewellBridge", () => {
  it("plays an explicit RU farewell after only the 100 ms continuation fence", async () => {
    const context = fixture();
    const event = finalEvent("Всем пока!");
    const revision = context.bridge.observeSpeech(event);
    context.bridge.observeFinalizedTurn(event, "turn-1", revision);

    context.bridge.advance();
    expect(context.coordinator.cueCalls).toEqual([]);
    context.setNowMs(1_100);
    context.bridge.advance();
    await context.bridge.settle();

    expect(context.coordinator.cueCalls).toHaveLength(1);
    expect(context.coordinator.cueCalls[0]).toMatchObject({
      cueId: "farewell-ru-v1",
      locale: "ru",
      turnId: "meeting-farewell:v1",
    });
  });

  it("cancels a fast-path decision when any newer speech arrives", async () => {
    const context = fixture();
    const farewell = finalEvent("Bye everyone!");
    const revision = context.bridge.observeSpeech(farewell);
    context.bridge.observeFinalizedTurn(farewell, "turn-1", revision);
    context.bridge.observeSpeech({ ...finalEvent("Actually, one more thing"), isFinal: false });
    context.setNowMs(1_200);
    context.bridge.advance();
    await context.bridge.settle();

    expect(context.coordinator.cueCalls).toEqual([]);
  });

  it("keeps an accepted farewell when the speaker leaves immediately", async () => {
    const context = fixture();
    const farewell = finalEvent("Bye everyone!");
    const revision = context.bridge.observeSpeech(farewell);
    context.bridge.observeFinalizedTurn(farewell, "turn-1", revision);
    context.bridge.participantLeft("speaker-1");
    context.setNowMs(1_100);
    context.bridge.advance();
    await context.bridge.settle();

    expect(context.coordinator.cueCalls).toHaveLength(1);
  });

  it("uses two different farewell-only speakers as an immediate consensus", async () => {
    const context = fixture();
    const first = finalEvent("Пока", "speaker-1");
    context.bridge.observeFinalizedTurn(
      first,
      "turn-1",
      context.bridge.observeSpeech(first),
    );
    const second = { ...finalEvent("Bye", "speaker-2"), endMs: 1_100 };
    context.bridge.observeFinalizedTurn(
      second,
      "turn-2",
      context.bridge.observeSpeech(second),
    );
    context.setNowMs(1_100);
    context.bridge.advance();
    context.setNowMs(1_200);
    context.bridge.advance();
    await context.bridge.settle();

    expect(context.coordinator.cueCalls).toHaveLength(1);
    expect(context.coordinator.cueCalls[0]).toMatchObject({ locale: "en" });
  });

  it("accepts a semantic result only while its speech revision is current", async () => {
    let release!: (value: "ru") => void;
    const classified = new Promise<"ru">((resolve) => { release = resolve; });
    const requests: LiveFarewellClassificationInput[] = [];
    const context = fixture((input) => {
      requests.push(input);
      return classified;
    });
    const ambiguous = finalEvent("Пока база грузится, продолжим");
    context.bridge.observeFinalizedTurn(
      ambiguous,
      "turn-1",
      context.bridge.observeSpeech(ambiguous),
    );
    expect(requests).toHaveLength(1);
    context.bridge.observeSpeech({ ...finalEvent("ещё вопрос"), isFinal: false });
    release("ru");
    await context.bridge.settle();

    expect(context.coordinator.cueCalls).toEqual([]);
    expect(requests[0]?.turns.map(({ turnId }) => turnId)).toEqual(["turn-1"]);
  });
});
