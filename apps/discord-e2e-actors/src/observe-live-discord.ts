import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname } from "node:path";

import { DiscordJsLiveDiscordProjectionReader } from "./discordjs-live-discord-projection-reader.js";
import { loadLiveDiscordObserverConfig } from "./live-discord-observer-config.js";
import { observeLiveDiscord } from "./live-discord-observer.js";
import { FileSecretReader, MacOsKeychainSecretReader } from "./keychain.js";

async function main(): Promise<void> {
  const config = loadLiveDiscordObserverConfig(process.env);
  await assertOutputDoesNotExist(config.outputPath);

  const secretReader = config.secretDirectory === undefined
    ? new MacOsKeychainSecretReader(config.keychainService)
    : new FileSecretReader(config.secretDirectory);
  const token = await secretReader.read(config.sutAccount);
  const discord = new DiscordJsLiveDiscordProjectionReader();
  try {
    await discord.connect(token);
    if (discord.authenticatedUserId() !== config.sutApplicationId) {
      throw new Error("Discord live observer SUT application ID does not match its authenticated bot");
    }
    const trace = await observeLiveDiscord(config, discord);
    await writeNewTraceAtomically(config.outputPath, trace);
    process.stdout.write(`${JSON.stringify({
      outputPath: config.outputPath,
      runId: config.runId,
      snapshots: trace.snapshots.length,
      status: "captured",
    })}\n`);
  } finally {
    await discord.close();
  }
}

async function assertOutputDoesNotExist(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }
  throw new Error("Discord live observer output already exists and will not be replaced");
}

async function writeNewTraceAtomically(path: string, trace: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  let temporaryHandle: FileHandle | undefined;
  let published = false;
  try {
    temporaryHandle = await open(temporaryPath, "wx", 0o600);
    await temporaryHandle.writeFile(`${JSON.stringify(trace, undefined, 2)}\n`, "utf8");
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await chmod(temporaryPath, 0o600);
    await link(temporaryPath, path);
    published = true;
    await unlink(temporaryPath).catch(() => {});
  } catch (error) {
    await temporaryHandle?.close();
    if (!published) {
      await unlink(temporaryPath).catch(() => {});
    }
    if (isOutputCollisionError(error)) {
      throw new Error("Discord live observer output already exists and will not be replaced", {
        cause: error,
      });
    }
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === "ENOENT";
}

function isOutputCollisionError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === "EEXIST";
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown Discord live observer failure";
  process.stderr.write(`Discord live observer failed: ${message}\n`);
  process.exitCode = 1;
});
