import { link, lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import { loadSupplementalVoicePlaybackConfig, loadVerifiedSupplementalVoiceManifest } from "./supplemental-voice-playback-config.js";
import { connectDiscordVoiceActor } from "./discord-voice-actor.js";
import { FileSecretReader, MacOsKeychainSecretReader } from "./keychain.js";
import { systemScenarioClock } from "./run-actor-scenario.js";
import { runSupplementalVoicePlayback, type SupplementalPlaybackClock } from "./supplemental-voice-playback.js";

const systemPlaybackClock: SupplementalPlaybackClock = {
  nowEpochMilliseconds: () => Date.now(),
  wait: (milliseconds) => systemScenarioClock.wait(milliseconds),
};

async function main(): Promise<void> {
  const config = loadSupplementalVoicePlaybackConfig(process.env);
  await assertSupplementalEvidencePathIsNew(config.evidenceOutputPath);
  const manifest = await loadVerifiedSupplementalVoiceManifest(
    config.manifestPath,
    config.playbackTimeoutMilliseconds,
  );
  const secretReader = config.secretDirectory === undefined
    ? new MacOsKeychainSecretReader(config.keychainService)
    : new FileSecretReader(config.secretDirectory);
  const token = await secretReader.read(config.keychainAccount);
  const actor = await connectDiscordVoiceActor({
    expectedApplicationId: manifest.applicationId,
    fixturePath: manifest.fixture.path,
    guildId: manifest.guildId,
    name: "supplemental-speaker-d",
    playbackTimeoutMilliseconds: config.playbackTimeoutMilliseconds,
    readyTimeoutMilliseconds: config.readyTimeoutMilliseconds,
    token,
    voiceChannelId: manifest.voiceChannelId,
  });
  try {
    const playback = await runSupplementalVoicePlayback(
      actor,
      manifest.applicationId,
      config.preHoldMilliseconds,
      config.postHoldMilliseconds,
      systemPlaybackClock,
    );
    await writeNewSupplementalEvidence(config.evidenceOutputPath, {
      actor: {
        applicationId: manifest.applicationId,
        authenticatedApplicationId: playback.authenticatedApplicationId,
        name: "speaker-d",
      },
      fixture: manifest.fixture,
      playback: {
        endedAtEpochMs: playback.playbackEndedAtEpochMs,
        postHoldMilliseconds: playback.postHoldMilliseconds,
        preHoldMilliseconds: playback.preHoldMilliseconds,
        startedAtEpochMs: playback.playbackStartedAtEpochMs,
      },
      privateTestGuildConfirmed: config.privateTestGuildConfirmed,
      runId: config.runId,
      schemaVersion: 1,
      target: { guildId: manifest.guildId, voiceChannelId: manifest.voiceChannelId },
    });
    process.stdout.write(`Supplemental Speaker D evidence written to ${config.evidenceOutputPath}.\n`);
    process.stdout.write(`${JSON.stringify({
      kind: "supplemental-player-completion",
      outputPath: config.evidenceOutputPath,
      runId: config.runId,
      status: "completed",
    })}\n`);
  } finally {
    await actor.close();
  }
}

async function writeNewSupplementalEvidence(path: string, evidence: unknown): Promise<void> {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(evidence, undefined, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryPath, path);
  } catch (error) {
    await handle?.close();
    if (isExistingPathError(error)) {
      throw new Error("Supplemental Speaker D evidence already exists and will not be replaced", {
        cause: error,
      });
    }
    throw error;
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

async function assertSupplementalEvidencePathIsNew(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
    return;
  }
  throw new Error("Supplemental Speaker D evidence already exists and will not be replaced");
}

function isExistingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown supplemental voice playback failure";
  process.stderr.write(`Supplemental Speaker D playback failed: ${message}\n`);
  process.exitCode = 1;
});
