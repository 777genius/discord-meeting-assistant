import type {
  CraigPlaybackCommand,
  CraigPlaybackEvent,
} from "@discord-meeting/craig-gateway-contracts";
import {
  CraigPlaybackGateway,
  type CraigPlaybackTransport,
} from "@discord-meeting/craig-playback-adapter";
import {
  ConversationCoordinator,
  type ConversationRuntime,
} from "@discord-meeting/meeting-core/conversation";
import { describe, expect, it, vi } from "vitest";

import type {
  LiveConversationConfiguration,
  LiveRuntimeLogger,
  LiveRuntimeTimer,
} from "../src/live-runtime/contracts.js";
import { ParticipantGreetingBridge } from "../src/live-runtime/participant-greeting-bridge.js";
import { participantGreetingFreshness } from "../src/live-runtime/participant-greeting-deadline.js";
import { MemoryOneShotReceipts } from "./participant-greeting-receipt-memory.js";

const participantId = "1533224474609057795";
const occurredAt = "1970-01-01T00:00:00.321Z";
const logger: LiveRuntimeLogger = {
  debug: () => {}, error: () => {}, info: () => {}, warn: () => {},
};
const timer: LiveRuntimeTimer = {
  cancel: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  repeat: (intervalMs, callback) => setInterval(callback, intervalMs),
  schedule: (delayMs, callback) => setTimeout(callback, delayMs),
};

describe("participant greeting freshness", () => {
  const observedAt = Date.parse("2026-08-02T10:20:00.000Z");

  it("gives a fresh late-in-meeting join its producer-anchored remaining budget", () => {
    expect(participantGreetingFreshness(
      "2026-08-02T10:19:58.000Z",
      observedAt,
    )).toEqual({
      anchorMilliseconds: observedAt - 2_000,
      remainingMilliseconds: 3_000,
      status: "fresh",
    });
  });

  it.each([
    ["invalid", "not-an-instant"],
    ["stale", "2026-08-02T10:10:00.000Z"],
    ["implausibly future", "2026-08-02T10:20:01.001Z"],
  ])("terminalizes an %s lifecycle timestamp", (_scenario, occurredAtValue) => {
    expect(participantGreetingFreshness(occurredAtValue, observedAt)).toEqual({
      status: "terminal",
    });
  });

  it("clamps a bounded future skew without extending the five-second budget", () => {
    expect(participantGreetingFreshness(
      "2026-08-02T10:20:01.000Z",
      observedAt,
    )).toEqual({
      anchorMilliseconds: observedAt,
      remainingMilliseconds: 5_000,
      status: "fresh",
    });
  });
});

class DeadlineCoordinator {
  public readonly calls: unknown[] = [];
  public readonly outcomes: Array<{ readonly status: "active" | "busy" }> = [];
  public whenIdle = () => Promise.resolve();
  public advanceMeeting(): void {}
  public closeMeeting(): Promise<void> { return Promise.resolve(); }
  public disconnectMeeting(): Promise<void> { return Promise.resolve(); }
  public handleFinalizedTurn() { return Promise.resolve({ status: "ignored" as const }); }
  public handleProactiveTurn(input: unknown) {
    this.calls.push(input);
    return Promise.resolve(this.outcomes.shift() ?? { status: "active" as const });
  }
  public participantLeft(): Promise<void> { return Promise.resolve(); }
  public playPreparedCue(input: unknown) {
    this.calls.push(input);
    return Promise.resolve({ status: "active" as const });
  }
  public speechActivity() { return Promise.resolve({ status: "ignored" as const }); }
  public speechEnded() { return Promise.resolve({ status: "ignored" as const }); }
  public speechStarted() { return Promise.resolve({ status: "ignored" as const }); }
  public whenTurnPlaybackSettled() { return Promise.resolve("played" as const); }
}

function deadlineFixture(
  ready: () => boolean,
  receipts: MemoryOneShotReceipts,
  runtimeLogger: LiveRuntimeLogger = logger,
  nowMilliseconds: () => number = () => 321,
) {
  const coordinator = new DeadlineCoordinator();
  const configuration: LiveConversationConfiguration = {
    coordinator,
    greetings: {
      defaultLocale: "ru",
      excludedParticipantIds: [],
      isPlaybackReady: ready,
      profiles: {
        [participantId]: {
          displayName: "Александр Смирнов",
          greetingLocale: "ru",
          spokenName: "Саша",
        },
      },
    },
    locale: "auto",
    nowMilliseconds,
    oneShotReceipts: receipts,
    systemPrompt: "Answer briefly.",
    voiceProfileId: "voice-profile",
  };
  return {
    bridge: new ParticipantGreetingBridge({
      configuration,
      isMeetingFinishing: () => false,
      logger: runtimeLogger,
      meetingId: "recording-1",
      timer,
    }),
    coordinator,
  };
}

describe("ParticipantGreetingBridge join-to-first-audio deadline", () => {
  it("durably terminalizes a stale delivered lifecycle without PCM", async () => {
    const receipts = new MemoryOneShotReceipts();
    const now = Date.parse("2026-08-02T10:20:00.000Z");
    const context = deadlineFixture(() => true, receipts, logger, () => now);

    context.bridge.participantJoined(participantId, "2026-08-02T10:10:00.000Z");
    await context.bridge.settle();

    expect(context.coordinator.calls).toEqual([]);
    expect(receipts.state("greeting", "recording-1", participantId)).toBe("completed");
  });

  it("uses only the producer-anchored remainder while waiting for readiness", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.parse("2026-08-02T10:20:04.000Z");
      const receipts = new MemoryOneShotReceipts();
      const context = deadlineFixture(() => false, receipts, logger, () => now);
      context.bridge.participantJoined(participantId, "2026-08-02T10:20:00.000Z");

      await vi.advanceTimersByTimeAsync(999);
      expect(receipts.state("greeting", "recording-1", participantId)).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await context.bridge.settle();

      expect(context.coordinator.calls).toEqual([]);
      expect(receipts.state("greeting", "recording-1", participantId)).toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not grant a fresh budget to a busy retry", async () => {
    vi.useFakeTimers();
    try {
      const context = deadlineFixture(() => true, new MemoryOneShotReceipts());
      context.coordinator.outcomes.push({ status: "busy" });
      context.bridge.participantJoined(participantId, occurredAt);
      await context.bridge.settle();

      await vi.advanceTimersByTimeAsync(5_000);
      await context.bridge.settle();
      context.bridge.advance();
      await context.bridge.settle();

      expect(context.coordinator.calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("durably terminalizes a join when Craig readiness never arrives", async () => {
    vi.useFakeTimers();
    try {
      let ready = false;
      const warnings: Array<Readonly<Record<string, unknown>> | undefined> = [];
      const receipts = new MemoryOneShotReceipts();
      const first = deadlineFixture(() => ready, receipts, {
        ...logger,
        warn: (_message, fields) => warnings.push(fields),
      });
      first.bridge.participantJoined(participantId, occurredAt);

      await vi.advanceTimersByTimeAsync(5_000);
      await first.bridge.settle();
      ready = true;
      first.bridge.advance();
      await first.bridge.settle();

      expect(first.coordinator.calls).toEqual([]);
      expect(receipts.state("greeting", "recording-1", participantId)).toBe("completed");
      const restarted = deadlineFixture(() => true, receipts);
      restarted.bridge.participantsRestored([participantId], occurredAt);
      await restarted.bridge.settle();
      expect(restarted.coordinator.calls).toEqual([]);
      expect(warnings).toContainEqual(expect.objectContaining({
        reason: "join-to-first-audio-deadline",
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not admit delayed playback after whenIdle reaches the same deadline", async () => {
    vi.useFakeTimers();
    try {
      let releaseIdle: (() => void) | undefined;
      const idle = new Promise<void>((resolve) => {
        releaseIdle = resolve;
      });
      const context = deadlineFixture(() => true, new MemoryOneShotReceipts());
      context.coordinator.whenIdle = () => idle;
      context.bridge.participantJoined(participantId, occurredAt);
      const settlement = context.bridge.settle();

      await vi.advanceTimersByTimeAsync(5_000);
      await settlement;
      releaseIdle?.();
      await Promise.resolve();

      expect(context.coordinator.calls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

class GreetingCraigTransport implements CraigPlaybackTransport {
  public bufferedBytes = 0;
  public readonly commands: CraigPlaybackCommand[] = [];
  public readonly identity = {
    channelId: "synthetic-channel-1",
    gatewaySessionId: "synthetic-gateway-session-1",
    guildId: "synthetic-guild-1",
    recordingId: "recording-1",
  };
  private closeListener: (reason: string) => void = () => {};
  private eventListener: (event: CraigPlaybackEvent) => void = () => {};
  private playbackStarted = false;
  public close(_code: number, reason: string): void { this.closeListener(reason); }
  public onClose(listener: (reason: string) => void): void { this.closeListener = listener; }
  public onEvent(listener: (event: CraigPlaybackEvent) => void): void {
    this.eventListener = listener;
  }
  public send(command: CraigPlaybackCommand): Promise<void> {
    this.commands.push(structuredClone(command));
    if (command.type === "audio-chunk" && !this.playbackStarted) {
      this.playbackStarted = true;
      this.eventListener({
        attemptId: command.attemptId, recordingId: command.recordingId,
        schemaVersion: 1, startedAtMs: 10, turnId: command.turnId,
        type: "playback-started",
      });
    } else if (command.type === "playback-finish") {
      this.eventListener({
        attemptId: command.attemptId, finishedAtMs: 20,
        recordingId: command.recordingId, schemaVersion: 1,
        turnId: command.turnId, type: "playback-finished",
      });
    }
    return Promise.resolve();
  }
}

it("drives join, reconnect and durable restart through real Craig playback", async () => {
  const receipts = new MemoryOneShotReceipts();
  const transport = new GreetingCraigTransport();
  const playback = new CraigPlaybackGateway(() => 10);
  playback.register(transport);
  const runtime: ConversationRuntime = {
    startTurn: () => Promise.reject(new Error("prepared greeting must not invoke Pipecat")),
  };
  const coordinator = new ConversationCoordinator({ playback, runtime });
  const createBridge = () => new ParticipantGreetingBridge({
    configuration: {
      coordinator,
      greetings: {
        cues: { select: () => ({
          cueId: "greeting-ru-sasha-v1",
          pcmChunks: [Uint8Array.of(1, 0, 2, 0), Uint8Array.of(3, 0, 4, 0)],
          playbackAttemptId: "greeting-craig-attempt-1",
        }) },
        defaultLocale: "ru", excludedParticipantIds: [],
        isPlaybackReady: () => playback.hasSession("recording-1"),
        profiles: { [participantId]: {
          displayName: "Александр Смирнов", greetingLocale: "ru", spokenName: "Саша",
        } },
      },
      locale: "auto", nowMilliseconds: () => 10, oneShotReceipts: receipts,
      systemPrompt: "Answer briefly.", voiceProfileId: "voice-profile",
    },
    isMeetingFinishing: () => false, logger, meetingId: "recording-1", timer,
  });
  try {
    const first = createBridge();
    first.participantJoined(participantId, occurredAt);
    await first.settle();
    expect(receipts.state("greeting", "recording-1", participantId)).toBe("completed");
    expect(transport.commands.map(({ type }) => type)).toEqual([
      "playback-start", "audio-chunk", "audio-chunk", "playback-finish",
    ]);
    first.participantLeft(participantId);
    first.participantJoined(participantId, occurredAt);
    await first.settle();
    const restarted = createBridge();
    restarted.participantsRestored([participantId], occurredAt);
    await restarted.settle();
    expect(transport.commands.filter(({ type }) => type === "playback-start")).toHaveLength(1);
  } finally {
    await coordinator.closeMeeting("recording-1", 30);
    playback.close();
  }
});
