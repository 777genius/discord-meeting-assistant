import { createHash, randomUUID } from "node:crypto";
import { close, closeSync, constants, fstatSync, fsync, linkSync, lstatSync, openSync, write } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { VoicetextServerMessage } from "./protocol.js";

/** Adapter-owned, test-only projection. Never receives connection configuration. */
export type OssSessionEvidenceEvent =
  | { type: "opening"; meetingId: string; speakerId: string; clientSessionId: string }
  | {
    type: "audio_send"; seq: number; packetId: string; sha256: string; size: number; toc: number;
    relativeTimeMs: number; durationSamples48Khz: number
  }
  | { type: "audio_sent" | "audio_accepted"; seq: number }
  | { type: "finalize_send" | "finalize_sent" | "terminated" | "failure" | "success" }
  | { type: "close"; code: number }
  | { type: "transcript_emitted"; startMs: number; endMs: number; text: string; isFinal: boolean }
  | { type: "received"; message: Exclude<VoicetextServerMessage, { type: "error" }> | { type: "error" } };

export interface OssSessionEvidence {
  record(event: OssSessionEvidenceEvent): void;
}
export interface OssNativeEvidenceSink {
  open(): OssSessionEvidence;
}

/** One exclusive staging journal per admitted process. A crash or failed close
 * leaves no published journal. All attempted sessions (including failed opens) share the journal.
 * Enqueue snapshots are bounded; one asynchronous writer preserves receive order.
 * Integrators must await close() before qualifying or archiving the journal.
 */
export class OssNativeEvidenceJournal implements OssNativeEvidenceSink {
  private readonly fd: number;
  private readonly stagingPath: string;
  private readonly publishedPath: string;
  private readonly digest = createHash("sha256");
  private sequence = 0;
  private bytes = 0;
  private failed = false;
  private closed = false;
  private closing = false;
  private closeResult?: Promise<void>;
  private queue: Buffer[] = [];
  private queuedBytes = 0;
  private writer: Promise<void> = Promise.resolve();
  private writing = false;
  private readonly maximumQueuedBytes: number;
  private readonly pending = new Set<string>();
  public constructor(input: {
    directory: string; project: string; testOnly: boolean; revision: string;
    maximumBytes?: number; maximumQueuedBytes?: number;
  }) {
    if (!input.testOnly || input.project !== "vtoss-test-oss-8f49a06-r1" ||
      !/^[a-f0-9]{40}$/u.test(input.revision) || !isAbsolute(input.directory)) {
      throw new Error("OSS capture requires explicit isolated TEST admission and exact revision");
    }
    this.maximumBytes = input.maximumBytes ?? 256 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maximumBytes) || this.maximumBytes < 1024 ||
      this.maximumBytes > 256 * 1024 * 1024) { throw new Error("Invalid OSS capture bound"); }
    this.maximumQueuedBytes = input.maximumQueuedBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(this.maximumQueuedBytes) || this.maximumQueuedBytes < 1024 ||
      this.maximumQueuedBytes > 4 * 1024 * 1024) { throw new Error("Invalid OSS queue bound"); }
    this.stagingPath = join(input.directory, "live-native.staging.jsonl");
    this.publishedPath = join(input.directory, "live-native.jsonl");
    // Refuse existing final entries, including dangling symlinks. linkSync below
    // independently enforces create-only publication against races.
    try {
      lstatSync(this.publishedPath);
      throw this.captureError();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") { throw error; }
    }
    this.fd = openSync(this.stagingPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    if (!fstatSync(this.fd).isFile()) {
      closeSync(this.fd);
      throw new Error("OSS capture must be a regular file");
    }
    this.append({
      type: "capture_start", kind: "oss-native-live-v1",
      project: input.project, revision: input.revision
    });
  }
  private readonly maximumBytes: number;
  public open(): OssSessionEvidence {
    if (this.closing || this.closed || this.failed) { throw this.captureError(); }
    if (this.pending.size >= 4096) { this.failed = true; throw this.captureError(); }
    const session = randomUUID();
    this.pending.add(session);
    return {
      record: (event) => {
        this.append({ session, event });
        if (["success", "failure", "terminated"].includes(event.type)) { this.pending.delete(session); }
      }
    };
  }
  /** Legacy synchronous composition must fail visibly until migrated to await close(). */
  public seal(): void {
    if (!this.closed || this.failed) {
      throw new Error("OSS native capture requires await close(); archive cannot qualify");
    }
  }
  /** Durable barrier for all rows admitted before this call; does not seal. */
  public async settle(): Promise<void> {
    await this.writer;
    if (this.failed) { throw this.captureError(); }
  }
  /** Freeze admission, durably drain, then append and sync the seal and close. */
  public close(): Promise<void> {
    if (this.closeResult) { return this.closeResult; }
    this.closing = true;
    if (this.pending.size > 0) { this.failed = true; }
    this.closeResult = this.finishClose();
    return this.closeResult;
  }
  private async finishClose(): Promise<void> {
    try {
      await this.settle();
      const row = this.snapshot({ type: "capture_seal", priorSha256: this.digest.copy().digest("hex") });
      await this.writeRow(row);
      await this.sync();
    } catch {
      this.failed = true;
    } finally {
      await new Promise<void>((resolve) => {
        close(this.fd, (error) => { if (error) { this.failed = true; } resolve(); });
      });
      this.closed = true;
    }
    if (this.failed) { throw this.captureError(); }
    // No asynchronous gap after the final sticky-failure check. The staging
    // inode has completed data/seal fsync AND descriptor close before it can
    // acquire the sole name trusted by final collection. No rollback is needed.
    // Publication is the last fallible operation: never fsync the directory
    // afterwards and reject with an already visible final entry. A power loss
    // may lose this unsynced directory entry; if retained, it names synced bytes.
    // Missing publication always fails collection closed. Retain staging so no
    // cleanup failure can turn successful publication into a rejected close.
    try { linkSync(this.stagingPath, this.publishedPath); }
    catch { this.failed = true; throw this.captureError(); }
  }
  private captureError(): Error {
    return new Error("OSS native capture failed; archive cannot qualify");
  }
  private snapshot(payload: object): Buffer {
    const row = Buffer.from(JSON.stringify({ index: ++this.sequence, atMs: Date.now(), ...payload }) + "\n");
    if (row.length > 128 * 1024 || this.bytes + row.length > this.maximumBytes) {
      throw this.captureError();
    }
    return row;
  }
  private append(payload: object): void {
    if (this.failed || this.closed || this.closing) { this.failed = true; return; }
    try {
      const row = this.snapshot(payload);
      if (this.queuedBytes + row.length > this.maximumQueuedBytes) { throw this.captureError(); }
      this.bytes += row.length;
      this.queuedBytes += row.length;
      this.digest.update(row);
      this.queue.push(row);
      if (!this.writing) {
        this.writing = true;
        this.writer = this.drain();
      }
    } catch { this.failed = true; }
  }
  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0 && !this.failed) {
        const batch = this.queue;
        this.queue = [];
        for (const row of batch) { await this.writeRow(row); }
        await this.sync();
        for (const row of batch) { this.queuedBytes -= row.length; }
      }
    } catch { this.failed = true; }
    finally {
      this.queue = [];
      this.queuedBytes = 0;
      this.writing = false;
    }
  }
  private async writeRow(row: Buffer): Promise<void> {
    let offset = 0;
    while (offset < row.length) {
      const count = await new Promise<number>((resolve, reject) => {
        write(this.fd, row, offset, row.length - offset, null, (error, written) => {
          if (error) { reject(error); } else { resolve(written); }
        });
      });
      if (count <= 0 || count > row.length - offset) { throw this.captureError(); }
      offset += count;
    }
  }
  private sync(): Promise<void> {
    return new Promise((resolve, reject) => {
      fsync(this.fd, (error) => { if (error) { reject(error); } else { resolve(); } });
    });
  }
}

export function ossReceivedEvidence(message: VoicetextServerMessage): OssSessionEvidenceEvent {
  // Provider error strings can contain credentials/URLs. Retain occurrence only.
  return { type: "received", message: message.type === "error" ? { type: "error" } : message };
}
