import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { link, mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { loadActorConfig } from "./config.js";
import { connectActorsAfterReleaseGate } from "./actor-release-gate.js";
import {
  connectDiscordVoiceActor,
  type RecorderAwareVoiceActor,
} from "./discord-voice-actor.js";
import { FileSecretReader, MacOsKeychainSecretReader } from "./keychain.js";
import { loadVerifiedFixtureSet } from "./fixture-integrity.js";
import {
  closeActors,
  runActorScenario,
  systemScenarioClock,
  type ActorScenarioEvent,
} from "./run-actor-scenario.js";

const recorderVoiceSettleMilliseconds = 5_000;

async function main(): Promise<void> {
  const config = loadActorConfig(process.env);
  const verifiedFixtureSet = await loadVerifiedFixtureSet(
    config.fixtureManifestPath,
    config.speakers.map(({ name, fixturePath }) => ({ actorName: name, fixturePath })),
  );
  const secretReader = config.secretDirectory === undefined
    ? new MacOsKeychainSecretReader(config.keychainService)
    : new FileSecretReader(config.secretDirectory);
  const tokens = await Promise.all(
    config.speakers.map(async (speaker) => secretReader.read(speaker.account)),
  );
  process.stdout.write("Discord E2E credentials loaded from Keychain.\n");

  const actors: RecorderAwareVoiceActor[] = [];
  try {
    if (config.releaseGate !== undefined) {
      process.stdout.write("Discord E2E waiting for hosted coordinator connection release.\n");
    }
    await connectActorsAfterReleaseGate(config, async () => {
      if (config.releaseGate !== undefined) {
        process.stdout.write("Discord E2E hosted coordinator released actor connections.\n");
      }
      for (const [index, speaker] of config.speakers.entries()) {
        const token = tokens[index];
        if (token === undefined) {
          throw new Error(`Missing Keychain credential for ${speaker.name}`);
        }
        if (index === 1 && config.speakerBConnectDelayMilliseconds > 0) {
          process.stdout.write(
            `Discord E2E delaying speaker-b connection for ${config.speakerBConnectDelayMilliseconds}ms.\n`,
          );
          await systemScenarioClock.wait(config.speakerBConnectDelayMilliseconds);
        }
        process.stdout.write(`Discord E2E connecting ${speaker.name}.\n`);
        const expectedApplicationId = verifiedFixtureSet.manifest.fixtures.find(
          ({ actorName }) => actorName === speaker.name,
        )?.speakerId;
        if (expectedApplicationId === undefined) {
          throw new Error(`Missing pinned Discord application ID for ${speaker.name}`);
        }
        actors.push(await connectDiscordVoiceActor({
          expectedApplicationId,
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
    });

    const [speakerA, speakerB] = actors;
    if (speakerA === undefined || speakerB === undefined) {
      throw new Error("Both Discord E2E actors are required");
    }
    await speakerA.waitForVoiceMember(config.recorderBotId, config.readyTimeoutMilliseconds);
    await systemScenarioClock.wait(recorderVoiceSettleMilliseconds);
    const epochOriginMs = Date.now();
    const monotonicOrigin = process.hrtime.bigint();
    const epochNow = (): number => epochOriginMs + Number(
      (process.hrtime.bigint() - monotonicOrigin) / 1_000_000n,
    );
    const events: Array<ActorScenarioEvent & { readonly atEpochMs: number }> = [
      { actorName: "speaker-a", atEpochMs: epochNow(), type: "ready" },
      { actorName: "speaker-b", atEpochMs: epochNow(), type: "ready" },
    ];
    if (config.prePlaybackHoldMilliseconds > 0) {
      process.stdout.write(
        `Discord E2E holding both actors before playback for ${config.prePlaybackHoldMilliseconds}ms.\n`,
      );
      await systemScenarioClock.wait(config.prePlaybackHoldMilliseconds);
    }
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
    if (config.postPlaybackHoldMilliseconds > 0) {
      process.stdout.write(
        `Discord E2E holding both actors in voice for ${config.postPlaybackHoldMilliseconds}ms.\n`,
      );
      await systemScenarioClock.wait(config.postPlaybackHoldMilliseconds);
    }
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
  const temporaryPath = `${path}.partial-${randomUUID()}`;
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      await handle.writeFile(`${JSON.stringify(actorRun, undefined, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown actor harness failure";
  process.stderr.write(`Discord E2E actor harness failed: ${message}\n`);
  process.exitCode = 1;
});
