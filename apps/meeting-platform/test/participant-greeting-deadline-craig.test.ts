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
  LiveConversationOneShotReceiptPort,
  LiveRuntimeLogger,
  LiveRuntimeTimer,
} from "../src/live-runtime/contracts.js";
import { ParticipantGreetingBridge } from "../src/live-runtime/participant-greeting-bridge.js";
import { participantGreetingFreshness } from "../src/live-runtime/participant-greeting-deadline.js";
import { MemoryOneShotReceipts } from "./participant-greeting-receipt-memory.js";

const participantId = "1533224474609057795";
const secondParticipantId = "2533224474609057795";
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
      expiresAtMilliseconds: observedAt + 3_000,
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
      expiresAtMilliseconds: observedAt + 5_000,
      remainingMilliseconds: 5_000,
      status: "fresh",
    });
  });
});

class DeadlineCoordinator {
  public readonly calls: unknown[] = [];
  public participantLeftCalls = 0;
  public readonly outcomes: Array<{ readonly status: "active" | "busy" }> = [];
  public whenIdle = () => Promise.resolve();
  public advanceMeeting(): void {}
  public closeMeeting(): Promise<void> { return Promise.resolve(); }
  public disconnectMeeting(): Promise<void> { return Promise.resolve(); }
  public handleFinalizedTurn() { return Promise.resolve({ status: "ignored" as const }); }
  public handleProactiveTurn(
    input: Parameters<LiveConversationConfiguration["coordinator"]["handleProactiveTurn"]>[0],
  ) {
    this.calls.push(input);
    return Promise.resolve(this.outcomes.shift() ?? { status: "active" as const });
  }
  public participantLeft(): Promise<void> {
    this.participantLeftCalls += 1;
    return Promise.resolve();
  }
  public playPreparedCue(input: unknown) {
    this.calls.push(input);
    return Promise.resolve({ status: "active" as const });
  }
  public speechActivity() { return Promise.resolve({ status: "ignored" as const }); }
  public speechEnded() { return Promise.resolve({ status: "ignored" as const }); }
  public speechStarted() { return Promise.resolve({ status: "ignored" as const }); }
  public whenTurnPlaybackStarted(): Promise<
    { readonly startedAtMs: number; readonly status: "started" } |
    { readonly status: "unplayed" | "unknown" }
  > {
    return Promise.resolve({ startedAtMs: 321, status: "started" as const });
  }
  public whenTurnPlaybackSettled(): Promise<"partial" | "played" | "unknown" | "unplayed"> {
    return Promise.resolve("played");
  }
}

function deadlineFixture(
  ready: () => boolean,
  receipts: LiveConversationOneShotReceiptPort,
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
        [secondParticipantId]: {
          displayName: "Alex Smith",
          greetingLocale: "en",
          spokenName: "Alex",
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

describe("ParticipantGreetingBridge lifecycle cancellation", () => {
  it("chains a requested advance and settle across consecutive drains", async () => {
    const context = deadlineFixture(() => true, new MemoryOneShotReceipts());
    let releaseFirstAdmission: (() => void) | undefined;
    let releaseSecondSettlement: (() => void) | undefined;
    context.coordinator.handleProactiveTurn = (input: unknown) => {
      context.coordinator.calls.push(input);
      if (context.coordinator.calls.length === 1) {
        return new Promise<{ readonly status: "busy" }>((resolve) => {
          releaseFirstAdmission = () => {
            resolve({ status: "busy" as const });
          };
        });
      }
      return Promise.resolve({ status: "active" as const });
    };
    context.coordinator.whenTurnPlaybackSettled = () => new Promise<"played">((resolve) => {
      releaseSecondSettlement = () => {
        resolve("played");
      };
    });

    context.bridge.participantJoined(participantId, occurredAt);
    await vi.waitFor(() => {
      expect(context.coordinator.calls).toHaveLength(1);
    });
    context.bridge.participantJoined(secondParticipantId, occurredAt);
    const settlement = context.bridge.settle();
    let settled = false;
    void settlement.then(() => {
      settled = true;
      return settled;
    });
    releaseFirstAdmission?.();
    await vi.waitFor(() => {
      expect(context.coordinator.calls).toHaveLength(2);
    });
    expect(settled).toBe(false);

    releaseSecondSettlement?.();
    await settlement;
    expect(context.coordinator.calls).toEqual([
      expect.objectContaining({ speakerId: participantId }),
      expect.objectContaining({ speakerId: secondParticipantId }),
    ]);
  });

  it("does not wait behind a stuck conversation idle barrier", async () => {
    const context = deadlineFixture(() => true, new MemoryOneShotReceipts());
    let idleCalls = 0;
    context.coordinator.whenIdle = () => {
      idleCalls += 1;
      return new Promise<void>(() => {});
    };

    context.bridge.participantJoined(participantId, occurredAt);
    await context.bridge.settle();

    expect(context.coordinator.calls).toEqual([
      expect.objectContaining({ preemptive: true, speakerId: participantId }),
    ]);
    expect(idleCalls).toBe(0);
  });

  it("cancels a stuck prior greeting so a close join can start without overlap", async () => {
    const context = deadlineFixture(() => true, new MemoryOneShotReceipts());
    let releaseFirst: (() => void) | undefined;
    let settlements = 0;
    context.coordinator.whenTurnPlaybackSettled = () => {
      settlements += 1;
      return settlements === 1
        ? new Promise<"partial">((resolve) => {
            releaseFirst = () => {
              resolve("partial");
            };
          })
        : Promise.resolve("played");
    };
    context.coordinator.participantLeft = () => {
      context.coordinator.participantLeftCalls += 1;
      releaseFirst?.();
      return Promise.resolve();
    };

    context.bridge.participantJoined(participantId, occurredAt);
    await vi.waitFor(() => {
      expect(context.coordinator.calls).toHaveLength(1);
    });
    context.bridge.participantJoined(secondParticipantId, occurredAt);

    await context.bridge.settle();
    expect(context.coordinator.calls).toEqual([
      expect.objectContaining({ speakerId: participantId }),
      expect.objectContaining({ speakerId: secondParticipantId }),
    ]);
    expect(context.coordinator.participantLeftCalls).toBe(1);
  });
});

describe("ParticipantGreetingBridge join-to-first-audio deadline", () => {
  it.each([
    ["accepts", 5_320, "played"],
    ["rejects", 5_321, "suppressed_stale"],
  ] as const)("%s first audio at the exact five-second clock bound", async (
    _expectation,
    startedAtMs,
    expectedReceipt,
  ) => {
    const receipts = new MemoryOneShotReceipts();
    let now = 321;
    const context = deadlineFixture(() => true, receipts, logger, () => now);
    context.coordinator.whenTurnPlaybackStarted = () => {
      now = startedAtMs;
      return Promise.resolve({ startedAtMs, status: "started" as const });
    };

    context.bridge.participantJoined(participantId, occurredAt);
    await context.bridge.settle();

    expect(receipts.state("greeting", "recording-1", participantId))
      .toBe(expectedReceipt);
  });

  it("represents a mixed-locale supported cohort in one deadline-safe command", async () => {
    const receipts = new MemoryOneShotReceipts();
    const context = deadlineFixture(() => true, receipts);

    context.bridge.participantsPresent([
      participantId,
      secondParticipantId,
      "3533224474609057795",
    ], occurredAt);
    await context.bridge.settle();

    expect(context.coordinator.calls).toHaveLength(1);
    expect(receipts.state("greeting", "recording-1", secondParticipantId))
      .toBe("played");
  });

  it("uses the earliest occurrence across priority lanes before issuing a cohort command", async () => {
    let now = 1_321;
    let ready = false;
    const receipts = new MemoryOneShotReceipts();
    const context = deadlineFixture(() => ready, receipts, logger, () => now);
    context.coordinator.whenTurnPlaybackStarted = () => Promise.resolve({
      startedAtMs: now,
      status: "started" as const,
    });

    context.bridge.participantsPresent(
      [participantId],
      "1970-01-01T00:00:00.321Z",
    );
    context.bridge.participantJoined(
      secondParticipantId,
      "1970-01-01T00:00:01.321Z",
    );
    ready = true;
    now = 5_321;
    context.bridge.advance();
    await context.bridge.settle();

    expect(receipts.state("greeting", "recording-1", participantId))
      .toBe("suppressed_stale");
    expect(receipts.state("greeting", "recording-1", secondParticipantId)).toBe("played");
    expect(context.coordinator.calls).toEqual([
      expect.objectContaining({ speakerId: secondParticipantId }),
    ]);
  });

  it("cancels a stuck multilingual cohort after its bounded completion slot", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(321);
      const receipts = new MemoryOneShotReceipts();
      const context = deadlineFixture(() => true, receipts, logger, () => Date.now());
      const events: string[] = [];
      context.coordinator.handleProactiveTurn = (
        input: Parameters<
          LiveConversationConfiguration["coordinator"]["handleProactiveTurn"]
        >[0],
      ) => {
        const { turnId } = input;
        events.push(`admit:${turnId}`);
        context.coordinator.calls.push(input);
        return Promise.resolve({ status: "active" as const });
      };
      context.coordinator.whenTurnPlaybackStarted = () => Promise.resolve({
        startedAtMs: Date.now(),
        status: "started" as const,
      });
      context.coordinator.whenTurnPlaybackSettled = (_meetingId?: string, turnId?: string) =>
        turnId?.endsWith(participantId) === true
          ? new Promise<never>(() => {})
          : Promise.resolve("played" as const);
      context.coordinator.participantLeft = () => {
        events.push("cancel:first");
        context.coordinator.participantLeftCalls += 1;
        return Promise.resolve();
      };

      context.bridge.participantsPresent([
        participantId,
        secondParticipantId,
      ], occurredAt);
      const settlement = context.bridge.settle();
      await vi.advanceTimersByTimeAsync(45_250);
      await settlement;

      expect(context.coordinator.calls).toHaveLength(1);
      expect(events).toEqual([
        `admit:participant-greeting:${participantId}`,
        "cancel:first",
      ]);
      expect(Date.now() - 321).toBeLessThan(46_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("durably terminalizes a stale delivered lifecycle without PCM", async () => {
    const receipts = new MemoryOneShotReceipts();
    const now = Date.parse("2026-08-02T10:20:00.000Z");
    const context = deadlineFixture(() => true, receipts, logger, () => now);

    context.bridge.participantJoined(participantId, "2026-08-02T10:10:00.000Z");
    await context.bridge.settle();

    expect(context.coordinator.calls).toEqual([]);
    expect(receipts.state("greeting", "recording-1", participantId)).toBe("suppressed_stale");
  });

  it.each([
    ["invalid", "not-an-instant"],
    ["future", "2026-08-02T10:20:01.001Z"],
  ])("durably terminalizes an %s lifecycle through the full bridge", async (
    _scenario,
    lifecycleAt,
  ) => {
    const receipts = new MemoryOneShotReceipts();
    const now = Date.parse("2026-08-02T10:20:00.000Z");
    const context = deadlineFixture(() => true, receipts, logger, () => now);

    context.bridge.participantJoined(participantId, lifecycleAt);
    await context.bridge.settle();

    expect(context.coordinator.calls).toEqual([]);
    expect(receipts.state("greeting", "recording-1", participantId)).toBe("suppressed_stale");
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
      expect(receipts.state("greeting", "recording-1", participantId)).toBe("suppressed_stale");
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
      expect(receipts.state("greeting", "recording-1", participantId)).toBe("suppressed_stale");
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

  it("blocks admission after event-loop lag even before the timer callback runs", async () => {
    let now = 321;
    let releaseIdle: (() => void) | undefined;
    const idle = new Promise<void>((resolve) => {
      releaseIdle = resolve;
    });
    const receipts = new MemoryOneShotReceipts();
    const context = deadlineFixture(() => true, receipts, logger, () => now);
    context.coordinator.whenIdle = () => idle;
    context.bridge.participantJoined(participantId, occurredAt);
    const settlement = context.bridge.settle();

    now = 5_321;
    releaseIdle?.();
    await settlement;

    expect(context.coordinator.calls).toEqual([]);
    expect(receipts.state("greeting", "recording-1", participantId)).toBe("suppressed_stale");
  });

});

describe("ParticipantGreetingBridge playback deadline fencing", () => {

  it("keeps valid first audio when playback settles within its bounded slot", async () => {
    vi.useFakeTimers();
    try {
      let now = 321;
      let startPlayback: (() => void) | undefined;
      let finishPlayback: (() => void) | undefined;
      const receipts = new MemoryOneShotReceipts();
      const context = deadlineFixture(() => true, receipts, logger, () => now);
      context.coordinator.whenTurnPlaybackStarted = () => new Promise((resolve) => {
        startPlayback = () => {
          resolve({
            startedAtMs: 5_320,
            status: "started" as const,
          });
        };
      });
      context.coordinator.whenTurnPlaybackSettled = () => new Promise((resolve) => {
        finishPlayback = () => {
          resolve("played");
        };
      });
      context.bridge.participantJoined(participantId, occurredAt);
      const settlement = context.bridge.settle();
      await vi.waitFor(() => {
        expect(context.coordinator.calls).toHaveLength(1);
      });
      now = 5_320;
      startPlayback?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);

      now = 7_000;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(context.coordinator.participantLeftCalls).toBe(0);
      finishPlayback?.();
      await settlement;

      expect(receipts.state("greeting", "recording-1", participantId)).toBe("played");
      expect(context.coordinator.participantLeftCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a commanded greeting when provider start is still queued at the deadline",
    async () => {
    vi.useFakeTimers();
    try {
      let finishStartObservation: (() => void) | undefined;
      const receipts = new MemoryOneShotReceipts();
      const context = deadlineFixture(() => true, receipts);
      context.coordinator.whenTurnPlaybackStarted = () => new Promise((resolve) => {
        finishStartObservation = () => {
          resolve({ startedAtMs: 5_320, status: "started" });
        };
      });
      context.bridge.participantJoined(participantId, occurredAt);
      const settlement = context.bridge.settle();
      await vi.waitFor(() => {
        expect(context.coordinator.calls).toHaveLength(1);
      });
      expect(receipts.state("greeting", "recording-1", participantId)).toBe("commanded");

      await vi.advanceTimersByTimeAsync(5_000);
      expect(context.coordinator.participantLeftCalls).toBe(1);
      expect(receipts.state("greeting", "recording-1", participantId)).toBe("suppressed_stale");
      finishStartObservation?.();
      await settlement;
      expect(receipts.state("greeting", "recording-1", participantId)).toBe("suppressed_stale");
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits no audio when the durable commit crosses the absolute deadline", async () => {
    vi.useFakeTimers();
    try {
      let completeReceipt: (() => void) | undefined;
      let receiptState: "commanded" | "reserved" | undefined;
      const receipts: LiveConversationOneShotReceiptPort = {
        beginGreetingAttempt: () => new Promise((resolve) => {
          completeReceipt = () => {
            receiptState = "commanded";
            resolve();
          };
        }),
        beginGreetingCohortAttempt: () => Promise.resolve(),
        complete: () => Promise.resolve(),
        confirmGreetingStarted: () => Promise.resolve(),
        confirmGreetingCohortStarted: () => Promise.resolve(),
        reconcileGreetingCapacity: () => Promise.resolve({
          commandedSubjectIds: [],
          suppressedSubjectIds: [],
          terminalSubjectIds: [],
        }),
        release: () => Promise.resolve(),
        reserve: () => {
          receiptState = "reserved";
          return Promise.resolve({ leaseToken: "lease-1", status: "reserved" });
        },
        settleGreeting: () => Promise.resolve(),
      };
      let now = 321;
      const context = deadlineFixture(() => true, receipts, logger, () => now);
      context.bridge.participantJoined(participantId, occurredAt);
      let settled = false;
      const settlement = (async () => {
        await context.bridge.settle();
        settled = true;
      })();
      await vi.waitFor(() => {
        expect(receiptState).toBe("reserved");
      });

      now = 5_321;
      await vi.advanceTimersByTimeAsync(5_000);

      expect(receiptState).toBe("reserved");
      expect(settled).toBe(false);
      expect(context.coordinator.calls).toEqual([]);
      completeReceipt?.();
      await settlement;
      expect(settled).toBe(true);
      expect(receiptState).toBe("commanded");
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses a command that has no safe startup budget after commit", async () => {
    let completeReceipt: (() => void) | undefined;
    let completeCalls = 0;
    let commitSettled = false;
    let postCommitObservations = 0;
    let receiptState: "commanded" | "reserved" | undefined;
    const receipts: LiveConversationOneShotReceiptPort = {
      beginGreetingAttempt: () => new Promise((resolve) => {
        completeCalls += 1;
        completeReceipt = () => {
          commitSettled = true;
          receiptState = "commanded";
          resolve();
        };
      }),
      beginGreetingCohortAttempt: () => Promise.resolve(),
      complete: () => Promise.resolve(),
      confirmGreetingStarted: () => Promise.resolve(),
      confirmGreetingCohortStarted: () => Promise.resolve(),
      reconcileGreetingCapacity: () => Promise.resolve({
        commandedSubjectIds: [],
        suppressedSubjectIds: [],
        terminalSubjectIds: [],
      }),
      release: () => Promise.resolve(),
      reserve: () => {
        receiptState = "reserved";
        return Promise.resolve({ leaseToken: "lease-1", status: "reserved" });
      },
      settleGreeting: () => Promise.resolve(),
    };
    const now = () => {
      if (!commitSettled) {
        return 321;
      }
      postCommitObservations += 1;
      return postCommitObservations === 1 ? 5_320 : 5_321;
    };
    const context = deadlineFixture(() => true, receipts, logger, now);
    context.bridge.participantJoined(participantId, occurredAt);
    const settlement = context.bridge.settle();
    await vi.waitFor(() => {
      expect(receiptState).toBe("reserved");
      expect(completeReceipt).toBeTypeOf("function");
    });

    completeReceipt?.();
    await settlement;

    expect(receiptState).toBe("commanded");
    expect(completeCalls).toBe(1);
    expect(postCommitObservations).toBeGreaterThanOrEqual(2);
    expect(context.coordinator.calls).toEqual([]);
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

it.each([10, 20])(
  "never sends Craig PCM for a lifecycle restored %i minutes late",
  async (minutesLate) => {
    const receipts = new MemoryOneShotReceipts();
    const transport = new GreetingCraigTransport();
    const playback = new CraigPlaybackGateway(() => 10);
    playback.register(transport);
    const coordinator = new ConversationCoordinator({
      playback,
      runtime: {
        startTurn: () => Promise.reject(new Error("stale greeting must not invoke runtime")),
      },
    });
    const now = Date.parse("2026-08-02T10:20:00.000Z");
    const bridge = new ParticipantGreetingBridge({
      configuration: {
        coordinator,
        greetings: {
          cues: { select: () => ({
            cueId: "greeting-ru-sasha-v1",
            pcmChunks: [Uint8Array.of(1, 0, 2, 0)],
            playbackAttemptId: `late-${minutesLate}`,
          }) },
          defaultLocale: "ru",
          excludedParticipantIds: [],
          isPlaybackReady: () => true,
          profiles: { [participantId]: {
            displayName: "Александр Смирнов",
            greetingLocale: "ru",
            spokenName: "Саша",
          } },
        },
        locale: "auto",
        nowMilliseconds: () => now,
        oneShotReceipts: receipts,
        systemPrompt: "Answer briefly.",
        voiceProfileId: "voice-profile",
      },
      isMeetingFinishing: () => false,
      logger,
      meetingId: "recording-1",
      timer,
    });
    try {
      bridge.participantsRestored([
        participantId,
      ], new Date(now - minutesLate * 60_000).toISOString());
      await bridge.settle();

      expect(transport.commands.filter(({ type }) => type === "audio-chunk")).toEqual([]);
      expect(receipts.state("greeting", "recording-1", participantId)).toBe("suppressed_stale");
    } finally {
      await coordinator.closeMeeting("recording-1", now);
      playback.close();
    }
  },
);

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
    expect(receipts.state("greeting", "recording-1", participantId)).toBe("played");
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
