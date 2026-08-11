import { describe, expect, it } from "vitest";

import { assertExpectedOfficialBotApplication } from "../src/discord-voice-actor.js";
import {
  runSupplementalVoicePlayback,
  type SupplementalPlaybackActor,
  type SupplementalPlaybackClock,
} from "../src/supplemental-voice-playback.js";

function actorWithPlayback(play: SupplementalPlaybackActor["play"]): SupplementalPlaybackActor {
  return {
    authenticatedApplicationId: "33333333333333333",
    close: () => Promise.resolve(),
    play,
  };
}

describe("runSupplementalVoicePlayback", () => {
  it("plays the pinned fixture exactly once between bounded holds", async () => {
    const events: string[] = [];
    let now = 1_000;
    let playCount = 0;
    const clock: SupplementalPlaybackClock = {
      nowEpochMilliseconds: () => now,
      wait: (milliseconds) => {
        events.push(`wait:${milliseconds}`);
        now += milliseconds;
        return Promise.resolve();
      },
    };
    const actor: SupplementalPlaybackActor = {
      authenticatedApplicationId: "33333333333333333",
      close: () => Promise.resolve(),
      play: async (lifecycle) => {
        playCount += 1;
        events.push("playing");
        lifecycle.onPlaying();
        now += 2_000;
        events.push("idle");
        lifecycle.onIdle();
      },
    };

    await expect(runSupplementalVoicePlayback(
      actor,
      "33333333333333333",
      500,
      750,
      clock,
    )).resolves.toEqual({
      authenticatedApplicationId: "33333333333333333",
      playbackEndedAtEpochMs: 3_500,
      playbackStartedAtEpochMs: 1_500,
      postHoldMilliseconds: 750,
      preHoldMilliseconds: 500,
    });
    expect(playCount).toBe(1);
    expect(events).toEqual(["wait:500", "playing", "idle", "wait:750"]);
  });

  it("fails before holds or playback for a mismatched application ID", async () => {
    let called = false;
    const actor: SupplementalPlaybackActor = {
      authenticatedApplicationId: "44444444444444444",
      close: () => Promise.resolve(),
      play: () => {
        called = true;
        return Promise.resolve();
      },
    };
    const clock: SupplementalPlaybackClock = {
      nowEpochMilliseconds: () => 0,
      wait: () => {
        called = true;
        return Promise.resolve();
      },
    };

    await expect(runSupplementalVoicePlayback(
      actor,
      "33333333333333333",
      0,
      0,
      clock,
    )).rejects.toThrow("application ID");
    expect(called).toBe(false);
  });

  it("rejects incomplete or repeated playback lifecycle transitions", async () => {
    const clock: SupplementalPlaybackClock = {
      nowEpochMilliseconds: () => 1,
      wait: () => Promise.resolve(),
    };

    await expect(runSupplementalVoicePlayback(actorWithPlayback(async (lifecycle) => {
      lifecycle.onPlaying();
    }), "33333333333333333", 0, 0, clock)).rejects.toThrow("without reaching idle");
    await expect(runSupplementalVoicePlayback(actorWithPlayback(async (lifecycle) => {
      lifecycle.onPlaying();
      lifecycle.onPlaying();
    }), "33333333333333333", 0, 0, clock)).rejects.toThrow("more than once");
  });
});

describe("assertExpectedOfficialBotApplication", () => {
  it("accepts only the expected official bot identity", () => {
    expect(assertExpectedOfficialBotApplication(
      { bot: true, id: "33333333333333333" },
      "33333333333333333",
    )).toBe("33333333333333333");
    expect(() => assertExpectedOfficialBotApplication(
      { bot: true, id: "44444444444444444" },
      "33333333333333333",
    )).toThrow("application ID");
    expect(() => assertExpectedOfficialBotApplication(
      { bot: false, id: "33333333333333333" },
      "33333333333333333",
    )).toThrow("official bot");
  });
});
