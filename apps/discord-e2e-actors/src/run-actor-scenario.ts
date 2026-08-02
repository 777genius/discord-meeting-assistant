export interface VoiceActor {
  play(): Promise<void>;
  close(): Promise<void>;
}

export interface ReconnectableVoiceActor extends VoiceActor {
  reconnect(): Promise<void>;
}

export interface ActorScenarioEvent {
  readonly actorName: "speaker-a" | "speaker-b";
  readonly fixtureId?: "speaker-a" | "speaker-b";
  readonly type: "disconnected" | "playback-end" | "playback-start" | "ready";
}

export type ActorScenarioObserver = (event: ActorScenarioEvent) => void;

type ActorScenarioKind = "overlap" | "sequential" | "reconnect";

export interface ActorScenario {
  readonly kind: ActorScenarioKind;
  readonly speakerBDelayMilliseconds: number;
}

export interface ScenarioClock {
  wait(milliseconds: number): Promise<void>;
}

export const systemScenarioClock: ScenarioClock = {
  wait: async (milliseconds) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }),
};

export async function runActorScenario(
  speakerA: VoiceActor,
  speakerB: ReconnectableVoiceActor,
  scenario: ActorScenario,
  clock: ScenarioClock = systemScenarioClock,
  observe: ActorScenarioObserver = () => {},
): Promise<void> {
  if (scenario.kind === "sequential") {
    await playObserved(speakerA, "speaker-a", observe);
    await clock.wait(scenario.speakerBDelayMilliseconds);
    await playObserved(speakerB, "speaker-b", observe);
    return;
  }

  const speakerAPlayback = playObserved(speakerA, "speaker-a", observe);
  try {
    await clock.wait(scenario.speakerBDelayMilliseconds);
    if (scenario.kind === "reconnect") {
      await playObserved(speakerB, "speaker-b", observe);
      observe({ actorName: "speaker-b", type: "disconnected" });
      await speakerB.reconnect();
      observe({ actorName: "speaker-b", type: "ready" });
      await playObserved(speakerB, "speaker-b", observe);
      await speakerAPlayback;
      return;
    }
    const speakerBPlayback = playObserved(speakerB, "speaker-b", observe);
    await Promise.all([speakerAPlayback, speakerBPlayback]);
  } catch (error: unknown) {
    await Promise.allSettled([speakerAPlayback]);
    throw error;
  }
}

async function playObserved(
  actor: VoiceActor,
  actorName: "speaker-a" | "speaker-b",
  observe: ActorScenarioObserver,
): Promise<void> {
  observe({ actorName, fixtureId: actorName, type: "playback-start" });
  await actor.play();
  observe({ actorName, fixtureId: actorName, type: "playback-end" });
}

export async function closeActors(actors: readonly VoiceActor[]): Promise<void> {
  await Promise.allSettled(actors.map(async (actor) => actor.close()));
}
