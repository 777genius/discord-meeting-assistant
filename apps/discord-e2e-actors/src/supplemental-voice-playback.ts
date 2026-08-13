import type { ScenarioClock, VoiceActor } from "./run-actor-scenario.js";

export interface SupplementalPlaybackActor extends VoiceActor {
  readonly authenticatedApplicationId: string;
}

export interface SupplementalPlaybackEvidence {
  readonly authenticatedApplicationId: string;
  readonly playbackEndedAtEpochMs: number;
  readonly playbackStartedAtEpochMs: number;
  readonly postHoldMilliseconds: number;
  readonly preHoldMilliseconds: number;
}

export interface SupplementalPlaybackClock extends ScenarioClock {
  nowEpochMilliseconds(): number;
}

export async function runSupplementalVoicePlayback(
  actor: SupplementalPlaybackActor,
  expectedApplicationId: string,
  postHoldMilliseconds: number,
  clock: SupplementalPlaybackClock,
): Promise<SupplementalPlaybackEvidence> {
  if (actor.authenticatedApplicationId !== expectedApplicationId) {
    throw new Error("Supplemental Speaker D application ID does not match its authenticated bot");
  }
  const state: { value: "pending" | "playing" | "idle" } = { value: "pending" };
  let playbackStartedAtEpochMs = 0;
  let playbackEndedAtEpochMs = 0;
  await actor.play({
    onIdle: () => {
      if (state.value !== "playing") {
        throw new Error("Supplemental Speaker D playback reached idle before playing");
      }
      state.value = "idle";
      playbackEndedAtEpochMs = clock.nowEpochMilliseconds();
    },
    onPlaying: () => {
      if (state.value !== "pending") {
        throw new Error("Supplemental Speaker D playback started more than once");
      }
      state.value = "playing";
      playbackStartedAtEpochMs = clock.nowEpochMilliseconds();
    },
  });
  if (state.value !== "idle") {
    throw new Error("Supplemental Speaker D playback completed without reaching idle");
  }
  await clock.wait(postHoldMilliseconds);
  return Object.freeze({
    authenticatedApplicationId: actor.authenticatedApplicationId,
    playbackEndedAtEpochMs,
    playbackStartedAtEpochMs,
    postHoldMilliseconds,
    preHoldMilliseconds: 0,
  });
}
