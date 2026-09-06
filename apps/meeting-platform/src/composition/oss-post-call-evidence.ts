import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { FinalTranscriptionPort } from "@discord-meeting/meeting-core/transcription";
import type { SummaryGenerationPort } from "@discord-meeting/meeting-core/meeting-intelligence";
import type { SummaryPublicationPort } from "@discord-meeting/meeting-core/publishing";

type Stage = "transcription" | "summary" | "publication";
/** Native port invocation timestamps, including failed attempts. No requests,
 * provider errors, content, object URLs or credentials are serialized. */
export class OssPostCallEvidence {
  private readonly fd: number;
  private readonly hash = createHash("sha256");
  private index = 0;
  private bytes = 0;
  private attempts = 0;
  private active = 0;
  private failed = false;
  private closed = false;
  public constructor(directory: string, revision: string) {
    this.fd = openSync(join(directory, "post-call-native.jsonl"),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    this.append({ type: "capture_start", kind: "oss-native-post-call-v1", revision });
  }
  public wrap(input: {
    transcriber: FinalTranscriptionPort; summarizer: SummaryGenerationPort; publisher: SummaryPublicationPort;
  }) {
    return {
      transcriber: {
        transcribe: (request) => this.measure("transcription", request.meetingId,
          () => input.transcriber.transcribe(request))
      } satisfies FinalTranscriptionPort,
      summarizer: {
        generate: (request) => this.measure("summary", request.meetingId,
          () => input.summarizer.generate(request))
      } satisfies SummaryGenerationPort,
      publisher: {
        publish: (request) => this.measure("publication", request.meetingId,
          () => input.publisher.publish(request))
      } satisfies SummaryPublicationPort,
    };
  }
  public seal(): void {
    if (this.closed) { return; }
    if (this.active !== 0) { this.failed = true; }
    if (!this.failed) { this.append({ type: "capture_seal", priorSha256: this.hash.copy().digest("hex") }); }
    this.closed = true;
    closeSync(this.fd);
    if (this.failed) { throw new Error("OSS post-call capture incomplete"); }
  }
  private async measure<T extends { readonly ok: boolean }>(
    stage: Stage, meetingId: string, operation: () => Promise<T>,
  ): Promise<T> {
    const attempt = ++this.attempts;
    this.active++;
    this.append({ type: "started", stage, meetingId, attempt });
    try {
      const result = await operation();
      this.append({ type: result.ok ? "succeeded" : "failed", stage, meetingId, attempt });
      return result;
    } catch (error) {
      this.append({ type: "threw", stage, meetingId, attempt });
      throw error;
    } finally { this.active--; }
  }
  private append(payload: object): void {
    if (this.closed || this.failed) { this.failed = true; return; }
    try {
      const row = Buffer.from(JSON.stringify({ index: ++this.index, atMs: Date.now(), ...payload }) + "\n");
      if (row.length > 4096 || this.bytes + row.length > 1024 * 1024) { throw new Error("Capture bound"); }
      let offset = 0;
      while (offset < row.length) {
        const count = writeSync(this.fd, row, offset, row.length - offset);
        if (!count) { throw new Error("Short capture write"); }
        offset += count;
      }
      fsyncSync(this.fd);
      this.bytes += row.length;
      this.hash.update(row);
    } catch { this.failed = true; }
  }
}
