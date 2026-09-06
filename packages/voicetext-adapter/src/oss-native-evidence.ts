import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync, writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { VoicetextServerMessage } from "./protocol.js";

/** Adapter-owned, test-only projection. Never receives connection configuration. */
export type OssSessionEvidenceEvent =
  | { type: "opening"; meetingId: string; speakerId: string; clientSessionId: string }
  | { type: "audio_send"; seq: number; packetId: string; sha256: string; size: number; toc: number;
      relativeTimeMs: number; durationSamples48Khz: number }
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

/** One exclusive append-only journal per admitted process. A crash or failed write
 * leaves no seal. All attempted sessions (including failed opens) share the journal.
 * Synchronous bounded writes avoid an unbounded queue and preserve receive order.
 */
export class OssNativeEvidenceJournal implements OssNativeEvidenceSink {
  private readonly fd: number;
  private readonly digest = createHash("sha256");
  private sequence = 0;
  private bytes = 0;
  private failed = false;
  private closed = false;
  private readonly pending = new Set<string>();
  public constructor(input: {
    directory: string; project: string; testOnly: boolean; revision: string;
    maximumBytes?: number;
  }) {
    if (!input.testOnly || input.project !== "vtoss-test-oss-8f49a06-r1" ||
        !/^[a-f0-9]{40}$/u.test(input.revision) || !isAbsolute(input.directory)) {
      throw new Error("OSS capture requires explicit isolated TEST admission and exact revision");
    }
    this.maximumBytes = input.maximumBytes ?? 256 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maximumBytes) || this.maximumBytes < 1024 ||
        this.maximumBytes > 256 * 1024 * 1024) throw new Error("Invalid OSS capture bound");
    this.fd = openSync(join(input.directory, "live-native.jsonl"),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    this.append({ type: "capture_start", kind: "oss-native-live-v1",
      project: input.project, revision: input.revision });
  }
  private readonly maximumBytes: number;
  public open(): OssSessionEvidence {
    const session = randomUUID();
    this.pending.add(session);
    return { record: (event) => {
      this.append({ session, event });
      if (["success", "failure", "terminated"].includes(event.type)) this.pending.delete(session);
    } };
  }
  public seal(): void {
    if (this.closed) return;
    if (this.pending.size > 0) this.failed = true;
    if (!this.failed) this.append({ type: "capture_seal", priorSha256: this.digest.copy().digest("hex") });
    this.closed = true;
    closeSync(this.fd);
    if (this.failed) throw new Error("OSS native capture failed; archive cannot qualify");
  }
  private append(payload: object): void {
    if (this.failed || this.closed) { this.failed = true; return; }
    try {
      const row = Buffer.from(JSON.stringify({ index: ++this.sequence, atMs: Date.now(), ...payload }) + "\n");
      if (row.length > 128 * 1024 || this.bytes + row.length > this.maximumBytes) {
        throw new Error("OSS capture bound exhausted");
      }
      let written = 0;
      while (written < row.length) {
        const count = writeSync(this.fd, row, written, row.length - written);
        if (count === 0) throw new Error("OSS capture short write");
        written += count;
      }
      fsyncSync(this.fd);
      this.bytes += row.length;
      this.digest.update(row);
    } catch { this.failed = true; }
  }
}

export function ossReceivedEvidence(message: VoicetextServerMessage): OssSessionEvidenceEvent {
  // Provider error strings can contain credentials/URLs. Retain occurrence only.
  return { type: "received", message: message.type === "error" ? { type: "error" } : message };
}
