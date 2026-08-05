import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { RecordingIngressError } from "./errors.js";

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RecordingIngressError("corrupt-spool", "spool ownership marker is not an object");
  }
  return value as Record<string, unknown>;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * A deliberately fail-closed owner marker for one local spool root. It is not
 * a distributed lease: a stale marker requires an explicit stop-first recovery
 * decision instead of guessing that another writer is gone.
 */
export class SpoolOwnerLock {
  readonly #path: string;
  #ownerToken: string | undefined;

  public constructor(root: string) {
    this.#path = join(root, "owner-v1.lock");
  }

  public async claim(): Promise<void> {
    if (this.#ownerToken !== undefined) {
      return;
    }
    const ownerToken = randomUUID();
    const handle = await this.#create();
    try {
      await handle.writeFile(`${JSON.stringify({ ownerToken, schemaVersion: 1 })}\n`);
      await handle.sync();
    } catch (error) {
      await handle.close();
      // A partially durable marker must remain fail-closed. Removing it here
      // could admit a second writer after an uncertain filesystem outcome.
      throw error;
    }
    await handle.close();
    await syncDirectory(dirname(this.#path));
    this.#ownerToken = ownerToken;
  }

  public async release(): Promise<void> {
    const ownerToken = this.#ownerToken;
    if (ownerToken === undefined) {
      return;
    }
    const stats = await lstat(this.#path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new RecordingIngressError("path-policy", "spool ownership marker is unsafe");
    }
    let stored: Record<string, unknown>;
    try {
      stored = objectValue(JSON.parse(await readFile(this.#path, "utf8")));
    } catch (error) {
      if (error instanceof RecordingIngressError) {
        throw error;
      }
      throw new RecordingIngressError("corrupt-spool", "spool ownership marker is invalid JSON", {
        cause: error,
      });
    }
    if (stored.schemaVersion !== 1 || stored.ownerToken !== ownerToken) {
      throw new RecordingIngressError(
        "corrupt-spool",
        "spool ownership marker changed before the owner stopped",
      );
    }
    await rm(this.#path, { force: false });
    await syncDirectory(dirname(this.#path));
    this.#ownerToken = undefined;
  }

  async #create() {
    try {
      return await open(this.#path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new RecordingIngressError(
          "invalid-state",
          "recording ingress spool is already owned; stop the active owner before starting another",
        );
      }
      throw error;
    }
  }
}
