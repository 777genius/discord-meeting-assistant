import type {
  ConversationRuntimeEvent,
} from "@discord-meeting/meeting-core/conversation";
import { expect, vi } from "vitest";
import type {
  LiveConversationConfiguration,
  LiveConversationOneShotReceiptPort,
  LiveRuntimeLogger,
  LiveRuntimeTimer,
} from "../src/live-runtime/contracts.js";
import { ParticipantGreetingBridge } from "../src/live-runtime/participant-greeting-bridge.js";
import { MemoryOneShotReceipts } from "./participant-greeting-receipt-memory.js";

export const [russianParticipantId, englishParticipantId] = [
  "1533224474609057795",
  "2533224474609057795",
];
export const unknownParticipantId = "3533224474609057795";
export const excludedParticipantId = "4533224474609057795";
export const secondUnknownParticipantId = "5533224474609057795";
export const secondKnownParticipantId = "6533224474609057795";
export const occurredAt = "1970-01-01T00:00:00.321Z";

export const testTimer: LiveRuntimeTimer = {
  cancel: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  repeat: (intervalMs, callback) => {
    const handle = setInterval(callback, intervalMs);
    handle.unref();
    return handle;
  },
  schedule: (delayMs, callback) => {
    const handle = setTimeout(callback, delayMs);
    handle.unref();
    return handle;
  },
};

export class GreetingCoordinatorProbe {
  public readonly calls: Array<{
    readonly interruptible?: boolean;
    readonly locale: string;
    readonly literalSpeech?: string;
    readonly meetingId: string;
    readonly nowMs: number;
    readonly prompt: string;
    readonly recordingId: string;
    readonly speakerId: string;
    readonly systemPrompt: string;
    readonly turnId: string;
    readonly voiceProfileId: string;
  }> = [];
  public idleCalls = 0;
  public readonly preparedCalls: unknown[] = [];
  public onPlaybackSettlement: ((turnId: string) => void) | undefined;
  public readonly outcomes: Array<{ readonly status: "active" | "busy" }> = [];
  public readonly playbackSettlements: Array<
    "played" | "unplayed" | "partial" | "unknown"
  > = [];

  public advanceMeeting(): void {}

  public closeMeeting(): Promise<void> {
    return Promise.resolve();
  }

  public disconnectMeeting(): Promise<void> {
    return Promise.resolve();
  }

  public handleFinalizedTurn(): Promise<{ readonly status: "ignored" }> {
    return Promise.resolve({ status: "ignored" });
  }

  public handleProactiveTurn(input: (typeof this.calls)[number]) {
    this.calls.push(structuredClone(input));
    return Promise.resolve(this.outcomes.shift() ?? { status: "active" as const });
  }

  public playPreparedCue(input: unknown): Promise<{ readonly status: "active" }> {
    this.preparedCalls.push(structuredClone(input));
    return Promise.resolve({ status: "active" });
  }

  public speechActivity(): Promise<{ readonly status: "ignored" }> {
    return Promise.resolve({ status: "ignored" });
  }

  public speechEnded(): Promise<{ readonly status: "ignored" }> {
    return Promise.resolve({ status: "ignored" });
  }

  public speechStarted(): Promise<{ readonly status: "ignored" }> {
    return Promise.resolve({ status: "ignored" });
  }

  public whenIdle(): Promise<void> {
    this.idleCalls += 1;
    return Promise.resolve();
  }

  public whenTurnPlaybackStarted() {
    return Promise.resolve(
      this.playbackSettlements[0] === "unplayed"
        ? { status: "unplayed" as const }
        : { startedAtMs: 321, status: "started" as const },
    );
  }

  public async whenTurnPlaybackSettled(_meetingId: string, turnId: string) {
    await this.whenIdle();
    this.onPlaybackSettlement?.(turnId);
    return this.playbackSettlements.shift() ?? "played";
  }
}

export const logger: LiveRuntimeLogger = {
  debug: () => {},
  error: () => {},
  info: () => {},
  warn: () => {},
};

export function fixture(
  playbackReady = false,
  defaultLocale: "en" | "ru" = "ru",
  runtimeLogger: LiveRuntimeLogger = logger,
  nowMilliseconds: () => number = () => 321,
  cueSelector?: (input: {
    readonly locale: "en" | "ru";
    readonly meetingId: string;
    readonly participantId: string;
    readonly speech: string;
    readonly voiceProfileId: string;
  }) => {
    readonly cueId: string;
    readonly pcmChunks: readonly Uint8Array[];
    readonly playbackAttemptId: string;
  } | null,
  options: {
    readonly conversationLocale?: string;
    readonly oneShotReceipts?: LiveConversationOneShotReceiptPort;
  } = {},
): {
  readonly bridge: ParticipantGreetingBridge;
  readonly coordinator: GreetingCoordinatorProbe;
  setPlaybackReady(value: boolean): void;
} {
  let ready = playbackReady;
  const coordinator = new GreetingCoordinatorProbe();
  const configuration: LiveConversationConfiguration = {
    coordinator,
    greetings: {
      ...(cueSelector === undefined ? {} : { cues: { select: cueSelector } }),
      defaultLocale,
      excludedParticipantIds: [excludedParticipantId],
      isPlaybackReady: () => ready,
      profiles: {
        [englishParticipantId]: {
          displayName: "Alex Smith",
          greetingLocale: "en",
          spokenName: "Alex",
        },
        [russianParticipantId]: {
          displayName: "Александр Смирнов",
          greetingLocale: "ru",
          spokenName: "Саша",
        },
        [secondKnownParticipantId]: {
          displayName: "Maria Jones",
          greetingLocale: "en",
          spokenName: "Maria",
        },
      },
    },
    locale: options.conversationLocale ?? "auto",
    nowMilliseconds,
    ...(options.oneShotReceipts === undefined
      ? {}
      : { oneShotReceipts: options.oneShotReceipts }),
    systemPrompt: "Answer briefly.",
    voiceProfileId: "voice-profile",
  };
  return {
    bridge: new ParticipantGreetingBridge({
      configuration,
      isMeetingFinishing: () => false,
      logger: runtimeLogger,
      meetingId: "recording-1",
      timer: testTimer,
    }),
    coordinator,
    setPlaybackReady(value) {
      ready = value;
    },
  };
}

export async function* failedWithoutAudioEvents(
  attemptId: string,
): AsyncGenerator<ConversationRuntimeEvent> {
  yield { attemptId, type: "accepted" };
  yield {
    attemptId,
    failure: {
      code: "pipecat-pipeline-failed",
      message: "synthesis completed without audio",
      retryable: true,
    },
    type: "failed",
  };
}

export async function advanceAndSettle(
  bridge: ParticipantGreetingBridge,
  tickCount: number,
): Promise<void> {
  for (let tick = 0; tick < tickCount; tick += 1) {
    bridge.advance();
    await bridge.settle();
  }
}

export async function survivesCrashAfterProviderInvocation(): Promise<void> {
  const receipts = new MemoryOneShotReceipts();
  const context = fixture(true, "ru", logger, () => 321, undefined, {
    oneShotReceipts: receipts,
  });
  context.coordinator.handleProactiveTurn = (input) => {
    expect(receipts.state("greeting", "recording-1", russianParticipantId))
      .toBe("attempted");
    context.coordinator.calls.push(structuredClone(input));
    return Promise.resolve({ status: "active" as const });
  };
  context.coordinator.whenTurnPlaybackStarted = () => new Promise<never>(() => {});
  context.coordinator.whenTurnPlaybackSettled = () => new Promise<never>(() => {});

  context.bridge.participantJoined(russianParticipantId, occurredAt);
  const abandonedDrain = context.bridge.settle();
  await vi.waitFor(() => {
    expect(context.coordinator.calls).toHaveLength(1);
  });

  // Simulate process loss after the irreversible provider call, followed by a
  // restart beyond the old reservation lease.
  receipts.expireReservations();
  const restarted = fixture(true, "ru", logger, () => 654, undefined, {
    oneShotReceipts: receipts,
  });
  restarted.bridge.participantsRestored([russianParticipantId], occurredAt);
  await restarted.bridge.settle();

  expect(receipts.state("greeting", "recording-1", russianParticipantId))
    .toBe("attempted");
  expect(restarted.coordinator.calls).toEqual([]);
  context.bridge.close();
  await abandonedDrain;
}

export async function emitsNoAudioWhenAdmissionCommitFails(): Promise<void> {
  const release = vi.fn(() => Promise.resolve());
  const receipts: LiveConversationOneShotReceiptPort = {
    complete: () => Promise.reject(new Error("synthetic durable commit failure")),
    release,
    reserve: () => Promise.resolve({ leaseToken: "lease-1", status: "reserved" }),
  };
  const context = fixture(true, "ru", logger, () => 321, undefined, {
    oneShotReceipts: receipts,
  });

  context.bridge.participantJoined(russianParticipantId, occurredAt);
  await context.bridge.settle();

  expect(context.coordinator.calls).toEqual([]);
  expect(context.coordinator.preparedCalls).toEqual([]);
  expect(release).not.toHaveBeenCalled();
}

export async function fencesThrownAdmissionOutcome(): Promise<void> {
  const receipts = new MemoryOneShotReceipts();
  const context = fixture(true, "ru", logger, () => 321, undefined, {
    oneShotReceipts: receipts,
  });
  let rejectAdmission: (() => void) | undefined;
  context.coordinator.handleProactiveTurn = (input) => {
    context.coordinator.calls.push(structuredClone(input));
    return new Promise((_resolve, reject) => {
      rejectAdmission = () => {
        reject(new Error("synthetic runtime failure"));
      };
    });
  };

  context.bridge.participantJoined(russianParticipantId, occurredAt);
  const draining = context.bridge.settle();
  await vi.waitFor(() => {
    expect(context.coordinator.calls).toHaveLength(1);
  });
  receipts.expireReservations();
  rejectAdmission?.();
  await draining;
  expect(receipts.state("greeting", "recording-1", russianParticipantId))
    .toBe("suppressed_ambiguous");
  const restarted = fixture(true, "ru", logger, () => 9_999, undefined, {
    oneShotReceipts: receipts,
  });
  restarted.bridge.participantsRestored([russianParticipantId], occurredAt);
  await restarted.bridge.settle();

  expect(context.coordinator.calls).toHaveLength(1);
  expect(restarted.coordinator.calls).toEqual([]);
}

export async function clearsGreetingsOnLifecycleEnd(
  operation: "left" | "close",
): Promise<void> {
  const initial = fixture(false);
  initial.bridge.participantsPresent([russianParticipantId], occurredAt);
  if (operation === "left") {
    initial.bridge.participantLeft(russianParticipantId);
  } else {
    initial.bridge.close();
  }
  initial.setPlaybackReady(true);
  initial.bridge.advance();
  await initial.bridge.settle();
  expect(initial.coordinator.calls).toEqual([]);

  const deferred = fixture(true);
  deferred.coordinator.outcomes.push({ status: "busy" });
  deferred.bridge.participantJoined(russianParticipantId, occurredAt);
  await deferred.bridge.settle();
  if (operation === "left") {
    deferred.bridge.participantLeft(russianParticipantId);
  } else {
    deferred.bridge.close();
  }
  deferred.bridge.advance();
  await deferred.bridge.settle();
  expect(deferred.coordinator.calls).toHaveLength(1);
}

export async function skipsParticipantWhoLeftBeforePlayback(): Promise<void> {
  const context = fixture();

  context.bridge.participantJoined(englishParticipantId, occurredAt);
  context.bridge.participantLeft(englishParticipantId);
  context.setPlaybackReady(true);
  context.bridge.advance();
  await context.bridge.settle();
  expect(context.coordinator.calls).toEqual([]);

  context.bridge.participantJoined(englishParticipantId, occurredAt);
  await context.bridge.settle();
  expect(context.coordinator.calls).toHaveLength(1);
}

export async function dropsQueuedGreetingsWhenMeetingCloses(): Promise<void> {
  const context = fixture();

  context.bridge.participantJoined(russianParticipantId, occurredAt);
  context.bridge.close();
  context.setPlaybackReady(true);
  context.bridge.advance();
  await context.bridge.settle();

  expect(context.coordinator.calls).toEqual([]);
}

export async function doesNotMistakeRestorationForPlayback(): Promise<void> {
  const context = fixture(true);

  context.bridge.participantsRestored([
    russianParticipantId,
    unknownParticipantId,
  ], occurredAt);
  context.bridge.participantLeft(russianParticipantId);
  context.bridge.participantJoined(russianParticipantId, occurredAt);
  context.bridge.participantJoined(englishParticipantId, occurredAt);
  await context.bridge.settle();

  expect(context.coordinator.calls.map(({ speakerId }) => speakerId)).toEqual([
    unknownParticipantId,
    russianParticipantId,
    englishParticipantId,
  ]);
}

export async function playsMatchingPreparedGreeting(): Promise<void> {
  const pcmChunks = [Uint8Array.of(1, 2), Uint8Array.of(3, 4)];
  const context = fixture(
    true,
    "ru",
    logger,
    () => 321,
    () => ({
      cueId: "greeting-ru-sasha-v1",
      pcmChunks,
      playbackAttemptId: "greeting-attempt-1",
    }),
  );

  context.bridge.participantJoined(russianParticipantId, occurredAt);
  await context.bridge.settle();

  expect(context.coordinator.calls).toEqual([]);
  expect(context.coordinator.preparedCalls).toEqual([{
    cueId: "greeting-ru-sasha-v1",
    interruptible: false,
    locale: "ru",
    meetingId: "recording-1",
    nowMs: 321,
    pcmChunks,
    playbackAttemptId: "greeting-attempt-1",
    preemptive: false,
    recordingId: "recording-1",
    speakerId: russianParticipantId,
    turnId: `participant-greeting:${russianParticipantId}`,
    voiceProfileId: "voice-profile",
  }]);
}

export async function usesConfiguredEnglishFallback(): Promise<void> {
  const context = fixture(true, "en");

  context.bridge.participantJoined(unknownParticipantId, occurredAt);
  await context.bridge.settle();

  expect(context.coordinator.calls).toHaveLength(1);
  expect(context.coordinator.calls[0]).toMatchObject({
    locale: "en",
    prompt: "Hi!",
    speakerId: unknownParticipantId,
  });
}
