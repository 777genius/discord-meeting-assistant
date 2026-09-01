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
  retriesCrashBeforeProviderConfirmedAudio,
  testTimer,
  unknownParticipantId,
  usesConfiguredEnglishFallback,
} from "./participant-greeting-bridge.support.js";
import { MemoryOneShotReceipts } from "./participant-greeting-receipt-memory.js";

const syntheticSevenParticipantProfiles = {
  "900000000000000001": {
    displayName: "Synthetic Alpha", greetingLocale: "ru", spokenName: "Тест Альфа",
  },
  "900000000000000002": {
    displayName: "Synthetic Beta", greetingLocale: "ru", spokenName: "Тест Бета",
  },
  "900000000000000003": {
    displayName: "Synthetic Gamma", greetingLocale: "ru", spokenName: "Тест Гамма",
  },
  "900000000000000004": {
    displayName: "Synthetic Delta", greetingLocale: "ru", spokenName: "Тест Дельта",
  },
  "900000000000000005": {
    displayName: "Synthetic Epsilon", greetingLocale: "ru", spokenName: "Тест Эпсилон",
  },
  "900000000000000006": {
    displayName: "Synthetic Zeta", greetingLocale: "ru", spokenName: "Тест Дзета",
  },
  "900000000000000007": {
    displayName: "Synthetic Eta", greetingLocale: "ru", spokenName: "Тест Эта",
  },
} as const;
const syntheticSevenParticipantIds = Object.keys(syntheticSevenParticipantProfiles);

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
      .toBe("played");

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
    expect(context.coordinator.preparedCalls[0]).toMatchObject({
      cueId: `anonymous-${expectedLocale}-v1`,
      locale: expectedLocale,
    });
    expect(selections).toEqual([{ locale: expectedLocale, speech: expectedSpeech }]);
  });

  it("uses the stable command for prepared fallback after provider-proven zero audio", async () => {
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
    context.coordinator.playbackSettlements.push("unplayed");

    context.bridge.participantJoined(russianParticipantId, occurredAt);
    await context.bridge.settle();

    expect(selectedSpeech).toEqual(["Привет, Саша!", "Привет!"]);
    expect(context.coordinator.calls).toHaveLength(1);
    expect(context.coordinator.calls[0]).toMatchObject({
      literalSpeech: "Привет, Саша!",
      prompt: "Привет, Саша!",
    });
    expect(context.coordinator.preparedCalls).toHaveLength(1);
    expect(context.coordinator.preparedCalls[0]).toMatchObject({
      playbackAttemptId: `participant-greeting:${russianParticipantId}`,
    });
  });

  it("falls back once to the prepared anonymous Russian cue when named literal TTS fails", async () => {
    const context = fixture(true, "ru", logger, () => 321, (selection) =>
      selection.speech === "Привет!"
        ? {
            cueId: "anonymous-ru-v1",
            pcmChunks: [Uint8Array.of(1, 2)],
            playbackAttemptId: "registry-id-is-not-the-command-id",
          }
        : null
    );
    context.coordinator.playbackSettlements.push("unplayed");

    context.bridge.participantJoined(russianParticipantId, occurredAt);
    await context.bridge.settle();

    expect(context.coordinator.calls).toHaveLength(1);
    expect(context.coordinator.preparedCalls).toHaveLength(1);
    expect(context.coordinator.preparedCalls[0]).toMatchObject({
      cueId: "anonymous-ru-v1",
      playbackAttemptId: `participant-greeting:${russianParticipantId}`,
      turnId: `participant-greeting:${russianParticipantId}:anonymous-fallback`,
    });
  });

  it("falls back once to the prepared anonymous cohort cue when mixed literal TTS fails", async () => {
    const context = fixture(true, "en", logger, () => 321, (selection) =>
      selection.speech === "Привет!"
        ? {
            cueId: "anonymous-ru-v1",
            pcmChunks: [Uint8Array.of(1, 2)],
            playbackAttemptId: "registry-id-is-not-the-command-id",
          }
        : null
    );
    context.coordinator.playbackSettlements.push("unplayed");

    context.bridge.participantsPresent(
      [russianParticipantId, englishParticipantId],
      occurredAt,
    );
    await context.bridge.settle();

    expect(context.coordinator.calls).toHaveLength(1);
    expect(context.coordinator.preparedCalls).toHaveLength(1);
    expect(context.coordinator.preparedCalls[0]).toMatchObject({
      cueId: "anonymous-ru-v1",
      playbackAttemptId: `participant-greeting:${russianParticipantId}`,
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

      expect(selectedSpeech).toEqual(["Привет, Саша!", "Привет!"]);
      expect(context.coordinator.calls).toHaveLength(1);
      expect(context.coordinator.preparedCalls).toEqual([]);
      expect(receipts.state("greeting", "recording-1", russianParticipantId))
        .toBe("suppressed_ambiguous");

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

    expect(context.coordinator.calls).toHaveLength(1);
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
        literalSpeech: "Привет, Саша, один гость! Hi, Alex!",
        prompt: "Привет, Саша, один гость! Hi, Alex!",
        speakerId: unknownParticipantId,
      },
    ]);
    expect(context.coordinator.calls[0]?.systemPrompt).toContain(
      "Speak exactly the greeting provided",
    );
    // Settlement may wait for its own provider task, but greeting admission
    // never waits on the conversation-wide idle barrier.
    expect(context.coordinator.idleCalls).toBe(1);
  });

});

// oxlint-disable-next-line max-lines-per-function
describe("ParticipantGreetingBridge ordering and observability", () => {

  it("greets all seven configured synthetic participants in one burst command", async () => {
    const receipts = new MemoryOneShotReceipts();
    const context = fixture(true, "ru", logger, () => 321, undefined, {
      greetingProfiles: syntheticSevenParticipantProfiles,
      oneShotReceipts: receipts,
    });

    context.bridge.participantsPresent(syntheticSevenParticipantIds, occurredAt);
    await context.bridge.settle();

    expect(context.coordinator.calls).toHaveLength(1);
    expect(context.coordinator.calls[0]).toMatchObject({
      locale: "ru",
      literalSpeech: "Привет, Тест Альфа, Тест Бета, Тест Гамма, Тест Дельта, Тест Эпсилон, Тест Дзета, Тест Эта!",
      prompt: "Привет, Тест Альфа, Тест Бета, Тест Гамма, Тест Дельта, Тест Эпсилон, Тест Дзета, Тест Эта!",
      speakerId: syntheticSevenParticipantIds[0],
    });
    expect(syntheticSevenParticipantIds.map((participantId) =>
      receipts.state("greeting", "recording-1", participantId)
    )).toEqual(Array.from({ length: 7 }, () => "played"));
    expect(syntheticSevenParticipantIds.map((participantId) =>
      receipts.state("greeting", "recording-1", participantId)
    )).not.toContain("suppressed_capacity");
  });

  it("greets seven sequential joins exactly once and never replays reconnects", async () => {
    const receipts = new MemoryOneShotReceipts();
    const context = fixture(true, "ru", logger, () => 321, undefined, {
      greetingProfiles: syntheticSevenParticipantProfiles,
      oneShotReceipts: receipts,
    });

    for (const participantId of syntheticSevenParticipantIds) {
      context.bridge.participantJoined(participantId, occurredAt);
      await context.bridge.settle();
    }

    expect(context.coordinator.calls.map(({ literalSpeech }) => literalSpeech)).toEqual([
      "Привет, Тест Альфа!",
      "Привет, Тест Бета!",
      "Привет, Тест Гамма!",
      "Привет, Тест Дельта!",
      "Привет, Тест Эпсилон!",
      "Привет, Тест Дзета!",
      "Привет, Тест Эта!",
    ]);
    for (const participantId of syntheticSevenParticipantIds) {
      context.bridge.participantLeft(participantId);
      context.bridge.participantJoined(participantId, occurredAt);
      await context.bridge.settle();
    }
    expect(context.coordinator.calls).toHaveLength(7);

    const restarted = fixture(true, "ru", logger, () => 654, undefined, {
      greetingProfiles: syntheticSevenParticipantProfiles,
      oneShotReceipts: receipts,
    });
    restarted.bridge.participantsRestored(syntheticSevenParticipantIds, occurredAt);
    await restarted.bridge.settle();
    expect(restarted.coordinator.calls).toEqual([]);
  });

  it("coalesces rapid RU/EN joins without suppressing a supported participant", async () => {
    const context = fixture(true);

    context.bridge.participantsPresent([
      russianParticipantId,
      unknownParticipantId,
      englishParticipantId,
      secondUnknownParticipantId,
    ], occurredAt);
    await context.bridge.settle();

    expect(context.coordinator.calls).toHaveLength(1);
    expect(context.coordinator.calls[0]?.literalSpeech)
      .toBe("Привет, Саша, 2 гостя! Hi, Alex!");
  });

  it("greets eight anonymous humans without moving the seven-name copy limit into runtime admission", async () => {
    const receipts = new MemoryOneShotReceipts();
    const context = fixture(true, "ru", logger, () => 321, undefined, {
      oneShotReceipts: receipts,
    });
    const participants = Array.from({ length: 8 }, (_, index) => `human-${index + 1}`);
    context.bridge.participantsPresent(participants, occurredAt);
    await context.bridge.settle();

    expect(context.coordinator.calls).toHaveLength(1);
    expect(context.coordinator.calls[0]?.literalSpeech).toBe("Привет, 8 гостей!");
    for (const participantId of participants) {
      expect(receipts.state("greeting", "recording-1", participantId)).toBe("played");
    }
  });

  it("caps spoken names at seven while still representing additional humans", async () => {
    const eighthKnownId = "999999999999999999";
    const receipts = new MemoryOneShotReceipts();
    const context = fixture(true, "ru", logger, () => 321, undefined, {
      greetingProfiles: {
        ...syntheticSevenParticipantProfiles,
        [eighthKnownId]: {
          displayName: "Анна", greetingLocale: "ru", spokenName: "Анна",
        },
      },
      oneShotReceipts: receipts,
    });
    const participants = [...syntheticSevenParticipantIds, eighthKnownId];
    context.bridge.participantsPresent(participants, occurredAt);
    await context.bridge.settle();

    expect(context.coordinator.calls[0]?.literalSpeech)
      .toBe("Привет, Тест Альфа, Тест Бета, Тест Гамма, Тест Дельта, Тест Эпсилон, Тест Дзета, Тест Эта, один гость!");
    expect(participants.map((participantId) =>
      receipts.state("greeting", "recording-1", participantId)
    )).toEqual(Array.from({ length: 8 }, () => "played"));
  });

  it("fences a thirteenth simultaneous human at the documented safety bound", async () => {
    const receipts = new MemoryOneShotReceipts();
    const context = fixture(true, "ru", logger, () => 321, undefined, {
      oneShotReceipts: receipts,
    });
    const participants = Array.from({ length: 13 }, (_, index) => `human-${index + 1}`);
    context.bridge.participantsPresent(participants, occurredAt);
    await context.bridge.settle();

    expect(context.coordinator.calls[0]?.literalSpeech).toBe("Привет, 12 гостей!");
    for (const participantId of participants.slice(0, 12)) {
      expect(receipts.state("greeting", "recording-1", participantId)).toBe("played");
    }
    expect(receipts.state("greeting", "recording-1", "human-13"))
      .toBe("suppressed_capacity");
  });

  it("atomically reconciles thirteen incremental joins while playback is unavailable", async () => {
    const receipts = new MemoryOneShotReceipts();
    const context = fixture(false, "ru", logger, () => 321, undefined, {
      oneShotReceipts: receipts,
    });
    const participants = Array.from({ length: 13 }, (_, index) => `human-${index + 1}`);

    for (const [index, participantId] of participants.entries()) {
      context.bridge.participantJoined(participantId, occurredAt);
      await context.bridge.settle();
      expect(context.coordinator.calls).toHaveLength(0);
      expect(participants.slice(0, index + 1).filter((id) =>
        receipts.state("greeting", "recording-1", id) === "suppressed_capacity"
      )).toHaveLength(Math.max(0, index + 1 - 12));
    }

    context.setPlaybackReady(true);
    context.bridge.advance();
    await context.bridge.settle();
    expect(context.coordinator.calls).toHaveLength(1);
    expect(receipts.state("greeting", "recording-1", "human-13"))
      .toBe("suppressed_capacity");
  });

  it("fails closed and recomputes durable capacity after a reordered restart", async () => {
    const receipts = new MemoryOneShotReceipts();
    const reconcileCapacity = receipts.reconcileGreetingCapacity.bind(receipts);
    let rejectedCapacityWrite = false;
    receipts.reconcileGreetingCapacity = (input) => {
      if (!rejectedCapacityWrite && input.orderedSubjectIds.includes("human-13")) {
        rejectedCapacityWrite = true;
        return Promise.reject(new Error("synthetic capacity persistence failure"));
      }
      return reconcileCapacity(input);
    };
    const context = fixture(false, "ru", logger, () => 321, undefined, {
      oneShotReceipts: receipts,
    });
    const participants = Array.from({ length: 13 }, (_, index) => `human-${index + 1}`);

    for (const participantId of participants) {
      context.bridge.participantJoined(participantId, occurredAt);
      await context.bridge.settle();
    }
    expect(receipts.state("greeting", "recording-1", "human-13")).toBeUndefined();
    expect(context.coordinator.calls).toHaveLength(0);

    context.bridge.close();
    const restarted = fixture(true, "ru", logger, () => 400, undefined, {
      oneShotReceipts: receipts,
    });
    const reordered = [participants[12]!, ...participants.slice(0, 12)];
    restarted.bridge.participantsRestored(reordered, occurredAt);
    await restarted.bridge.settle();
    expect(receipts.state("greeting", "recording-1", "human-12")).toBe("played");
    expect(receipts.state("greeting", "recording-1", "human-13"))
      .toBe("suppressed_capacity");
    expect(restarted.coordinator.calls).toHaveLength(1);
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
      ...liveParticipantIds,
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
    expect(receipts.state("greeting", "recording-1", participantId)).toBe("played");
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
        .toBeUndefined();
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(complete).toHaveBeenCalledTimes(0);

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
      expect(reserve).toHaveBeenCalledTimes(2);
      expect(complete).toHaveBeenCalledTimes(0);

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
      expect(complete).toHaveBeenCalledTimes(0);
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
    expect(context.coordinator.calls.map(({ playbackAttemptId }) => playbackAttemptId))
      .toEqual([
        `participant-greeting:${russianParticipantId}`,
        `participant-greeting:${russianParticipantId}`,
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
    let russianSettlements = 0;
    context.coordinator.onPlaybackSettlement = () => {
      russianSettlements += 1;
      if (russianSettlements === 4) {
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
    "retries the stable provider command after a crash before confirmed audio",
    retriesCrashBeforeProviderConfirmedAudio,
  );

  it("retries a recovered provider command independently from a fresh leader", async () => {
    const receipts = new MemoryOneShotReceipts();
    const recovered = await receipts.reserve({
      kind: "greeting",
      leaseSeconds: 120,
      meetingId: "recording-1",
      subjectId: englishParticipantId,
    });
    expect(recovered.status).toBe("reserved");
    if (recovered.status !== "reserved") {
      return;
    }
    await receipts.beginGreetingAttempt({
      kind: "greeting",
      leaseToken: recovered.leaseToken,
      locale: "en",
      meetingId: "recording-1",
      prompt: "Original stable recovered greeting.",
      providerCommandId: recovered.providerCommandId ?? "recovered-command",
      subjectId: englishParticipantId,
    });
    receipts.expireReservations();
    const restarted = fixture(true, "ru", logger, () => 321, undefined, {
      oneShotReceipts: receipts,
    });

    restarted.bridge.participantsRestored([
      russianParticipantId,
      englishParticipantId,
    ], occurredAt);
    await restarted.bridge.settle();

    expect(restarted.coordinator.calls).toHaveLength(2);
    expect(restarted.coordinator.calls.some((call) =>
      call.playbackAttemptId?.includes(russianParticipantId) === true &&
      call.prompt === "Привет, Саша!"))
      .toBe(true);
    expect(restarted.coordinator.calls.some((call) =>
      call.playbackAttemptId === recovered.providerCommandId &&
      call.prompt === "Original stable recovered greeting."))
      .toBe(true);
    expect(new Set(
      restarted.coordinator.calls.map(({ playbackAttemptId }) => playbackAttemptId),
    ).size)
      .toBe(2);
  });

  it("exempts a recovered command while durably suppressing fresh overflow", async () => {
    const receipts = new MemoryOneShotReceipts();
    const recovered = await receipts.reserve({
      kind: "greeting",
      leaseSeconds: 120,
      meetingId: "recording-1",
      subjectId: englishParticipantId,
    });
    expect(recovered.status).toBe("reserved");
    if (recovered.status !== "reserved") {
      return;
    }
    await receipts.beginGreetingAttempt({
      kind: "greeting",
      leaseToken: recovered.leaseToken,
      locale: "en",
      meetingId: "recording-1",
      prompt: "Original stable recovered greeting.",
      providerCommandId: recovered.providerCommandId ?? "recovered-command",
      subjectId: englishParticipantId,
    });
    receipts.expireReservations();
    const restarted = fixture(true, "ru", logger, () => 321, undefined, {
      oneShotReceipts: receipts,
    });
    const freshParticipants = Array.from(
      { length: 13 },
      (_, index) => `fresh-human-${index + 1}`,
    );

    restarted.bridge.participantsRestored(
      [...freshParticipants, englishParticipantId],
      occurredAt,
    );
    await restarted.bridge.settle();

    expect(receipts.state("greeting", "recording-1", "fresh-human-13"))
      .toBe("suppressed_capacity");
    expect(restarted.coordinator.calls).toHaveLength(2);
    expect(restarted.coordinator.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ prompt: "Привет, 12 гостей!" }),
      expect.objectContaining({
        playbackAttemptId: recovered.providerCommandId,
        prompt: "Original stable recovered greeting.",
      }),
    ]));
  });

  it("never replays after durable provider-confirmed first audio", async () => {
    const receipts = new MemoryOneShotReceipts();
    const first = fixture(true, "ru", logger, () => 321, undefined, {
      oneShotReceipts: receipts,
    });
    first.coordinator.whenTurnPlaybackSettled = () => new Promise<never>(() => {});
    first.bridge.participantJoined(russianParticipantId, occurredAt);
    const abandoned = first.bridge.settle();
    await vi.waitFor(() => {
      expect(receipts.state("greeting", "recording-1", russianParticipantId)).toBe("started");
    });

    receipts.expireReservations();
    const restarted = fixture(true, "ru", logger, () => 654, undefined, {
      oneShotReceipts: receipts,
    });
    restarted.bridge.participantsRestored([russianParticipantId], occurredAt);
    await restarted.bridge.settle();
    expect(restarted.coordinator.calls).toEqual([]);

    first.bridge.close();
    await abandoned;
  }, 5_000);

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

  it("removes someone who leaves while a ready cohort is being reserved", async () => {
    const receipts = new MemoryOneShotReceipts();
    const reserve = receipts.reserve.bind(receipts);
    let reservationCount = 0;
    let releaseFollower!: () => void;
    let observeFollower!: () => void;
    const followerObserved = new Promise<void>((resolve) => {
      observeFollower = resolve;
    });
    const followerGate = new Promise<void>((resolve) => {
      releaseFollower = resolve;
    });
    receipts.reserve = async (input) => {
      const result = await reserve(input);
      reservationCount += 1;
      if (reservationCount === 2) {
        observeFollower();
        await followerGate;
      }
      return result;
    };
    const context = fixture(true, "ru", logger, () => 321, undefined, {
      oneShotReceipts: receipts,
    });

    context.bridge.participantsPresent([
      russianParticipantId,
      englishParticipantId,
    ], occurredAt);
    await followerObserved;
    context.bridge.participantLeft(englishParticipantId);
    releaseFollower();
    await context.bridge.settle();

    expect(context.coordinator.calls).toHaveLength(1);
    expect(context.coordinator.calls[0]?.prompt).toBe("Привет, Саша!");
    expect(receipts.state("greeting", "recording-1", englishParticipantId))
      .toBe("suppressed_stale");
  });

  it("drops queued greetings when the meeting closes", dropsQueuedGreetingsWhenMeetingCloses);
});

it("does not mistake process restoration for successful playback", doesNotMistakeRestorationForPlayback);

it("plays a matching prepared greeting without invoking the TTS runtime", playsMatchingPreparedGreeting);

it("uses the configured English fallback without inventing a name", usesConfiguredEnglishFallback);

it("suppresses contradictory played settlement when provider reports no first audio", async () => {
  const receipts = new MemoryOneShotReceipts();
  const context = fixture(true, "ru", logger, () => 321, undefined, {
    oneShotReceipts: receipts,
  });
  context.coordinator.whenTurnPlaybackStarted = () =>
    Promise.resolve({ status: "unplayed" as const });
  context.coordinator.playbackSettlements.push("played");

  context.bridge.participantJoined(russianParticipantId, occurredAt);
  await context.bridge.settle();

  expect(receipts.state("greeting", "recording-1", russianParticipantId))
    .toBe("suppressed_ambiguous");
  const restarted = fixture(true, "ru", logger, () => 654, undefined, {
    oneShotReceipts: receipts,
  });
  restarted.bridge.participantsRestored([russianParticipantId], occurredAt);
  await restarted.bridge.settle();
  expect(restarted.coordinator.calls).toEqual([]);
});

it("keeps a started greeting terminal when played settlement persistence fails", async () => {
  const receipts = new MemoryOneShotReceipts();
  receipts.settleGreeting = () => Promise.reject(new Error("synthetic settlement write failure"));
  const context = fixture(true, "ru", logger, () => 321, undefined, {
    oneShotReceipts: receipts,
  });

  context.bridge.participantJoined(russianParticipantId, occurredAt);
  await context.bridge.settle();
  expect(receipts.state("greeting", "recording-1", russianParticipantId)).toBe("started");

  const restarted = fixture(true, "ru", logger, () => 654, undefined, {
    oneShotReceipts: receipts,
  });
  restarted.bridge.participantsRestored([russianParticipantId], occurredAt);
  await restarted.bridge.settle();
  expect(restarted.coordinator.calls).toEqual([]);
});

it("reconciles a failed attempt transition as stale without replay after lease expiry", async () => {
  const receipts = new MemoryOneShotReceipts();
  receipts.beginGreetingAttempt = () =>
    Promise.reject(new Error("synthetic attempt transition failure"));
  const first = fixture(true, "ru", logger, () => 321, undefined, {
    oneShotReceipts: receipts,
  });

  first.bridge.participantJoined(russianParticipantId, occurredAt);
  await first.bridge.settle();
  expect(first.coordinator.calls).toEqual([]);
  expect(receipts.state("greeting", "recording-1", russianParticipantId)).toBe("reserved");

  receipts.expireReservations();
  const restarted = fixture(true, "ru", logger, () => 10_000, undefined, {
    oneShotReceipts: receipts,
  });
  restarted.bridge.participantsRestored([russianParticipantId], occurredAt);
  await restarted.bridge.settle();

  expect(restarted.coordinator.calls).toEqual([]);
  expect(receipts.state("greeting", "recording-1", russianParticipantId))
    .toBe("suppressed_stale");
});
