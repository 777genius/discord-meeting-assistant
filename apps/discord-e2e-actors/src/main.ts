import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { loadActorConfig } from "./config.js";
import {
  connectDiscordVoiceActor,
  type RecorderAwareVoiceActor,
} from "./discord-voice-actor.js";
import { MacOsKeychainSecretReader } from "./keychain.js";
import { loadVerifiedFixtureSet } from "./fixture-integrity.js";
import {
  closeActors,
  runActorScenario,
  systemScenarioClock,
  type ActorScenarioEvent,
} from "./run-actor-scenario.js";

async function main(): Promise<void> {
  const config = loadActorConfig(process.env);
  const verifiedFixtureSet = await loadVerifiedFixtureSet(
    config.fixtureManifestPath,
    config.speakers.map(({ name, fixturePath }) => ({ actorName: name, fixturePath })),
  );
  const secretReader = new MacOsKeychainSecretReader(config.keychainService);
  const tokens = await Promise.all(
    config.speakers.map(async (speaker) => secretReader.read(speaker.account)),
  );
  process.stdout.write("Discord E2E credentials loaded from Keychain.\n");

  const actors: RecorderAwareVoiceActor[] = [];
  try {
    for (const [index, speaker] of config.speakers.entries()) {
      const token = tokens[index];
      if (token === undefined) {
        throw new Error(`Missing Keychain credential for ${speaker.name}`);
      }
      process.stdout.write(`Discord E2E connecting ${speaker.name}.\n`);
      actors.push(await connectDiscordVoiceActor({
        name: speaker.name,
        token,
        guildId: config.guildId,
        voiceChannelId: config.voiceChannelId,
        fixturePath: speaker.fixturePath,
        readyTimeoutMilliseconds: config.readyTimeoutMilliseconds,
        playbackTimeoutMilliseconds: config.playbackTimeoutMilliseconds,
      }));
      process.stdout.write(`Discord E2E connected ${speaker.name}.\n`);
    }

    const [speakerA, speakerB] = actors;
    if (speakerA === undefined || speakerB === undefined) {
      throw new Error("Both Discord E2E actors are required");
    }
    await speakerA.waitForVoiceMember(config.recorderBotId, config.readyTimeoutMilliseconds);
    await systemScenarioClock.wait(1_000);
    const epochOriginMs = Date.now();
    const monotonicOrigin = process.hrtime.bigint();
    const epochNow = (): number => epochOriginMs + Number(
      (process.hrtime.bigint() - monotonicOrigin) / 1_000_000n,
    );
    const events: Array<ActorScenarioEvent & { readonly atEpochMs: number }> = [
      { actorName: "speaker-a", atEpochMs: epochNow(), type: "ready" },
      { actorName: "speaker-b", atEpochMs: epochNow(), type: "ready" },
    ];
    process.stdout.write(`Discord E2E starting ${config.scenario} synthetic playback.\n`);
    await runActorScenario(speakerA, speakerB, {
      kind: config.scenario,
      speakerBDelayMilliseconds: config.speakerBDelayMilliseconds,
    }, systemScenarioClock, (event) => {
      events.push({
        ...event,
        atEpochMs: epochNow(),
      });
    });
    await writeActorRun(config.actorRunOutputPath, {
      events,
      fixtureSetId: verifiedFixtureSet.manifest.fixtureSetId,
      fixtures: verifiedFixtureSet.fixtures,
      recordingId: null,
      runId: config.runId,
      scenario: config.scenario,
      schemaVersion: 1,
      timelineOrigin: "unix-epoch",
    });
    process.stdout.write(`Discord E2E actor evidence written to ${config.actorRunOutputPath}.\n`);
    process.stdout.write("Discord E2E actors completed synthetic playback.\n");
  } finally {
    await closeActors(actors);
  }
}

async function writeActorRun(path: string, actorRun: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(actorRun, undefined, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown actor harness failure";
  process.stderr.write(`Discord E2E actor harness failed: ${message}\n`);
  process.exitCode = 1;
});
