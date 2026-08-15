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
import { MemoryOneShotReceipts } from "./participant-greeting-receipt-memory.js";

const participantId = "1533224474609057795";
const logger: LiveRuntimeLogger = {
  debug: () => {}, error: () => {}, info: () => {}, warn: () => {},
};
const timer: LiveRuntimeTimer = {
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  repeat: (intervalMs, callback) => setInterval(callback, intervalMs),
  schedule: (delayMs, callback) => setTimeout(callback, delayMs),
};

class DeadlineCoordinator {
  public readonly calls: unknown[] = [];
  public whenIdle = () => Promise.resolve();
  public advanceMeeting(): void {}
  public closeMeeting(): Promise<void> { return Promise.resolve(); }
  public disconnectMeeting(): Promise<void> { return Promise.resolve(); }
  public handleFinalizedTurn() { return Promise.resolve({ status: "ignored" as const }); }
  public handleProactiveTurn(input: unknown) {
    this.calls.push(input);
    return Promise.resolve({ status: "active" as const });
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
    nowMilliseconds: () => 321,
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
      first.bridge.participantJoined(participantId);

      await vi.advanceTimersByTimeAsync(5_000);
      await first.bridge.settle();
      ready = true;
      first.bridge.advance();
      await first.bridge.settle();

      expect(first.coordinator.calls).toEqual([]);
      expect(receipts.state("greeting", "recording-1", participantId)).toBe("completed");
      const restarted = deadlineFixture(() => true, receipts);
      restarted.bridge.participantsRestored([participantId]);
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
      context.bridge.participantJoined(participantId);
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
    first.participantJoined(participantId);
    await first.settle();
    expect(receipts.state("greeting", "recording-1", participantId)).toBe("completed");
    expect(transport.commands.map(({ type }) => type)).toEqual([
      "playback-start", "audio-chunk", "audio-chunk", "playback-finish",
    ]);
    first.participantLeft(participantId);
    first.participantJoined(participantId);
    await first.settle();
    const restarted = createBridge();
    restarted.participantsRestored([participantId]);
    await restarted.settle();
    expect(transport.commands.filter(({ type }) => type === "playback-start")).toHaveLength(1);
  } finally {
    await coordinator.closeMeeting("recording-1", 30);
    playback.close();
  }
});
