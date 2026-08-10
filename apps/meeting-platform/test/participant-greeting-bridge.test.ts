import { describe, expect, it } from "vitest";

import type {
  LiveConversationConfiguration,
  LiveRuntimeLogger,
} from "../src/live-runtime/contracts.js";
import { ParticipantGreetingBridge } from "../src/live-runtime/participant-greeting-bridge.js";

const russianParticipantId = "1533224474609057795";
const englishParticipantId = "2533224474609057795";
const unknownParticipantId = "3533224474609057795";
const excludedParticipantId = "4533224474609057795";

class GreetingCoordinatorProbe {
  public readonly calls: Array<{
    readonly locale: string;
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
  public readonly outcomes: Array<{ readonly status: string }> = [];

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

  public playPreparedCue(): Promise<{ readonly status: "ignored" }> {
    return Promise.resolve({ status: "ignored" });
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
      },
    },
    locale: "auto",
    nowMilliseconds: () => 321,
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
    expect(context.coordinator.calls.map(({ locale, prompt, speakerId }) => ({
      locale,
      prompt,
      speakerId,
    }))).toEqual([
      {
        locale: "ru",
        prompt: "Привет, Саша!",
        speakerId: russianParticipantId,
      },
      {
        locale: "ru",
        prompt: "Привет!",
        speakerId: unknownParticipantId,
      },
      {
        locale: "en",
        prompt: "Hi, Alex!",
        speakerId: englishParticipantId,
      },
    ]);
    expect(context.coordinator.calls[0]?.systemPrompt).toContain(
      "Speak exactly the greeting provided",
    );
    expect(context.coordinator.idleCalls).toBe(6);
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

  it("logs only privacy-safe greeting completion metadata", async () => {
    const infoCalls: Array<{
      readonly fields: Readonly<Record<string, unknown>> | undefined;
      readonly message: string;
    }> = [];
    const context = fixture(true, "ru", {
      ...logger,
      info: (message, fields) => {
        infoCalls.push({ fields, message });
      },
    });

    context.bridge.participantJoined(russianParticipantId);
    await context.bridge.settle();

    expect(infoCalls).toEqual([{
      fields: {
        greetingLocale: "ru",
        meetingId: "recording-1",
        participantId: russianParticipantId,
        participantNameStatus: "known",
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

  it("retries a provably unadmitted busy greeting without risking a duplicate", async () => {
    const context = fixture(true);
    context.coordinator.outcomes.push({ status: "busy" }, { status: "active" });

    context.bridge.participantJoined(russianParticipantId);
    await context.bridge.settle();
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
