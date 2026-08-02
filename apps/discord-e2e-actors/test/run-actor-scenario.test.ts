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

  it("reconnects speaker B while speaker A keeps the recording active", async () => {
    const events: string[] = [];
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
        events.push("b:start", "b:finish");
        releaseSpeakerA?.();
      },
      reconnect: async () => {
        events.push("b:reconnect");
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
    );

    expect(events).toEqual([
      "a:start",
      "wait:500",
      "b:reconnect",
      "b:start",
      "b:finish",
      "a:finish",
    ]);
  });
});
