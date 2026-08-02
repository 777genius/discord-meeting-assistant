import { describe, expect, it } from "vitest";

import {
  runActorScenario,
  type ReconnectableVoiceActor,
  type ScenarioClock,
  type VoiceActor,
  type VoicePlaybackLifecycleObserver,
} from "../src/run-actor-scenario.js";

describe("runActorScenario", () => {
  it("starts speaker B after the configured overlap offset", async () => {
    const events: string[] = [];
    let releasePlayback: (() => void) | undefined;
    const playbackBarrier = new Promise<void>((resolve) => {
      releasePlayback = resolve;
    });
    const actor = (name: string): ReconnectableVoiceActor => ({
      play: async (lifecycle) => {
        events.push(`${name}:start`);
        lifecycle.onPlaying();
        if (name === "b") {
          releasePlayback?.();
        }
        await playbackBarrier;
        lifecycle.onIdle();
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
      play: async (lifecycle) => {
        events.push(`${name}:start`, `${name}:finish`);
        lifecycle.onPlaying();
        lifecycle.onIdle();
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

  it("reconnects speaker B during speaker A and plays once after ready", async () => {
    const events: string[] = [];
    const observed: string[] = [];
    let releaseSpeakerA: (() => void) | undefined;
    const speakerAPlayback = new Promise<void>((resolve) => {
      releaseSpeakerA = resolve;
    });
    const speakerA: VoiceActor = {
      play: async (lifecycle) => {
        events.push("a:start");
        lifecycle.onPlaying();
        await speakerAPlayback;
        lifecycle.onIdle();
        events.push("a:finish");
      },
      close: () => Promise.resolve(),
    };
    const speakerB: ReconnectableVoiceActor = {
      play: async (lifecycle) => {
        events.push("b:start", "b:finish");
        lifecycle.onPlaying();
        lifecycle.onIdle();
        releaseSpeakerA?.();
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
      "b:disconnect",
      "b:ready",
      "b:start",
      "b:finish",
      "a:finish",
    ]);
    expect(observed).toEqual([
      "speaker-a:playback-start",
      "speaker-b:disconnected",
      "speaker-b:ready",
      "speaker-b:playback-start",
      "speaker-b:playback-end",
      "speaker-a:playback-end",
    ]);
  });

  it("observes playback only when the actor reports Playing and Idle transitions", async () => {
    const observed: string[] = [];
    let lifecycle: VoicePlaybackLifecycleObserver | undefined;
    let releasePlayback: (() => void) | undefined;
    const playbackBarrier = new Promise<void>((resolve) => {
      releasePlayback = resolve;
    });
    const speakerA: VoiceActor = {
      play: async (nextLifecycle) => {
        lifecycle = nextLifecycle;
        await playbackBarrier;
      },
      close: () => Promise.resolve(),
    };
    const speakerB: ReconnectableVoiceActor = {
      play: async (nextLifecycle) => {
        nextLifecycle.onPlaying();
        nextLifecycle.onIdle();
      },
      reconnect: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };

    const scenario = runActorScenario(
      speakerA,
      speakerB,
      { kind: "sequential", speakerBDelayMilliseconds: 0 },
      { wait: () => Promise.resolve() },
      (event) => {
        observed.push(`${event.actorName}:${event.type}`);
      },
    );
    await Promise.resolve();

    expect(observed).toEqual([]);
    lifecycle?.onPlaying();
    expect(observed).toEqual(["speaker-a:playback-start"]);
    lifecycle?.onIdle();
    expect(observed).toEqual([
      "speaker-a:playback-start",
      "speaker-a:playback-end",
    ]);
    releasePlayback?.();
    await scenario;

    expect(observed).toEqual([
      "speaker-a:playback-start",
      "speaker-a:playback-end",
      "speaker-b:playback-start",
      "speaker-b:playback-end",
    ]);
  });

  it("rejects an actor that completes without a real Idle transition", async () => {
    const incompleteActor: ReconnectableVoiceActor = {
      play: async (lifecycle) => {
        lifecycle.onPlaying();
      },
      reconnect: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };

    await expect(runActorScenario(
      incompleteActor,
      incompleteActor,
      { kind: "sequential", speakerBDelayMilliseconds: 0 },
      { wait: () => Promise.resolve() },
    )).rejects.toThrow("speaker-a completed playback without reaching idle");
  });
});
