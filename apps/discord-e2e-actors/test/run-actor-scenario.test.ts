import { describe, expect, it } from "vitest";

import {
  runActorScenario,
  type ReconnectableVoiceActor,
  type ScenarioClock,
  type VoiceActor,
} from "../src/run-actor-scenario.js";

describe("runActorScenario", () => {
  it("starts speaker B after the configured overlap offset", async () => {
    const events: string[] = [];
    let releasePlayback: (() => void) | undefined;
    const playbackBarrier = new Promise<void>((resolve) => {
      releasePlayback = resolve;
    });
    const actor = (name: string): ReconnectableVoiceActor => ({
      play: async () => {
        events.push(`${name}:start`);
        if (name === "b") {
          releasePlayback?.();
        }
        await playbackBarrier;
        events.push(`${name}:finish`);
      },
      reconnect: () => Promise.resolve(),
      close: () => Promise.resolve(),
    });
    const clock: ScenarioClock = {
      wait: async (milliseconds) => {
        events.push(`wait:${milliseconds}`);
      },
    };

    await runActorScenario(
      actor("a"),
      actor("b"),
      { kind: "overlap", speakerBDelayMilliseconds: 750 },
      clock,
    );

    expect(events).toEqual(["a:start", "wait:750", "b:start", "a:finish", "b:finish"]);
  });

  it("finishes speaker A before applying the sequential gap and starting speaker B", async () => {
    const events: string[] = [];
    const actor = (name: string): ReconnectableVoiceActor => ({
      play: async () => {
        events.push(`${name}:start`, `${name}:finish`);
      },
      reconnect: () => Promise.resolve(),
      close: () => Promise.resolve(),
    });
    const clock: ScenarioClock = {
      wait: async (milliseconds) => {
        events.push(`wait:${milliseconds}`);
      },
    };

    await runActorScenario(
      actor("a"),
      actor("b"),
      { kind: "sequential", speakerBDelayMilliseconds: 1_500 },
      clock,
    );

    expect(events).toEqual(["a:start", "a:finish", "wait:1500", "b:start", "b:finish"]);
  });

  it("plays speaker B before and after a ready reconnect", async () => {
    const events: string[] = [];
    const observed: string[] = [];
    let releaseSpeakerA: (() => void) | undefined;
    const speakerAPlayback = new Promise<void>((resolve) => {
      releaseSpeakerA = resolve;
    });
    const speakerA: VoiceActor = {
      play: async () => {
        events.push("a:start");
        await speakerAPlayback;
        events.push("a:finish");
      },
      close: () => Promise.resolve(),
    };
    const speakerB: ReconnectableVoiceActor = {
      play: async () => {
        const playbackNumber = events.filter((event) => event === "b:start").length + 1;
        events.push("b:start", "b:finish");
        if (playbackNumber === 2) {
          releaseSpeakerA?.();
        }
      },
      reconnect: async () => {
        events.push("b:disconnect", "b:ready");
      },
      close: () => Promise.resolve(),
    };
    const clock: ScenarioClock = {
      wait: async (milliseconds) => {
        events.push(`wait:${milliseconds}`);
      },
    };

    await runActorScenario(
      speakerA,
      speakerB,
      { kind: "reconnect", speakerBDelayMilliseconds: 500 },
      clock,
      (event) => {
        observed.push(`${event.actorName}:${event.type}`);
      },
    );

    expect(events).toEqual([
      "a:start",
      "wait:500",
      "b:start",
      "b:finish",
      "b:disconnect",
      "b:ready",
      "b:start",
      "b:finish",
      "a:finish",
    ]);
    expect(observed).toEqual([
      "speaker-a:playback-start",
      "speaker-b:playback-start",
      "speaker-b:playback-end",
      "speaker-b:disconnected",
      "speaker-b:ready",
      "speaker-b:playback-start",
      "speaker-b:playback-end",
      "speaker-a:playback-end",
    ]);
  });
});
