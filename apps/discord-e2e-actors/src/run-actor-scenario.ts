export interface VoiceActor {
  play(): Promise<void>;
  close(): Promise<void>;
}

export interface ReconnectableVoiceActor extends VoiceActor {
  reconnect(): Promise<void>;
}

type ActorScenarioKind = "overlap" | "sequential" | "reconnect";

export interface ActorScenario {
  readonly kind: ActorScenarioKind;
  readonly speakerBDelayMilliseconds: number;
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
  speakerB: ReconnectableVoiceActor,
  scenario: ActorScenario,
  clock: ScenarioClock = systemScenarioClock,
): Promise<void> {
  if (scenario.kind === "sequential") {
    await speakerA.play();
    await clock.wait(scenario.speakerBDelayMilliseconds);
    await speakerB.play();
    return;
  }

  const speakerAPlayback = speakerA.play();
  try {
    await clock.wait(scenario.speakerBDelayMilliseconds);
    if (scenario.kind === "reconnect") {
      await speakerB.reconnect();
    }
    const speakerBPlayback = speakerB.play();
    await Promise.all([speakerAPlayback, speakerBPlayback]);
  } catch (error: unknown) {
    await Promise.allSettled([speakerAPlayback]);
    throw error;
  }
}

export async function closeActors(actors: readonly VoiceActor[]): Promise<void> {
  await Promise.allSettled(actors.map(async (actor) => actor.close()));
}
