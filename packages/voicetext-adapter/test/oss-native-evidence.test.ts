import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { OssNativeEvidenceJournal, ossReceivedEvidence } from "../src/oss-native-evidence.js";
import { VoicetextLiveTranscriptionAdapter } from "../src/voicetext-live-transcription-adapter.js";

const directories: string[] = [];
function journal(maximumBytes?: number) {
  const directory = mkdtempSync(join(tmpdir(), "oss-native-test-"));
  directories.push(directory);
  return {
    directory, sink: new OssNativeEvidenceJournal({
      directory,
      project: "vtoss-test-oss-8f49a06-r1", testOnly: true, revision: "a".repeat(40),
      ...(maximumBytes === undefined ? {} : { maximumBytes })
    })
  };
}
afterEach(() => { for (const dir of directories.splice(0)) { rmSync(dir, { recursive: true }); } });
describe("native OSS session journal", async () => {
  it("retains a failed actual connector attempt without retaining its secrets", async () => {
    const { directory, sink } = journal();
    const adapter = new VoicetextLiveTranscriptionAdapter({
      endpoint: "wss://secret.example.test/credential", token: "private-token-value", evidenceSink: sink,
    }, { connect: async () => { throw new Error("private-token-value"); } });
    await expect(adapter.openSession({
      meetingId: "meeting-1", speakerId: "speaker-1",
      idempotencyKey: "session-1", onTranscript: () => { }
    })).rejects.toThrow();
    await sink.close();
    const text = readFileSync(join(directory, "live-native.jsonl"), "utf8");
    expect(text).not.toMatch(/private-token|secret.example|credential/u);
    const rows = text.trimEnd().split("\n").map((line) => JSON.parse(line) as { event?: { type: string }; type?: string; session?: string; priorSha256?: string });
    expect(rows.map((row) => row.event?.type ?? row.type)).toEqual([
      "capture_start", "opening", "failure", "capture_seal",
    ]);
    expect(rows[1]!.session).toBe(rows[2]!.session);
    expect(rows[3]!.priorSha256).toBe(createHash("sha256").update(
      text.slice(0, text.lastIndexOf('{"index":4'))).digest("hex"));
  });
  it("never seals a truncated capture and never overwrites the journal", async () => {
    const { directory, sink } = journal(1024);
    const session = sink.open();
    for (let index = 0; index < 100; index++) { session.record({ type: "failure" }); }
    await expect(sink.close()).rejects.toThrow("capture failed");
    expect(readFileSync(join(directory, "live-native.jsonl"), "utf8")).not.toContain("capture_seal");
    expect(() => new OssNativeEvidenceJournal({
      directory, project: "vtoss-test-oss-8f49a06-r1",
      revision: "a".repeat(40), testOnly: true
    })).toThrow();
  });
  it("does not seal an open session", async () => {
    const { directory, sink } = journal();
    sink.open().record({
      type: "opening", meetingId: "meeting", speakerId: "speaker",
      clientSessionId: "00000000-0000-4000-8000-000000000001"
    });
    await expect(sink.close()).rejects.toThrow("capture failed");
    expect(readFileSync(join(directory, "live-native.jsonl"), "utf8")).not.toContain("capture_seal");
  });
  it("drops provider error bodies and codes", () => {
    expect(ossReceivedEvidence({ type: "error", code: "secret", message: "https://secret" }))
      .toEqual({ type: "received", message: { type: "error" } });
  });
  it("denies production admission", () => {
    expect(() => new OssNativeEvidenceJournal({
      directory: "/tmp", project: "production",
      testOnly: true, revision: "a".repeat(40)
    })).toThrow("TEST admission");
  });
});
