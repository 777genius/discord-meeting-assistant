export interface VoiceActor {
  play(): Promise<void>;
  close(): Promise<void>;
}

export interface ScenarioClock {
  wait(milliseconds: number): Promise<void>;
}

const systemScenarioClock: ScenarioClock = {
  wait: async (milliseconds) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }),
};

export async function runActorScenario(
  speakerA: VoiceActor,
  speakerB: VoiceActor,
  speakerBDelayMilliseconds: number,
  clock: ScenarioClock = systemScenarioClock,
): Promise<void> {
  const speakerAPlayback = speakerA.play();
  await clock.wait(speakerBDelayMilliseconds);
  const speakerBPlayback = speakerB.play();
  await Promise.all([speakerAPlayback, speakerBPlayback]);
}

export async function closeActors(actors: readonly VoiceActor[]): Promise<void> {
  await Promise.allSettled(actors.map(async (actor) => actor.close()));
}
