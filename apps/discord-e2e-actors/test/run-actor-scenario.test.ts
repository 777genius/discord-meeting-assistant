import { describe, expect, it } from "vitest";

import {
  runActorScenario,
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
    const actor = (name: string): VoiceActor => ({
      play: async () => {
        events.push(`${name}:start`);
        if (name === "b") {
          releasePlayback?.();
        }
        await playbackBarrier;
        events.push(`${name}:finish`);
      },
      close: () => Promise.resolve(),
    });
    const clock: ScenarioClock = {
      wait: async (milliseconds) => {
        events.push(`wait:${milliseconds}`);
      },
    };

    await runActorScenario(actor("a"), actor("b"), 750, clock);

    expect(events).toEqual(["a:start", "wait:750", "b:start", "a:finish", "b:finish"]);
  });
});
