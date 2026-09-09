import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OssNativeEvidenceJournal } from "../../../packages/voicetext-adapter/src/oss-native-evidence.js";
import { VoicetextLiveTranscriptionAdapter } from "../../../packages/voicetext-adapter/src/voicetext-live-transcription-adapter.js";
import { collectNativeLive, qualifyNativeSession } from "../../discord-e2e-actors/src/oss-native-live-collection.js";

describe("native collector parsing actual failed connection capture", () => {
  it("discovers every attempted session, verifies exact bytes and rejects failure qualification", async () => {
    const directory = mkdtempSync(join(tmpdir(), "oss-native-collector-"));
    try {
      const revision = "a".repeat(40);
      const journal = new OssNativeEvidenceJournal({
        directory, revision,
        project: "vtoss-test-oss-8f49a06-r1", testOnly: true
      });
      const adapter = new VoicetextLiveTranscriptionAdapter({
        evidenceSink: journal,
        endpoint: "wss://offline.example.test", token: "offline-test-token"
      }, {
        connect: async () => { throw new Error("synthetic offline transport failure"); },
      });
      for (const speakerId of ["speaker-a", "speaker-b"]) {
        await expect(adapter.openSession({
          meetingId: "meeting", speakerId,
          idempotencyKey: speakerId, onTranscript: () => { }
        })).rejects.toThrow();
      }
      await journal.close();
      const bytes = readFileSync(join(directory, "live-native.jsonl"));
      const collected = collectNativeLive(bytes, revision);
      expect(collected.sessions.size).toBe(2);
      for (const session of collected.sessions.values()) { expect(() => qualifyNativeSession(session)).toThrow(); }
      expect(() => collectNativeLive(bytes.subarray(0, -1), revision)).toThrow("truncated");
      expect(() => collectNativeLive(bytes, "b".repeat(40))).toThrow("revision");
      expect(() => collectNativeLive(Buffer.from(bytes.toString().replace("speaker-a", "speaker-c")), revision))
        .toThrow("integrity");
      const lines = bytes.toString().split("\n");
      lines.splice(2, 1);
      expect(() => collectNativeLive(Buffer.from(lines.join("\n")), revision)).toThrow();
    } finally { rmSync(directory, { recursive: true }); }
  });
});

it("collects a completed adapter session from actual transport callbacks and hashes sent packets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oss-native-success-"));
  try {
    const revision = "a".repeat(40);
    const journal = new OssNativeEvidenceJournal({
      directory, revision,
      project: "vtoss-test-oss-8f49a06-r1", testOnly: true
    });
    type Frame = import("../../../packages/voicetext-adapter/src/websocket-connector.js").VoicetextInboundFrame;
    const frames: Frame[] = [];
    let waiter: ((frame: Frame) => void) | undefined;
    const push = (frame: Frame) => {
      if (waiter) { const resolve = waiter; waiter = undefined; resolve(frame); } else { frames.push(frame); }
    };
    const emit = (message: object) => { push({ type: "text", data: JSON.stringify(message) }); };
    const sentPackets: Buffer[] = [];
    const sentMessages: string[] = [];
    const close = vi.fn(async () => { });
    let sent = 0;
    const adapter = new VoicetextLiveTranscriptionAdapter({
      evidenceSink: journal,
      endpoint: "wss://offline.example.test", token: "offline-test-token"
    }, {
      connect: async () => ({
        sendText: async (data) => {
          const message = JSON.parse(data) as { type: string };
          sentMessages.push(message.type);
          if (message.type === "config") {
            emit({
              type: "ready", model: "nova-3", provider: "deepgram",
              session_id: "00000000-0000-4000-8000-000000000001"
            });
          }
          if (message.type === "finalize") {
            emit({ type: "finalize_complete", status: "flushed", saw_result: true });
            // The server closes after its terminal result; the client waits for WS1000.
            push({ type: "close", code: 1000, reason: "finalized" });
          }
        },
        sendBinary: async (data) => {
          sentPackets.push(Buffer.from(data));
          emit({ type: "partial", text: "test", start_ms: 0, duration_ms: 20 });
          emit({ type: "partial", is_segment_final: true, text: "test", start_ms: 0, duration_ms: 20 });
          emit({ type: "ack", seq: ++sent });
        },
        receive: async () => frames.shift() ?? await new Promise<Frame>((resolve) => { waiter = resolve; }),
        close,
        terminate: () => { },
      }),
    });
    const session = await adapter.openSession({
      meetingId: "meeting", speakerId: "speaker",
      idempotencyKey: "session", onTranscript: () => { }
    });
    await session.sendPacket({
      opus: Uint8Array.from([0xf8, 0xff, 0xfe]), packetId: "packet",
      relativeTimeMs: 0, durationSamples48Khz: 960
    });
    await session.finalize();
    expect(sentMessages).toEqual(["config", "finalize"]);
    expect(close).not.toHaveBeenCalled();
    await journal.close();
    const capture = collectNativeLive(readFileSync(join(directory, "live-native.jsonl")), revision);
    expect(capture.sessions.size).toBe(1);
    const rows = [...capture.sessions.values()][0]!;
    expect(sentPackets).toEqual([Buffer.from([0xf8, 0xff, 0xfe])]);
    expect(rows.filter((row) => row.event.type === "audio_send").map((row) => row.event)).toEqual([
      {
        type: "audio_send", seq: 1, packetId: "packet",
        sha256: createHash("sha256").update(sentPackets[0]!).digest("hex"),
        size: 3, toc: 0xf8, relativeTimeMs: 0, durationSamples48Khz: 960,
      },
    ]);
    expect(rows.filter((row) => row.event.type === "close" || row.event.type === "success" ||
      (row.event.type === "received" && row.event.message.type === "finalize_complete"))
      .map((row) => row.event)).toEqual([
        { type: "received", message: { type: "finalize_complete", status: "flushed", sawResult: true } },
        { type: "close", code: 1000 },
        { type: "success" },
      ]);
    expect(qualifyNativeSession(rows).providerSessionId).toBe("00000000-0000-4000-8000-000000000001");
    expect(() => qualifyNativeSession(rows.filter((row) => row.event.type !== "audio_accepted"))).toThrow();
    expect(() => qualifyNativeSession(rows.filter((row) => row.event.type !== "close"))).toThrow();
    expect(() => qualifyNativeSession(rows.filter((row) => !(row.event.type === "received" && row.event.message.type === "ack"))))
      .toThrow();
  } finally { rmSync(directory, { recursive: true }); }
});
