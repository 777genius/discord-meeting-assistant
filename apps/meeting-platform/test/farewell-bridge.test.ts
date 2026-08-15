import { describe, expect, it } from "vitest";

import type {
  LiveConversationConfiguration,
  LiveConversationOneShotReceiptPort,
  LiveFarewellClassificationInput,
  LiveRuntimeLogger,
} from "../src/live-runtime/contracts.js";
import { FarewellBridge } from "../src/live-runtime/farewell-bridge.js";

class CoordinatorProbe {
  public readonly cueCalls: unknown[] = [];
  public playError: Error | undefined;
  public playOutcome:
    | "active"
    | "awaiting-prompt"
    | "busy"
    | "ignored"
    | "queued"
    | "reused" = "active";
  public reusedDisposition:
    | "active"
    | "busy"
    | "cancelled"
    | "cancelling"
    | "completed"
    | "expired"
    | "queued" = "active";
  public settlementError: Error | undefined;
  public playbackSettlement: "played" | "unplayed" | "partial" | "unknown" = "played";

  public advanceMeeting(): void {}
  public closeMeeting(): Promise<void> { return Promise.resolve(); }
  public disconnectMeeting(): Promise<void> { return Promise.resolve(); }
  public handleFinalizedTurn() { return Promise.resolve({ status: "ignored" as const }); }
  public handleProactiveTurn() { return Promise.resolve({ status: "ignored" as const }); }
  public playPreparedCue(input: unknown) {
    this.cueCalls.push(structuredClone(input));
    if (this.playError !== undefined) {
      return Promise.reject(this.playError);
    }
    return Promise.resolve(this.playOutcome === "reused"
      ? { disposition: this.reusedDisposition, status: "reused" as const }
      : { status: this.playOutcome });
  }
  public speechActivity() { return Promise.resolve({ status: "ignored" as const }); }
  public speechEnded() { return Promise.resolve({ status: "ignored" as const }); }
  public speechStarted() { return Promise.resolve({ status: "ignored" as const }); }
  public whenIdle(): Promise<void> { return Promise.resolve(); }
  public whenTurnPlaybackSettled() {
    return this.settlementError === undefined
      ? Promise.resolve(this.playbackSettlement)
      : Promise.reject(this.settlementError);
  }
}

const logger: LiveRuntimeLogger = {
  debug: () => {},
  error: () => {},
  info: () => {},
  warn: () => {},
};

function fixture(
  classify?: (input: LiveFarewellClassificationInput) => Promise<"en" | "reject" | "ru">,
  runtimeLogger: LiveRuntimeLogger = logger,
  oneShotReceipts?: LiveConversationOneShotReceiptPort,
) {
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
    ...(oneShotReceipts === undefined ? {} : { oneShotReceipts }),
    systemPrompt: "Answer briefly.",
    voiceProfileId: "voice-profile",
  };
  const bridge = new FarewellBridge({
    configuration,
    isMeetingFinishing: () => false,
    logger: runtimeLogger,
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

describe("FarewellBridge quote safety", () => {
  it.each([
    '"Bye everyone"',
    '“Bye everyone!”',
    '«Всем пока!»',
    'The transcript quotes "Bye everyone" while the meeting continues',
    'Текст «Всем пока!» показан на слайде',
    'Please repeat “Bye, Alice”',
    'Повтори «Пока, Саша»',
  ])("never forwards quoted farewell wording to classification or playback: %s", async (text) => {
    const classifierCalls: LiveFarewellClassificationInput[] = [];
    const context = fixture((input) => {
      classifierCalls.push(input);
      return Promise.resolve("en");
    });

    await triggerFarewell(context, text, `turn-${text}`, 1_100);

    expect(classifierCalls).toEqual([]);
    expect(context.coordinator.cueCalls).toEqual([]);
  });
});

describe("FarewellBridge", () => {
  it("suppresses farewell replay after restart from a completed durable receipt", async () => {
    const receipts = new FarewellReceiptMemory();
    const first = fixture(undefined, logger, receipts);
    const event = finalEvent("Всем пока!");
    const revision = first.bridge.observeSpeech(event);
    first.bridge.observeFinalizedTurn(event, "turn-1", revision);
    first.setNowMs(1_100);
    first.bridge.advance();
    await first.bridge.settle();
    expect(first.coordinator.cueCalls).toHaveLength(1);

    const restarted = fixture(undefined, logger, receipts);
    const replayRevision = restarted.bridge.observeSpeech(event);
    restarted.bridge.observeFinalizedTurn(event, "turn-2", replayRevision);
    restarted.setNowMs(1_100);
    restarted.bridge.advance();
    await restarted.bridge.settle();

    expect(restarted.coordinator.cueCalls).toEqual([]);
  });

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

  it("releases durable and in-memory fences after a pre-admission exception", async () => {
    const receipts = new FarewellReceiptMemory();
    const context = fixture(undefined, logger, receipts);
    context.coordinator.playError = new Error("synthetic admission failure");
    await triggerFarewell(context, "Всем пока!", "turn-1", 1_100);

    expect(receipts.releaseCount).toBe(1);
    expect(receipts.completeCount).toBe(0);

    context.coordinator.playError = undefined;
    await triggerFarewell(context, "Bye everyone!", "turn-2", 1_300);

    expect(context.coordinator.cueCalls).toHaveLength(2);
    expect(context.coordinator.cueCalls).toEqual([
      expect.objectContaining({ turnId: "meeting-farewell:v1" }),
      expect.objectContaining({ turnId: "meeting-farewell:v1" }),
    ]);
    expect(receipts.reserveCount).toBe(2);
    expect(receipts.releaseCount).toBe(1);
    expect(receipts.completeCount).toBe(1);
  });

  it("reconciles a lost admission response with the same playback identity", async () => {
    const receipts = new FarewellReceiptMemory();
    const context = fixture(undefined, logger, receipts);
    context.coordinator.playError = new Error("synthetic lost admission response");
    await triggerFarewell(context, "Всем пока!", "turn-1", 1_100);

    context.coordinator.playError = undefined;
    context.coordinator.playOutcome = "reused";
    context.coordinator.reusedDisposition = "active";
    await triggerFarewell(context, "Bye everyone!", "turn-2", 1_300);

    expect(context.coordinator.cueCalls).toEqual([
      expect.objectContaining({ turnId: "meeting-farewell:v1" }),
      expect.objectContaining({ turnId: "meeting-farewell:v1" }),
    ]);
    expect(receipts.releaseCount).toBe(1);
    expect(receipts.completeCount).toBe(1);
  });

  it.each(["awaiting-prompt", "busy", "ignored"] as const)(
    "releases a %s non-admission and uses a fresh retry identity",
    async (outcome) => {
      const receipts = new FarewellReceiptMemory();
      const context = fixture(undefined, logger, receipts);
      context.coordinator.playOutcome = outcome;
      await triggerFarewell(context, "Всем пока!", "turn-1", 1_100);

      context.coordinator.playOutcome = "active";
      await triggerFarewell(context, "Bye everyone!", "turn-2", 1_300);

      expect(context.coordinator.cueCalls).toEqual([
        expect.objectContaining({ turnId: "meeting-farewell:v1" }),
        expect.objectContaining({ turnId: "meeting-farewell:v1:retry-1" }),
      ]);
      expect(receipts.reserveCount).toBe(2);
      expect(receipts.releaseCount).toBe(1);
      expect(receipts.completeCount).toBe(1);
    },
  );

  it("releases a replayed busy disposition and advances the retry identity", async () => {
    const receipts = new FarewellReceiptMemory();
    const context = fixture(undefined, logger, receipts);
    context.coordinator.playOutcome = "reused";
    context.coordinator.reusedDisposition = "busy";
    await triggerFarewell(context, "Всем пока!", "turn-1", 1_100);

    context.coordinator.playOutcome = "active";
    await triggerFarewell(context, "Bye everyone!", "turn-2", 1_300);

    expect(context.coordinator.cueCalls).toEqual([
      expect.objectContaining({ turnId: "meeting-farewell:v1" }),
      expect.objectContaining({ turnId: "meeting-farewell:v1:retry-1" }),
    ]);
    expect(receipts.releaseCount).toBe(1);
    expect(receipts.completeCount).toBe(1);
  });

  it("releases a confirmed-unplayed admission and permits one safe retry", async () => {
    const receipts = new FarewellReceiptMemory();
    const context = fixture(undefined, logger, receipts);
    context.coordinator.playbackSettlement = "unplayed";
    await triggerFarewell(context, "Всем пока!", "turn-1", 1_100);

    context.coordinator.playbackSettlement = "played";
    await triggerFarewell(context, "Bye everyone!", "turn-2", 1_300);

    expect(context.coordinator.cueCalls).toEqual([
      expect.objectContaining({ turnId: "meeting-farewell:v1" }),
      expect.objectContaining({ turnId: "meeting-farewell:v1:retry-1" }),
    ]);
    expect(receipts.releaseCount).toBe(1);
    expect(receipts.completeCount).toBe(1);
  });

  it.each(["partial", "unknown"] as const)(
    "durably fences an admitted %s outcome from restart replay",
    async (settlement) => {
      const receipts = new FarewellReceiptMemory();
      const first = fixture(undefined, logger, receipts);
      first.coordinator.playbackSettlement = settlement;
      await triggerFarewell(first, "Всем пока!", "turn-1", 1_100);

      const restarted = fixture(undefined, logger, receipts);
      await triggerFarewell(restarted, "Bye everyone!", "turn-2", 1_100);

      expect(first.coordinator.cueCalls).toHaveLength(1);
      expect(restarted.coordinator.cueCalls).toEqual([]);
      expect(receipts.releaseCount).toBe(0);
      expect(receipts.completeCount).toBe(1);
    },
  );

  it("durably fences an exception after admission settlement began", async () => {
    const receipts = new FarewellReceiptMemory();
    const first = fixture(undefined, logger, receipts);
    first.coordinator.settlementError = new Error("synthetic settlement failure");
    await triggerFarewell(first, "Всем пока!", "turn-1", 1_100);

    const restarted = fixture(undefined, logger, receipts);
    await triggerFarewell(restarted, "Bye everyone!", "turn-2", 1_100);

    expect(first.coordinator.cueCalls).toHaveLength(1);
    expect(restarted.coordinator.cueCalls).toEqual([]);
    expect(receipts.releaseCount).toBe(0);
    expect(receipts.completeCount).toBe(1);
  });

  it.each(["unplayed", "partial", "unknown"] as const)(
    "does not publish false settled evidence for a %s farewell",
    async (settlement) => {
      const infoCalls: string[] = [];
      const context = fixture(undefined, {
        ...logger,
        info: (message) => infoCalls.push(message),
      });
      context.coordinator.playbackSettlement = settlement;
      const event = finalEvent("Всем пока!");
      const revision = context.bridge.observeSpeech(event);
      context.bridge.observeFinalizedTurn(event, "turn-1", revision);
      context.setNowMs(1_100);
      context.bridge.advance();
      await context.bridge.settle();

      expect(context.coordinator.cueCalls).toHaveLength(1);
      expect(infoCalls).toEqual([]);
    },
  );

  it("retains settled evidence when a farewell is initially queued", async () => {
    const infoCalls: string[] = [];
    const context = fixture(undefined, {
      ...logger,
      info: (message) => infoCalls.push(message),
    });
    context.coordinator.playOutcome = "queued";
    const event = finalEvent("Всем пока!");
    const revision = context.bridge.observeSpeech(event);
    context.bridge.observeFinalizedTurn(event, "turn-1", revision);
    context.setNowMs(1_100);
    context.bridge.advance();
    await context.bridge.settle();

    expect(context.coordinator.cueCalls).toHaveLength(1);
    expect(infoCalls).toEqual(["Meeting farewell playback settled"]);
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

async function triggerFarewell(
  context: ReturnType<typeof fixture>,
  text: string,
  turnId: string,
  nowMs: number,
): Promise<void> {
  const event = finalEvent(text);
  const revision = context.bridge.observeSpeech(event);
  context.bridge.observeFinalizedTurn(event, turnId, revision);
  context.setNowMs(nowMs);
  context.bridge.advance();
  await context.bridge.settle();
}

class FarewellReceiptMemory implements LiveConversationOneShotReceiptPort {
  public completeCount = 0;
  private leaseSequence = 0;
  public releaseCount = 0;
  public reserveCount = 0;
  private receipt: { readonly leaseToken?: string; readonly state: "completed" | "reserved" }
    | undefined;

  public complete(input: Parameters<LiveConversationOneShotReceiptPort["complete"]>[0]) {
    this.completeCount += 1;
    if (this.receipt?.leaseToken === input.leaseToken) {
      this.receipt = { state: "completed" };
    }
    return Promise.resolve();
  }

  public release(input: Parameters<LiveConversationOneShotReceiptPort["release"]>[0]) {
    this.releaseCount += 1;
    if (this.receipt?.leaseToken === input.leaseToken) {
      this.receipt = undefined;
    }
    return Promise.resolve();
  }

  public reserve() {
    this.reserveCount += 1;
    if (this.receipt?.state === "completed") {
      return Promise.resolve({ status: "completed" as const });
    }
    if (this.receipt?.state === "reserved") {
      return Promise.resolve({ status: "in_flight" as const });
    }
    this.leaseSequence += 1;
    const leaseToken = `farewell-test-lease-${this.leaseSequence}`;
    this.receipt = { leaseToken, state: "reserved" };
    return Promise.resolve({ leaseToken, status: "reserved" as const });
  }
}
