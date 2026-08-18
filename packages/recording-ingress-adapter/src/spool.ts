import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";

import { RecordingIngressError } from "./errors.js";
import { SpoolOwnerLock } from "./spool-owner-lock.js";
import {
  parseAbortedRecordingState,
  parseCompletedRecordingState,
  parseRecordingSpoolState,
  type AbortedRecordingState,
  type CompletedRecordingState,
  type RecordingSpoolState,
} from "./spool-state.js";
import { terminalReceiptTokens } from "./spool-terminal-receipts.js";

export {
  type AbortedRecordingState,
  type CompletedRecordingState,
  type RecordingSpoolState,
  type StoredAuthoritativeTrack,
  type StoredActor,
  type StoredIdentityProvenance,
  type StoredLifecycleEvent,
  type StoredSpeaker,
} from "./spool-state.js";

export function spoolToken(namespace: string, identifier: string): string {
  return createHash("sha256").update(namespace).update("\0").update(identifier).digest("hex");
}

let atomicWriteSequence = 0;

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  atomicWriteSequence += 1;
  const temporaryPath = `${path}.tmp-${process.pid}-${atomicWriteSequence}`;
  const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporaryPath, { force: true });
    throw error;
  }
  await handle.close();
  await rename(temporaryPath, path);
  await syncDirectory(dirname(path));
}

export class DurableSpool {
  public readonly abortedRoot: string;
  public readonly activeRoot: string;
  public readonly completedRoot: string;
  public readonly root: string;
  #initialization: Promise<void> | undefined;
  readonly #ownerLock: SpoolOwnerLock;

  public constructor(root: string) {
    if (!isAbsolute(root)) {
      throw new RecordingIngressError("path-policy", "spool root must be absolute");
    }
    this.root = resolve(root);
    if (this.root === parse(this.root).root) {
      throw new RecordingIngressError("path-policy", "filesystem root cannot be used as spool root");
    }
    this.abortedRoot = join(this.root, "aborted-v1");
    this.activeRoot = join(this.root, "active-v1");
    this.completedRoot = join(this.root, "completed-v1");
    this.#ownerLock = new SpoolOwnerLock(this.root);
  }

  async #initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootStats = await lstat(this.root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new RecordingIngressError("path-policy", "spool root cannot be a symlink");
    }
    await mkdir(this.abortedRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.activeRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.completedRoot, { recursive: true, mode: 0o700 });
    for (const path of [this.abortedRoot, this.activeRoot, this.completedRoot]) {
      const stats = await lstat(path);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new RecordingIngressError("path-policy", "spool namespace is unsafe");
      }
    }
  }

  public async ready(): Promise<void> {
    this.#initialization ??= this.#initialize();
    await this.#initialization;
  }

  public recordingDirectory(recordingId: string): string {
    return join(this.activeRoot, spoolToken("recording-v1", recordingId));
  }

  public metadataPath(recordingId: string): string {
    return join(this.recordingDirectory(recordingId), "metadata.json");
  }

  public speakerDirectory(recordingId: string): string {
    return join(this.recordingDirectory(recordingId), "speakers");
  }

  public speakerJournalPath(recordingId: string, fileToken: string): string {
    if (!/^[a-f\d]{64}$/u.test(fileToken)) {
      throw new RecordingIngressError("path-policy", "invalid speaker spool token");
    }
    return join(this.speakerDirectory(recordingId), `${fileToken}.packets`);
  }

  public completedPath(recordingId: string): string {
    return join(this.completedRoot, `${spoolToken("recording-v1", recordingId)}.json`);
  }

  public abortedPath(recordingId: string): string {
    return join(this.abortedRoot, `${spoolToken("recording-v1", recordingId)}.json`);
  }

  public async createRecordingDirectories(recordingId: string): Promise<void> {
    await this.ready();
    const recordingDirectory = this.recordingDirectory(recordingId);
    await mkdir(recordingDirectory, { recursive: true, mode: 0o700 });
    const stats = await lstat(recordingDirectory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new RecordingIngressError("path-policy", "recording spool path is unsafe");
    }
    const speakerDirectory = this.speakerDirectory(recordingId);
    await mkdir(speakerDirectory, { recursive: true, mode: 0o700 });
    const speakerStats = await lstat(speakerDirectory);
    if (!speakerStats.isDirectory() || speakerStats.isSymbolicLink()) {
      throw new RecordingIngressError("path-policy", "speaker spool path is unsafe");
    }
  }

  public async activeRecordingCount(): Promise<number> {
    await this.ready();
    const [activeEntries, abortedTokens, completedTokens] = await Promise.all([
      readdir(this.activeRoot, { withFileTypes: true }),
      terminalReceiptTokens(this.abortedRoot, parseAbortedRecordingState, (recordingId) => spoolToken("recording-v1", recordingId)),
      terminalReceiptTokens(this.completedRoot, parseCompletedRecordingState, (recordingId) => spoolToken("recording-v1", recordingId)),
    ]);
    const terminalTokens = new Set([...abortedTokens, ...completedTokens]);
    return activeEntries.filter(
      (entry) =>
        entry.isDirectory() &&
        /^[a-f\d]{64}$/u.test(entry.name) &&
        !terminalTokens.has(entry.name),
    ).length;
  }

  public async claimExclusiveOwnership(): Promise<void> {
    await this.ready();
    await this.#ownerLock.claim();
  }

  public async releaseExclusiveOwnership(): Promise<void> {
    await this.#ownerLock.release();
  }

  public async readRecording(recordingId: string): Promise<RecordingSpoolState | undefined> {
    await this.ready();
    try {
      return parseRecordingSpoolState(JSON.parse(await readFile(this.metadataPath(recordingId), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      if (error instanceof SyntaxError) {
        throw new RecordingIngressError("corrupt-spool", "spool metadata is invalid JSON", {
          cause: error,
        });
      }
      throw error;
    }
  }

  public async writeRecording(state: RecordingSpoolState): Promise<void> {
    await this.createRecordingDirectories(state.recordingId);
    await atomicWriteJson(this.metadataPath(state.recordingId), state);
  }

  public async readAborted(recordingId: string): Promise<AbortedRecordingState | undefined> {
    await this.ready();
    try {
      return parseAbortedRecordingState(
        JSON.parse(await readFile(this.abortedPath(recordingId), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      if (error instanceof SyntaxError) {
        throw new RecordingIngressError("corrupt-spool", "aborted receipt is invalid JSON", {
          cause: error,
        });
      }
      throw error;
    }
  }

  public async archiveAborted(state: RecordingSpoolState): Promise<AbortedRecordingState> {
    await this.ready();
    const aborted = parseAbortedRecordingState(state);
    await atomicWriteJson(this.abortedPath(aborted.recordingId), aborted);
    await this.cleanupActive(aborted.recordingId);
    return aborted;
  }

  public async readCompleted(recordingId: string): Promise<CompletedRecordingState | undefined> {
    await this.ready();
    try {
      return parseCompletedRecordingState(
        JSON.parse(await readFile(this.completedPath(recordingId), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      if (error instanceof SyntaxError) {
        throw new RecordingIngressError("corrupt-spool", "completion receipt is invalid JSON", {
          cause: error,
        });
      }
      throw error;
    }
  }

  public async writeCompleted(state: CompletedRecordingState): Promise<void> {
    await this.ready();
    await atomicWriteJson(this.completedPath(state.recordingId), state);
  }

  public async cleanupActive(recordingId: string): Promise<void> {
    await this.ready();
    await rm(this.recordingDirectory(recordingId), { recursive: true, force: true });
    await syncDirectory(this.activeRoot);
  }
}
