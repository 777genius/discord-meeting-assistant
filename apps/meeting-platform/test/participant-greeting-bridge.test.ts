import { describe, expect, it, vi } from "vitest";

import { ConversationCoordinator, type ConversationRuntime,
  type VoicePlaybackPort } from "@discord-meeting/meeting-core/conversation";
import { ParticipantGreetingBridge } from "../src/live-runtime/participant-greeting-bridge.js";
import {
  advanceAndSettle,
  clearsGreetingsOnLifecycleEnd,
  doesNotMistakeRestorationForPlayback,
  dropsQueuedGreetingsWhenMeetingCloses,
  emitsNoAudioWhenAdmissionCommitFails,
  englishParticipantId,
  excludedParticipantId,
  failedWithoutAudioEvents,
  fencesThrownAdmissionOutcome,
  fixture,
  logger,
  occurredAt,
  playsMatchingPreparedGreeting,
  russianParticipantId,
  secondKnownParticipantId,
  secondUnknownParticipantId,
  skipsParticipantWhoLeftBeforePlayback,
  survivesCrashAfterProviderInvocation,
  testTimer,
  unknownParticipantId,
  usesConfiguredEnglishFallback,
} from "./participant-greeting-bridge.support.js";
import { MemoryOneShotReceipts } from "./participant-greeting-receipt-memory.js";

describe("ParticipantGreetingBridge", () => {
  it("uses a completed durable receipt to suppress greeting replay after restart", async () => {
    const receipts = new MemoryOneShotReceipts();
    const first = fixture(true, "en", logger, () => 321, undefined, {
      oneShotReceipts: receipts,
    });
    first.bridge.participantJoined(englishParticipantId, occurredAt);
    await first.bridge.settle();
    expect(first.coordinator.calls).toHaveLength(1);
    expect(receipts.state("greeting", "recording-1", englishParticipantId))
      .toBe("completed");

    const restarted = fixture(
      true,
      "en",
      logger,
      () => 654,
      undefined,
      { oneShotReceipts: receipts },
    );
    restarted.bridge.participantsRestored([englishParticipantId], occurredAt);
    await restarted.bridge.settle();

    expect(restarted.coordinator.calls).toEqual([]);
  });

  it.each([
    ["en-US", "en", "Hi!"],
    ["ru-RU", "ru", "Привет!"],
  ] as const)("selects a prepared anonymous %s greeting from the conversation locale", async (
    conversationLocale,
    expectedLocale,
    expectedSpeech,
  ) => {
    const selections: Array<{ readonly locale: "en" | "ru"; readonly speech: string }> = [];
    const context = fixture(true, "en", logger, () => 321, (selection) => {
      selections.push({ locale: selection.locale, speech: selection.speech });
      return {
        cueId: `anonymous-${selection.locale}-v1`,
        pcmChunks: [Uint8Array.of(1, 2)],
        playbackAttemptId: `anonymous-${selection.locale}-attempt-1`,
      };
    }, { conversationLocale });
    context.bridge.participantJoined(unknownParticipantId, occurredAt);
    await context.bridge.settle();
    expect(context.coordinator.calls).toEqual([]);
    expect(context.coordinator.preparedCalls[0]).toMatchObject({
      cueId: `anonymous-${expectedLocale}-v1`,
      locale: expectedLocale,
    });
    expect(selections).toEqual([{ locale: expectedLocale, speech: expectedSpeech }]);
  });

  it("uses an anonymous fallback only after the named attempt proves no audio", async () => {
    const selectedSpeech: string[] = [];
    const context = fixture(true, "ru", logger, () => 321, (selection) => {
      selectedSpeech.push(selection.speech);
      return selection.speech === "Привет!"
        ? {
            cueId: "anonymous-ru-v1",
            pcmChunks: [Uint8Array.of(1, 2)],
            playbackAttemptId: "anonymous-attempt-1",
          }
        : null;
    });
    context.coordinator.playbackSettlements.push("unplayed", "played");

    context.bridge.participantJoined(russianParticipantId, occurredAt);
    await context.bridge.settle();

    expect(selectedSpeech).toEqual(["Привет, Саша!", "Привет!"]);
    expect(context.coordinator.calls).toHaveLength(1);
    expect(context.coordinator.calls[0]).toMatchObject({
      literalSpeech: "Привет, Саша!",
      prompt: "Привет, Саша!",
    });
    expect(context.coordinator.preparedCalls[0]).toMatchObject({
      cueId: "anonymous-ru-v1",
      turnId: `participant-greeting:${russianParticipantId}:anonymous-fallback`,
    });
  });

  it.each(["partial", "unknown"] as const)(
    "does not replay or use an anonymous fallback after a %s playback outcome",
    async (outcome) => {
      const selectedSpeech: string[] = [];
      const receipts = new MemoryOneShotReceipts();
      const context = fixture(true, "ru", logger, () => 321, (selection) => {
        selectedSpeech.push(selection.speech);
        return selection.speech === "Привет!"
          ? {
              cueId: "anonymous-ru-v1",
              pcmChunks: [Uint8Array.of(1, 2)],
            playbackAttemptId: "anonymous-attempt-1",
          }
        : null;
      }, { oneShotReceipts: receipts });
      context.coordinator.playbackSettlements.push(outcome);

      context.bridge.participantJoined(russianParticipantId, occurredAt);
      await context.bridge.settle();

      expect(selectedSpeech).toEqual(["Привет, Саша!"]);
      expect(context.coordinator.calls).toHaveLength(1);
      expect(context.coordinator.preparedCalls).toEqual([]);
      expect(receipts.state("greeting", "recording-1", russianParticipantId))
        .toBe("completed");

      receipts.expireReservations();
      const restarted = fixture(true, "ru", logger, () => 654, undefined, {
        oneShotReceipts: receipts,
      });
      restarted.bridge.participantsRestored([russianParticipantId], occurredAt);
      await restarted.bridge.settle();

      expect(restarted.coordinator.calls).toEqual([]);
      expect(restarted.coordinator.preparedCalls).toEqual([]);
    },
  );

  it("waits for playback and speaks named or default-locale greetings", async () => {
    const context = fixture();

    context.bridge.participantsPresent([
      russianParticipantId,
      unknownParticipantId,
      excludedParticipantId,
      englishParticipantId,
    ], occurredAt);
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

});

describe("ParticipantGreetingBridge ordering and observability", () => {

  it("preserves FIFO order within initial and high-priority lanes", async () => {
    const context = fixture(true);

    context.bridge.participantsPresent([
      russianParticipantId,
      unknownParticipantId,
      englishParticipantId,
      secondUnknownParticipantId,
    ], occurredAt);
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
        context.bridge.participantJoined(englishParticipantId, occurredAt);
      }
    };

    context.bridge.participantsPresent([
      russianParticipantId,
      secondKnownParticipantId,
    ], occurredAt);
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
        context.bridge.participantJoined(liveParticipantIds[0] ?? "", occurredAt);
      } else if (completedLiveIndex >= 0) {
        const nextParticipantId = liveParticipantIds[completedLiveIndex + 1];
        if (nextParticipantId !== undefined) {
          context.bridge.participantJoined(nextParticipantId, occurredAt);
        }
      }
    };

    context.bridge.participantsPresent([
      russianParticipantId,
      englishParticipantId,
    ], occurredAt);
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

    context.bridge.participantJoined(russianParticipantId, occurredAt);
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
});

describe("ParticipantGreetingBridge reconnect and retry semantics", () => {
  it.each([
    { participantId: russianParticipantId, profile: "named" },
    { participantId: unknownParticipantId, profile: "anonymous" },
  ])("greets a $profile participant only once after reconnecting", async ({
    participantId,
  }) => {
    const receipts = new MemoryOneShotReceipts();
    const context = fixture(true, "ru", logger, () => 321, undefined, {
      oneShotReceipts: receipts,
    });

    context.bridge.participantJoined(participantId, occurredAt);
    await context.bridge.settle();
    expect(receipts.state("greeting", "recording-1", participantId)).toBe("completed");
    context.bridge.participantLeft(participantId);
    context.bridge.participantJoined(participantId, occurredAt);
    await context.bridge.settle();

    expect(context.coordinator.calls).toHaveLength(1);
  });
});

describe("ParticipantGreetingBridge retry admission", () => {
  it.each(["busy", "unplayed"] as const)(
    "retries after explicit %s evidence without bypassing the durable fence",
    async (evidence) => {
      const receipts = new MemoryOneShotReceipts();
      const reserve = vi.spyOn(receipts, "reserve");
      const complete = vi.spyOn(receipts, "complete");
      const context = fixture(true, "ru", logger, () => 321, undefined, {
        oneShotReceipts: receipts,
      });
      if (evidence === "busy") {
        context.coordinator.outcomes.push({ status: "busy" });
      } else {
        context.coordinator.playbackSettlements.push("unplayed");
      }

      context.bridge.participantJoined(russianParticipantId, occurredAt);
      await context.bridge.settle();

      expect(context.coordinator.calls).toHaveLength(1);
      expect(receipts.state("greeting", "recording-1", russianParticipantId))
        .toBe("completed");
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(complete).toHaveBeenCalledTimes(1);

      // Repeated presence alone is not retry evidence and cannot release the deferred turn.
      context.bridge.participantJoined(russianParticipantId, occurredAt);
      await context.bridge.settle();
      expect(context.coordinator.calls).toHaveLength(1);

      context.bridge.advance();
      await context.bridge.settle();

      expect(context.coordinator.calls.map(({ turnId }) => turnId)).toEqual([
        `participant-greeting:${russianParticipantId}`,
        `participant-greeting:${russianParticipantId}:retry-1`,
      ]);
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(complete).toHaveBeenCalledTimes(1);

      context.bridge.participantLeft(russianParticipantId);
      context.bridge.participantJoined(russianParticipantId, occurredAt);
      await context.bridge.settle();
      expect(context.coordinator.calls).toHaveLength(2);

      receipts.expireReservations();
      const restarted = fixture(true, "ru", logger, () => 654, undefined, {
        oneShotReceipts: receipts,
      });
      restarted.bridge.participantsRestored([russianParticipantId], occurredAt);
      await restarted.bridge.settle();

      expect(restarted.coordinator.calls).toEqual([]);
      expect(reserve).toHaveBeenCalledTimes(2);
      expect(complete).toHaveBeenCalledTimes(1);
    },
  );

  it("retries a provably unadmitted busy greeting without risking a duplicate", async () => {
    const context = fixture(true);
    context.coordinator.outcomes.push({ status: "busy" }, { status: "active" });

    context.bridge.participantJoined(russianParticipantId, occurredAt);
    await context.bridge.settle();

    expect(context.coordinator.calls).toHaveLength(1);
    context.bridge.participantJoined(russianParticipantId, occurredAt);
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
    context.bridge.participantJoined(russianParticipantId, occurredAt);
    await context.bridge.settle();
    expect(context.coordinator.calls).toHaveLength(2);
  });

  it("preserves an initial retry lane when a high-priority join waits for the tick", async () => {
    const context = fixture(true);
    context.coordinator.outcomes.push({ status: "busy" });

    context.bridge.participantsPresent([
      russianParticipantId,
      englishParticipantId,
    ], occurredAt);
    await context.bridge.settle();
    context.setPlaybackReady(false);
    context.bridge.participantJoined(unknownParticipantId, occurredAt);
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

    context.bridge.participantJoined(russianParticipantId, occurredAt);
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

    context.bridge.participantJoined(russianParticipantId, occurredAt);
    await context.bridge.settle();
    await advanceAndSettle(context.bridge, 3);
    context.bridge.participantLeft(russianParticipantId);
    context.bridge.participantJoined(russianParticipantId, occurredAt);
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
        context.bridge.participantJoined(englishParticipantId, occurredAt);
      }
    };

    context.bridge.participantJoined(russianParticipantId, occurredAt);
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
      timer: testTimer,
    });

    bridge.participantJoined(russianParticipantId, occurredAt);
    await bridge.settle();
    await advanceAndSettle(bridge, 3);
    bridge.participantLeft(russianParticipantId);
    bridge.participantJoined(russianParticipantId, occurredAt);
    await bridge.settle();

    expect(runtimeTurnIds).toEqual([
      `participant-greeting:${russianParticipantId}`,
      `participant-greeting:${russianParticipantId}:retry-1`,
      `participant-greeting:${russianParticipantId}:retry-2`,
      `participant-greeting:${russianParticipantId}:retry-3`,
    ]);
    expect(warnCalls).toEqual(["Participant greeting retries exhausted"]);
  });

  it(
    "survives a crash after provider invocation with never-settling playback",
    survivesCrashAfterProviderInvocation,
  );

  it(
    "emits no audio when the durable admission commit fails",
    emitsNoAudioWhenAdmissionCommitFails,
  );

  it(
    "durably fences a thrown admission outcome across restart and lease expiry",
    fencesThrownAdmissionOutcome,
  );

});

describe("ParticipantGreetingBridge lifecycle fencing", () => {
  it.each(["left", "close"] as const)(
    "clears initial and deferred greetings on participant %s",
    clearsGreetingsOnLifecycleEnd,
  );

  it(
    "does not greet someone who left before playback became ready",
    skipsParticipantWhoLeftBeforePlayback,
  );

  it("drops queued greetings when the meeting closes", dropsQueuedGreetingsWhenMeetingCloses);
});

it("does not mistake process restoration for successful playback", doesNotMistakeRestorationForPlayback);

it("plays a matching prepared greeting without invoking the TTS runtime", playsMatchingPreparedGreeting);

it("uses the configured English fallback without inventing a name", usesConfiguredEnglishFallback);
