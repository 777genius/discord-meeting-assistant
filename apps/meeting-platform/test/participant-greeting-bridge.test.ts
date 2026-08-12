import { describe, expect, it } from "vitest";

import {
  ConversationCoordinator,
  type ConversationRuntime,
  type ConversationRuntimeEvent,
  type VoicePlaybackPort,
} from "@discord-meeting/meeting-core/conversation";

import type {
  LiveConversationConfiguration,
  LiveRuntimeLogger,
} from "../src/live-runtime/contracts.js";
import { ParticipantGreetingBridge } from "../src/live-runtime/participant-greeting-bridge.js";

const russianParticipantId = "1533224474609057795";
const englishParticipantId = "2533224474609057795";
const unknownParticipantId = "3533224474609057795";
const excludedParticipantId = "4533224474609057795";
const secondUnknownParticipantId = "5533224474609057795";
const secondKnownParticipantId = "6533224474609057795";

class GreetingCoordinatorProbe {
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
  public readonly playbackSettlements: Array<"played" | "unplayed" | "partial" | "unknown"> = [];

  public advanceMeeting(): void {}

  public closeMeeting(): Promise<void> {
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

  public async whenTurnPlaybackSettled(_meetingId: string, turnId: string) {
    await this.whenIdle();
    this.onPlaybackSettlement?.(turnId);
    return this.playbackSettlements.shift() ?? "played";
  }
}

const logger: LiveRuntimeLogger = {
  debug: () => {},
  error: () => {},
  info: () => {},
  warn: () => {},
};

function fixture(
  playbackReady = false,
  defaultLocale: "en" | "ru" = "ru",
  runtimeLogger: LiveRuntimeLogger = logger,
  nowMilliseconds: () => number = () => 321,
  cueSelector?: () => {
    readonly cueId: string;
    readonly pcmChunks: readonly Uint8Array[];
    readonly playbackAttemptId: string;
  } | null,
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
      ...(cueSelector === undefined
        ? {}
        : { cues: { select: cueSelector } }),
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
    locale: "auto",
    nowMilliseconds,
    systemPrompt: "Answer briefly.",
    voiceProfileId: "voice-profile",
  };
  return {
    bridge: new ParticipantGreetingBridge({
      configuration,
      isMeetingFinishing: () => false,
      logger: runtimeLogger,
      meetingId: "recording-1",
    }),
    coordinator,
    setPlaybackReady(value) {
      ready = value;
    },
  };
}

describe("ParticipantGreetingBridge", () => {
  it("waits for playback and speaks named or default-locale greetings", async () => {
    const context = fixture();

    context.bridge.participantsPresent([
      russianParticipantId,
      unknownParticipantId,
      excludedParticipantId,
      englishParticipantId,
    ]);
    await context.bridge.settle();
    expect(context.coordinator.calls).toEqual([]);

    context.setPlaybackReady(true);
    context.bridge.advance();
    await context.bridge.settle();

    expect(context.coordinator.calls).toHaveLength(3);
    expect(context.coordinator.calls.map(({
      interruptible,
      locale,
      literalSpeech,
      prompt,
      speakerId,
    }) => ({
      interruptible,
      locale,
      literalSpeech,
      prompt,
      speakerId,
    }))).toEqual([
      {
        interruptible: false,
        locale: "ru",
        literalSpeech: "Привет!",
        prompt: "Привет!",
        speakerId: unknownParticipantId,
      },
      {
        interruptible: false,
        locale: "ru",
        literalSpeech: "Привет, Саша!",
        prompt: "Привет, Саша!",
        speakerId: russianParticipantId,
      },
      {
        interruptible: false,
        locale: "en",
        literalSpeech: "Hi, Alex!",
        prompt: "Hi, Alex!",
        speakerId: englishParticipantId,
      },
    ]);
    expect(context.coordinator.calls[0]?.systemPrompt).toContain(
      "Speak exactly the greeting provided",
    );
    expect(context.coordinator.idleCalls).toBe(6);
  });

  it("preserves FIFO order within initial and high-priority lanes", async () => {
    const context = fixture(true);

    context.bridge.participantsPresent([
      russianParticipantId,
      unknownParticipantId,
      englishParticipantId,
      secondUnknownParticipantId,
    ]);
    await context.bridge.settle();

    expect(context.coordinator.calls.map(({ speakerId }) => speakerId)).toEqual([
      unknownParticipantId,
      secondUnknownParticipantId,
      russianParticipantId,
      englishParticipantId,
    ]);
  });

  it("admits a live join before remaining initial greetings after current playback", async () => {
    const context = fixture(true);
    context.coordinator.onPlaybackSettlement = (turnId) => {
      if (turnId === `participant-greeting:${russianParticipantId}`) {
        context.bridge.participantJoined(englishParticipantId);
      }
    };

    context.bridge.participantsPresent([
      russianParticipantId,
      secondKnownParticipantId,
    ]);
    await context.bridge.settle();

    expect(context.coordinator.calls.map(({ speakerId }) => speakerId)).toEqual([
      russianParticipantId,
      englishParticipantId,
      secondKnownParticipantId,
    ]);
  });

  it("admits one initial greeting after three consecutive live high-priority joins", async () => {
    const context = fixture(true);
    const liveParticipantIds = [
      "live-unknown-1",
      "live-unknown-2",
      "live-unknown-3",
      "live-unknown-4",
      "live-unknown-5",
    ];
    context.coordinator.onPlaybackSettlement = (turnId) => {
      const completedLiveIndex = liveParticipantIds.findIndex(
        (participantId) => turnId === `participant-greeting:${participantId}`,
      );
      if (turnId === `participant-greeting:${russianParticipantId}`) {
        context.bridge.participantJoined(liveParticipantIds[0] ?? "");
      } else if (completedLiveIndex >= 0) {
        const nextParticipantId = liveParticipantIds[completedLiveIndex + 1];
        if (nextParticipantId !== undefined) {
          context.bridge.participantJoined(nextParticipantId);
        }
      }
    };

    context.bridge.participantsPresent([
      russianParticipantId,
      englishParticipantId,
    ]);
    await context.bridge.settle();

    expect(context.coordinator.calls.map(({ speakerId }) => speakerId)).toEqual([
      russianParticipantId,
      ...liveParticipantIds.slice(0, 3),
      englishParticipantId,
      ...liveParticipantIds.slice(3),
    ]);
  });

  it("logs only privacy-safe greeting completion metadata", async () => {
    const infoCalls: Array<{
      readonly fields: Readonly<Record<string, unknown>> | undefined;
      readonly message: string;
    }> = [];
    let nowMs = 321;
    const context = fixture(true, "ru", {
      ...logger,
      info: (message, fields) => {
        infoCalls.push({ fields, message });
      },
    }, () => nowMs);
    let markIdleEntered: (() => void) | undefined;
    const idleEntered = new Promise<void>((resolve) => {
      markIdleEntered = resolve;
    });
    let releaseIdle: (() => void) | undefined;
    const idleGate = new Promise<void>((resolve) => {
      releaseIdle = resolve;
    });
    context.coordinator.whenIdle = () => {
      context.coordinator.idleCalls += 1;
      markIdleEntered?.();
      return idleGate;
    };

    context.bridge.participantJoined(russianParticipantId);
    const settlement = context.bridge.settle();
    await idleEntered;
    expect(infoCalls).toEqual([]);
    nowMs = 654;
    releaseIdle?.();
    await settlement;

    expect(infoCalls).toEqual([{
      fields: {
        greetingLocale: "ru",
        meetingId: "recording-1",
        participantId: russianParticipantId,
        participantNameStatus: "known",
        observedJoinToPlaybackSettledMs: 333,
        playbackMode: "tts-fallback",
        turnId: `participant-greeting:${russianParticipantId}`,
      },
      message: "Participant greeting playback settled",
    }]);
    expect(JSON.stringify(infoCalls)).not.toContain("Саша");
    expect(JSON.stringify(infoCalls)).not.toContain("Привет");
  });

  it.each([
    { participantId: russianParticipantId, profile: "named" },
    { participantId: unknownParticipantId, profile: "anonymous" },
  ])("greets a $profile participant only once after reconnecting", async ({
    participantId,
  }) => {
    const context = fixture(true);

    context.bridge.participantJoined(participantId);
    await context.bridge.settle();
    context.bridge.participantLeft(participantId);
    context.bridge.participantJoined(participantId);
    await context.bridge.settle();

    expect(context.coordinator.calls).toHaveLength(1);
  });
});

describe("ParticipantGreetingBridge retry admission", () => {
  it("retries a provably unadmitted busy greeting without risking a duplicate", async () => {
    const context = fixture(true);
    context.coordinator.outcomes.push({ status: "busy" }, { status: "active" });

    context.bridge.participantJoined(russianParticipantId);
    await context.bridge.settle();

    expect(context.coordinator.calls).toHaveLength(1);
    context.bridge.participantJoined(russianParticipantId);
    await context.bridge.settle();
    expect(context.coordinator.calls).toHaveLength(1);

    context.bridge.advance();
    await context.bridge.settle();

    expect(context.coordinator.calls).toHaveLength(2);
    expect(context.coordinator.calls.map(({ prompt }) => prompt)).toEqual([
      "Привет, Саша!",
      "Привет, Саша!",
    ]);
    expect(context.coordinator.calls.map(({ turnId }) => turnId)).toEqual([
      `participant-greeting:${russianParticipantId}`,
      `participant-greeting:${russianParticipantId}:retry-1`,
    ]);

    context.bridge.participantLeft(russianParticipantId);
    context.bridge.participantJoined(russianParticipantId);
    await context.bridge.settle();
    expect(context.coordinator.calls).toHaveLength(2);
  });

  it("preserves an initial retry lane when a high-priority join waits for the tick", async () => {
    const context = fixture(true);
    context.coordinator.outcomes.push({ status: "busy" });

    context.bridge.participantsPresent([
      russianParticipantId,
      englishParticipantId,
    ]);
    await context.bridge.settle();
    context.setPlaybackReady(false);
    context.bridge.participantJoined(unknownParticipantId);
    await context.bridge.settle();

    context.setPlaybackReady(true);
    context.bridge.advance();
    await context.bridge.settle();

    expect(context.coordinator.calls.map(({ speakerId }) => speakerId)).toEqual([
      russianParticipantId,
      unknownParticipantId,
      englishParticipantId,
      russianParticipantId,
    ]);
  });

  it("retries a greeting only when the admitted turn produced no playback audio", async () => {
    const infoCalls: Array<Readonly<Record<string, unknown>> | undefined> = [];
    const context = fixture(true, "ru", {
      ...logger,
      info: (_message, fields) => infoCalls.push(fields),
    });
    context.coordinator.playbackSettlements.push("unplayed", "played");

    context.bridge.participantJoined(russianParticipantId);
    await context.bridge.settle();

    expect(context.coordinator.calls).toHaveLength(1);
    context.bridge.advance();
    await context.bridge.settle();

    expect(context.coordinator.calls.map(({ turnId }) => turnId)).toEqual([
      `participant-greeting:${russianParticipantId}`,
      `participant-greeting:${russianParticipantId}:retry-1`,
    ]);
    expect(infoCalls).toEqual([
      expect.objectContaining({
        turnId: `participant-greeting:${russianParticipantId}:retry-1`,
      }),
    ]);
  });

  it("stops after bounded empty-audio retries without publishing false evidence", async () => {
    const infoCalls: string[] = [];
    const warnCalls: string[] = [];
    const context = fixture(true, "ru", {
      ...logger,
      info: (message) => infoCalls.push(message),
      warn: (message) => warnCalls.push(message),
    });
    context.coordinator.playbackSettlements.push(
      "unplayed",
      "unplayed",
      "unplayed",
      "unplayed",
    );

    context.bridge.participantJoined(russianParticipantId);
    await context.bridge.settle();
    await advanceAndSettle(context.bridge, 3);
    context.bridge.participantLeft(russianParticipantId);
    context.bridge.participantJoined(russianParticipantId);
    await context.bridge.settle();
    await advanceAndSettle(context.bridge, 3);

    expect(context.coordinator.calls).toHaveLength(4);
    expect(infoCalls).toEqual([]);
    expect(warnCalls).toEqual(["Participant greeting retries exhausted"]);
  });

  it("continues greeting pending participants after one exhausts its retries", async () => {
    const warnCalls: string[] = [];
    const context = fixture(true, "ru", {
      ...logger,
      warn: (message) => warnCalls.push(message),
    });
    context.coordinator.playbackSettlements.push("unplayed", "unplayed", "unplayed", "unplayed");
    context.coordinator.onPlaybackSettlement = (turnId) => {
      if (turnId === `participant-greeting:${russianParticipantId}:retry-3`) {
        context.bridge.participantJoined(englishParticipantId);
      }
    };

    context.bridge.participantJoined(russianParticipantId);
    await context.bridge.settle();
    await advanceAndSettle(context.bridge, 3);

    expect(context.coordinator.calls.map(({ speakerId }) => speakerId)).toEqual([
      russianParticipantId,
      russianParticipantId,
      russianParticipantId,
      russianParticipantId,
      englishParticipantId,
    ]);
    expect(warnCalls).toEqual(["Participant greeting retries exhausted"]);
  });
});

describe("ParticipantGreetingBridge retries and lifecycle", () => {
  it("bounds retries after the real coordinator settles failed zero-audio turns as unplayed", async () => {
    const runtimeTurnIds: string[] = [];
    const runtime: ConversationRuntime = {
      startTurn: async (request) => {
        runtimeTurnIds.push(request.turnId);
        return {
          ok: true,
          value: {
            cancel: () => Promise.resolve(),
            events: failedWithoutAudioEvents(`attempt-${runtimeTurnIds.length}`),
          },
        };
      },
    };
    const playback: VoicePlaybackPort = {
      open: () => Promise.reject(new Error("zero-audio turns must not open playback")),
    };
    const coordinator = new ConversationCoordinator({ playback, runtime });
    const warnCalls: string[] = [];
    const bridge = new ParticipantGreetingBridge({
      configuration: {
        coordinator,
        greetings: {
          defaultLocale: "ru",
          excludedParticipantIds: [],
          isPlaybackReady: () => true,
          profiles: {
            [russianParticipantId]: {
              displayName: "Александр Смирнов",
              greetingLocale: "ru",
              spokenName: "Саша",
            },
          },
        },
        locale: "auto",
        nowMilliseconds: () => 321,
        systemPrompt: "Answer briefly.",
        voiceProfileId: "voice-profile",
      },
      isMeetingFinishing: () => false,
      logger: { ...logger, warn: (message) => warnCalls.push(message) },
      meetingId: "recording-1",
    });

    bridge.participantJoined(russianParticipantId);
    await bridge.settle();
    await advanceAndSettle(bridge, 3);
    bridge.participantLeft(russianParticipantId);
    bridge.participantJoined(russianParticipantId);
    await bridge.settle();

    expect(runtimeTurnIds).toEqual([
      `participant-greeting:${russianParticipantId}`,
      `participant-greeting:${russianParticipantId}:retry-1`,
      `participant-greeting:${russianParticipantId}:retry-2`,
      `participant-greeting:${russianParticipantId}:retry-3`,
    ]);
    expect(warnCalls).toEqual(["Participant greeting retries exhausted"]);
  });

  it.each(["partial", "unknown"] as const)(
    "does not retry or publish false evidence for a %s greeting",
    async (settlement) => {
      const infoCalls: string[] = [];
      const context = fixture(true, "ru", {
        ...logger,
        info: (message) => infoCalls.push(message),
      });
      context.coordinator.playbackSettlements.push(settlement);

      context.bridge.participantJoined(russianParticipantId);
      await context.bridge.settle();
      context.bridge.participantLeft(russianParticipantId);
      context.bridge.participantJoined(russianParticipantId);
      await context.bridge.settle();

      expect(context.coordinator.calls).toHaveLength(1);
      expect(infoCalls).toEqual([]);
    },
  );

  it("treats a thrown greeting failure as at-most-once", async () => {
    const context = fixture(true);
    context.coordinator.handleProactiveTurn = (input) => {
      context.coordinator.calls.push(structuredClone(input));
      return Promise.reject(new Error("synthetic runtime failure"));
    };

    context.bridge.participantJoined(russianParticipantId);
    await context.bridge.settle();
    context.bridge.participantLeft(russianParticipantId);
    context.bridge.participantJoined(russianParticipantId);
    await context.bridge.settle();
    context.bridge.advance();
    await context.bridge.settle();

    expect(context.coordinator.calls).toHaveLength(1);
  });

  it.each(["left", "close"] as const)(
    "clears initial and deferred greetings on participant %s",
    async (operation) => {
      const initial = fixture(false);
      initial.bridge.participantsPresent([russianParticipantId]);
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
      deferred.bridge.participantJoined(russianParticipantId);
      await deferred.bridge.settle();
      if (operation === "left") {
        deferred.bridge.participantLeft(russianParticipantId);
      } else {
        deferred.bridge.close();
      }
      deferred.bridge.advance();
      await deferred.bridge.settle();
      expect(deferred.coordinator.calls).toHaveLength(1);
    },
  );

  it("does not greet someone who left before playback became ready", async () => {
    const context = fixture();

    context.bridge.participantJoined(englishParticipantId);
    context.bridge.participantLeft(englishParticipantId);
    context.setPlaybackReady(true);
    context.bridge.advance();
    await context.bridge.settle();
    expect(context.coordinator.calls).toEqual([]);

    context.bridge.participantJoined(englishParticipantId);
    await context.bridge.settle();
    expect(context.coordinator.calls).toHaveLength(1);
  });

  it("drops queued greetings when the meeting closes", async () => {
    const context = fixture();

    context.bridge.participantJoined(russianParticipantId);
    context.bridge.close();
    context.setPlaybackReady(true);
    context.bridge.advance();
    await context.bridge.settle();

    expect(context.coordinator.calls).toEqual([]);
  });
});

it("suppresses restored participants even when they reconnect", async () => {
  const context = fixture(true);

  context.bridge.participantsRestored([
    russianParticipantId,
    unknownParticipantId,
  ]);
  context.bridge.participantLeft(russianParticipantId);
  context.bridge.participantJoined(russianParticipantId);
  context.bridge.participantJoined(englishParticipantId);
  await context.bridge.settle();

  expect(context.coordinator.calls.map(({ speakerId }) => speakerId)).toEqual([
    englishParticipantId,
  ]);
});

it("plays a matching prepared greeting without invoking the TTS runtime", async () => {
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

  context.bridge.participantJoined(russianParticipantId);
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
});

it("uses the configured English fallback without inventing a name", async () => {
  const context = fixture(true, "en");

  context.bridge.participantJoined(unknownParticipantId);
  await context.bridge.settle();

  expect(context.coordinator.calls).toHaveLength(1);
  expect(context.coordinator.calls[0]).toMatchObject({
    locale: "en",
    prompt: "Hi!",
    speakerId: unknownParticipantId,
  });
});

async function* failedWithoutAudioEvents(
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

async function advanceAndSettle(
  bridge: ParticipantGreetingBridge,
  tickCount: number,
): Promise<void> {
  for (let tick = 0; tick < tickCount; tick += 1) {
    bridge.advance();
    await bridge.settle();
  }
}
