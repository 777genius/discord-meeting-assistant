import { constants, promises as fs } from "node:fs";
import { dirname } from "node:path";

import { DiscordJsLiveDiscordProjectionReader } from "./discordjs-live-discord-projection-reader.js";
import { FileSecretReader, MacOsKeychainSecretReader } from "./keychain.js";
import {
  liveDiscordPlaybackLinkProofSchema,
  observeFirstSeenLiveDiscordPlaybackLink,
} from "./live-discord-playback-link-observer.js";
import { loadLiveDiscordPlaybackLinkObserverConfig } from "./live-discord-playback-link-observer-config.js";
import type { LiveDiscordProjectionReader } from "./live-discord-observer.js";

interface PlaybackLinkDiscordReader extends LiveDiscordProjectionReader {
  authenticatedUserId(): string;
  close(): Promise<void>;
  connect(token: string): Promise<void>;
}

interface PlaybackLinkSecretReader {
  read(account: string): Promise<string>;
}

async function main(): Promise<void> {
  const config = loadLiveDiscordPlaybackLinkObserverConfig(process.env);
  const secretReader = config.secretDirectory === undefined
    ? new MacOsKeychainSecretReader(config.keychainService)
    : new FileSecretReader(config.secretDirectory);
  const discord = new DiscordJsLiveDiscordProjectionReader();
  await runLiveDiscordPlaybackLinkObserver(config, secretReader, discord);
}

export async function runLiveDiscordPlaybackLinkObserver(
  config: ReturnType<typeof loadLiveDiscordPlaybackLinkObserverConfig>,
  secretReader: PlaybackLinkSecretReader,
  discord: PlaybackLinkDiscordReader,
): Promise<void> {
  try {
    await discord.connect(await secretReader.read(config.sutAccount));
    if (discord.authenticatedUserId() !== config.sutApplicationId) {
      throw new Error("Playback-link observer SUT application ID does not match its authenticated bot");
    }
    const proof = liveDiscordPlaybackLinkProofSchema.parse(
      await observeFirstSeenLiveDiscordPlaybackLink(config, discord),
    );
    await writeCreateOnlyPrivateJson(config.outputPath, proof);
    process.stdout.write(`${JSON.stringify({
      messageId: proof.messageId,
      outputPath: config.outputPath,
      recordingId: proof.recordingId,
      runId: proof.runId,
      status: "captured",
    })}\n`);
  } finally {
    await discord.close();
  }
}

export async function writeCreateOnlyPrivateJson(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.partial-${process.pid}-${Date.now()}`;
  const handle = await fs.open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      await handle.writeFile(`${JSON.stringify(value, undefined, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.link(temporaryPath, path);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
  const status = await fs.lstat(path);
  if (status.isSymbolicLink() || !status.isFile() || (status.mode & 0o777) !== 0o600) {
    throw new Error("Playback-link proof must be a regular mode-0600 file");
  }
}

const invokedAsEntrypoint = process.argv[1]?.endsWith("observe-live-discord-playback-link.js") === true;
if (invokedAsEntrypoint) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown playback-link observer failure";
    process.stderr.write(`Playback-link observer failed: ${message}\n`);
    process.exitCode = 1;
  });
}
