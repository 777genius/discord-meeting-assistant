import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import type {
  LiveDiscordPlaybackRecordingIdentity,
  LiveDiscordPlaybackRecordingIdentitySource,
} from "./live-discord-playback-link-observer.js";
import { recordingReadyReceiptSchema } from "./recording-ready-receipt.js";

const maximumReceiptBytes = 64 * 1024;

export class RecordingReadyFileIdentitySource implements LiveDiscordPlaybackRecordingIdentitySource {
  public constructor(private readonly path: string) {}

  public async read(): Promise<LiveDiscordPlaybackRecordingIdentity | undefined> {
    let pathStatus;
    try {
      pathStatus = await lstat(this.path);
    } catch (error) {
      if (isNotFound(error)) {return undefined;}
      throw error;
    }
    const owned = typeof process.getuid !== "function" || pathStatus.uid === process.getuid();
    if (pathStatus.isSymbolicLink() || !pathStatus.isFile() || !owned ||
      (pathStatus.mode & 0o777) !== 0o600 || pathStatus.size < 1 || pathStatus.size > maximumReceiptBytes) {
      throw new Error("Playback-link recording-ready input must be an owned regular mode-0600 file");
    }
    const handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      const bytes = new Uint8Array(before.size + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
      const after = await handle.stat();
      if (bytesRead !== before.size || before.dev !== pathStatus.dev || before.ino !== pathStatus.ino ||
        after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
        throw new Error("Playback-link recording-ready input changed while reading");
      }
      const receipt = recordingReadyReceiptSchema.parse(JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead)),
      ) as unknown);
      return Object.freeze({ meetingId: receipt.meetingId, recordingId: receipt.recordingId });
    } finally {
      await handle.close();
    }
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
