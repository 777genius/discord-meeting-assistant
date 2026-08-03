import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { loadCapacityConfig } from "./capacity-config.js";
import {
  connectDiscordVoiceActor,
  type RecorderAwareVoiceActor,
} from "./discord-voice-actor.js";
import { FileSecretReader, MacOsKeychainSecretReader } from "./keychain.js";
import { closeActors, systemScenarioClock } from "./run-actor-scenario.js";

const recorderVoiceSettleMilliseconds = 5_000;

interface CapacityActorEvidence {
  readonly account: string;
  readonly playbackEndedAtMs: number;
  readonly playbackStartedAtMs: number;
}

async function main(): Promise<void> {
  const config = loadCapacityConfig(process.env);
  const secretReader = config.secretDirectory === undefined
    ? new MacOsKeychainSecretReader(config.keychainService)
    : new FileSecretReader(config.secretDirectory);
  const tokens = await Promise.all(config.actors.map(async ({ account }) =>
    secretReader.read(account)
  ));
  process.stdout.write(`Capacity E2E loaded ${tokens.length} credentials from the secret store.\n`);

  const actors: RecorderAwareVoiceActor[] = [];
  try {
    for (const [index, actorConfig] of config.actors.entries()) {
      const token = tokens[index];
      if (token === undefined) {
        throw new Error(`Missing credential for ${actorConfig.account}`);
      }
      actors.push(await connectDiscordVoiceActor({
        fixturePath: actorConfig.fixturePath,
        guildId: config.guildId,
        name: actorConfig.name,
        playbackTimeoutMilliseconds: config.playbackTimeoutMilliseconds,
        readyTimeoutMilliseconds: config.readyTimeoutMilliseconds,
        token,
        voiceChannelId: config.voiceChannelId,
      }));
      process.stdout.write(`Capacity E2E connected ${actorConfig.name}.\n`);
    }

    const observer = actors[0];
    if (observer === undefined) {
      throw new Error("Capacity E2E did not create an observer actor");
    }
    await observer.waitForVoiceMember(config.recorderBotId, config.readyTimeoutMilliseconds);
    await systemScenarioClock.wait(recorderVoiceSettleMilliseconds);

    const evidence = await Promise.all(actors.map(async (actor, index) => {
      const actorConfig = config.actors[index];
      if (actorConfig === undefined) {
        throw new Error("Capacity actor configuration changed during playback");
      }
      let playbackStartedAtMs = 0;
      let playbackEndedAtMs = 0;
      await actor.play({
        onIdle: () => {
          playbackEndedAtMs = Date.now();
        },
        onPlaying: () => {
          playbackStartedAtMs = Date.now();
        },
      });
      if (playbackStartedAtMs === 0 || playbackEndedAtMs < playbackStartedAtMs) {
        throw new Error(`${actorConfig.name} returned invalid playback boundaries`);
      }
      return {
        account: actorConfig.account,
        playbackEndedAtMs,
        playbackStartedAtMs,
      } satisfies CapacityActorEvidence;
    }));

    await systemScenarioClock.wait(config.postPlaybackHoldMilliseconds);
    await writeEvidence(config.evidenceOutputPath, {
      actors: evidence,
      completedAtMs: Date.now(),
      guildId: config.guildId,
      schemaVersion: 1,
      voiceChannelId: config.voiceChannelId,
    });
    process.stdout.write(`Capacity E2E completed ${actors.length} parallel voice actors.\n`);
  } finally {
    await closeActors(actors);
  }
}

async function writeEvidence(path: string, evidence: unknown): Promise<void> {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(evidence, undefined, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown capacity E2E failure";
  process.stderr.write(`Capacity E2E failed: ${message}\n`);
  process.exitCode = 1;
});
