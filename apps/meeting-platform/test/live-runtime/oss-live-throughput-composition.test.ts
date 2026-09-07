import * as fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTask } from "node:timers/promises";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { parseCraigLifecycleEvent, parseVoicePacketBatch } from "@discord-meeting/craig-gateway-contracts";
import { DurableCraigRecordingIngress, opusPacketDurationSamples } from "@discord-meeting/recording-ingress-adapter";
import { OssNativeEvidenceJournal, VoicetextLiveTranscriptionAdapter,
  type VoicetextInboundFrame, type VoicetextWebSocketConnection,
  type OssSessionEvidenceEvent } from "@discord-meeting/voicetext-adapter";
import { PlatformLiveMeetingRuntime } from "../../src/live-meeting-runtime.js";
import { AppendLiveTranscriptTurn, FinishLiveMeeting, RefreshLiveMeeting, StartLiveMeeting } from "@discord-meeting/meeting-core/live-meeting";
import { livePacketIdentity } from "../../src/live-runtime/packet-delivery-ledger.js";
import { logger, packets, started, MemoryLiveMeetingRepository, ProjectionStub, SummaryStub } from "./live-runtime-fixtures.js";

// Delay only external durability completions; retain real bytes, fsync and adapters.
const io = vi.hoisted(() => ({ holdJournal: true, journal: [] as (() => void)[],
  holdReceipt: false, receipts: [] as (() => void)[], syncs: 0, reads: 0, durableRows: [] as string[] }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, fsync: (fd: number, callback: (error: NodeJS.ErrnoException | null) => void) => {
    actual.fsync(fd, (error) => {
      const done = () => { callback(error); };
      if (io.holdJournal) { io.journal.push(done); } else { done(); }
    });
  } };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual,
    readFile: (...args: Parameters<typeof fs.readFile>) => {
      if (typeof args[0] === "string" && args[0].includes("live-delivery-v1/") && args[0].endsWith(".jsonl")) { io.reads++; }
      return actual.readFile(...args);
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await actual.open(...args);
      if (typeof args[0] === "string" && args[0].includes("live-delivery-v1/") && args[0].endsWith(".jsonl")) {
        // Keep receipt bytes local to the descriptor that actually wrote them.
        // Directory fsync and metadata probes are not JSONL evidence reads.
        const pendingRows: string[] = [];
        const writeFile = handle.writeFile.bind(handle);
        handle.writeFile = async (...writeArgs: Parameters<typeof handle.writeFile>) => {
          await writeFile(...writeArgs);
          if (typeof writeArgs[0] !== "string") { throw new Error("expected textual delivery receipt"); }
          for (const line of writeArgs[0].trimEnd().split("\n")) {
            const row = JSON.parse(line) as { type: string; packetId: string };
            if (row.type === "delivered") { pendingRows.push(row.packetId); }
          }
        };
        handle.read = new Proxy(handle.read.bind(handle), {
          apply(target, receiver, readArgs) {
            io.reads++;
            return Reflect.apply(target, receiver, readArgs) as ReturnType<typeof handle.read>;
          },
        });
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          const rows = pendingRows.splice(0);
          await sync(); io.syncs++;
          if (io.holdReceipt) { await new Promise<void>((resolve) => { io.receipts.push(resolve); }); }
          io.durableRows.push(...rows);
        };
      }
      return handle;
    },
  };
});

class Gateway implements VoicetextWebSocketConnection {
  public sent = 0;
  public acked = 0;
  public finalizeCount = 0;
  public closeCount = 0;
  public terminated = 0;
  public hold = false;
  public release: (() => void) | undefined;
  private readonly frames: VoicetextInboundFrame[] = [];
  private waiter: ((frame: VoicetextInboundFrame) => void) | undefined;
  private push(frame: VoicetextInboundFrame): void {
    const waiter = this.waiter;
    if (waiter) { this.waiter = undefined; waiter(frame); } else { this.frames.push(frame); }
  }
  private message(value: object): void { this.push({ type: "text", data: JSON.stringify(value) }); }
  public async sendText(data: string): Promise<void> {
    const value = JSON.parse(data) as { type: string; provider: string; model: string };
    if (value.type === "config") {
      this.message({ type: "ready", provider: value.provider, model: value.model,
        session_id: "00000000-0000-4000-8000-000000000001" });
    }
    if (value.type === "finalize") {
      this.finalizeCount++;
      this.message({ type: "final", start_ms: 0, duration_ms: this.sent * 20, text: "Synthetic final turn." });
      this.message({ type: "finalize_complete", status: "flushed", saw_result: true });
    }
  }
  public async sendBinary(data: Uint8Array): Promise<void> {
    expect([...data]).toEqual([0xf8, 0xff, 0xfe]);
    this.sent++;
    expect(this.sent - this.acked).toBe(1);
    const ack = () => { this.acked++; this.message({ type: "ack", seq: this.acked }); };
    if (this.hold) { this.release = ack; } else { ack(); }
  }
  public async receive(signal: AbortSignal): Promise<VoicetextInboundFrame> {
    signal.throwIfAborted();
    const frame = this.frames.shift();
    if (frame) { return frame; }
    return new Promise((resolve, reject) => {
      const abort = () => { this.waiter = undefined; reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      this.waiter = (next) => { signal.removeEventListener("abort", abort); resolve(next); };
    });
  }
  public async close(): Promise<void> { this.closeCount++; this.push({ type: "close", code: 1000, reason: "finalized" }); }
  public terminate(): void { this.terminated++; }
}

async function until(predicate: () => boolean): Promise<void> {
  // Real IO may finish at any host speed; it never advances the source clock.
  for (let attempts = 0; attempts < 100_000; attempts++) {
    if (predicate()) { return; }
    await nextTask();
  }
  throw new Error("bounded offline IO completion did not arrive");
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("composes full two-speaker Opus load, nonblocking native capture and indexed durable healthy drain past 2s", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "oss-live-throughput-"));
  const recordingId = "recording-live-1";
  // Synthetic journal fixture configuration, not source-head provenance.
  const fixtureRevision = "0940859cd6b3100ec66364207f3e5474b2720c38";
  const counts = [Math.ceil(26_235 / 20), Math.ceil(48_361 / 20)];
  expect(counts).toEqual([1312, 2419]);
  const streams = counts.map((count, speaker) => Array.from({ length: count }, (_, index) => ({
    ...packets().packets[0]!, speakerId: `3333333333333333${speaker}`,
    sequenceNumber: index, mediaTimestamp: index * 960,
    relativeTimeMs: (counts[1]! - count + index) * 20,
    receivedAtMs: (counts[1]! - count + index) * 20,
  })));
  const all = streams.flat().toSorted((a, b) => a.relativeTimeMs - b.relativeTimeMs || a.speakerId.localeCompare(b.speakerId));
  const ingress = new DurableCraigRecordingIngress({ spoolRoot: join(root, "spool"),
    artifactLocatorPrefix: "offline", writer: { write: async () => { throw new Error("unexpected original publication"); } } });
  const journal = new OssNativeEvidenceJournal({ directory: root, project: "vtoss-test-oss-8f49a06-r1",
    testOnly: true, revision: fixtureRevision });
  let runtime: PlatformLiveMeetingRuntime | undefined;
  try {
    await ingress.ingestLifecycleEvent(parseCraigLifecycleEvent({ schemaVersion: 1,
      type: "meeting.started", eventId: "offline-start", recordingId,
      guildId: "11111111111111111", channelId: "22222222222222222",
      occurredAt: new Date(0).toISOString(), participantIds: streams.map((stream) => stream[0]!.speakerId) }));
    for (let start = 0; start < all.length; start += 100) {
      await ingress.ingestPacketBatch(parseVoicePacketBatch({ schemaVersion: 1,
        packets: all.slice(start, start + 100).map((packet) => ({
          schemaVersion: 1, guildId: "11111111111111111", channelId: "22222222222222222",
          recordingId, speakerId: packet.speakerId, relativeTimeMs: packet.relativeTimeMs,
          receivedAtMs: packet.receivedAtMs, rtpSequence: packet.sequenceNumber,
          rtpTimestamp: packet.mediaTimestamp, opusBase64: packet.payloadBase64,
        })) }));
    }
    await until(() => io.journal.length === 1);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(0);
    const sockets: Gateway[] = [];
    const transcriber = new VoicetextLiveTranscriptionAdapter({ endpoint: "ws://offline.invalid",
      token: "synthetic-offline-token", evidenceSink: journal }, { connect: async () => {
        const socket = new Gateway(); sockets.push(socket); return socket;
      } });
    const delivered: string[] = [];
    const meetings = new MemoryLiveMeetingRepository();
    const projector = new ProjectionStub();
    runtime = new PlatformLiveMeetingRuntime({
      logger, appendTurn: new AppendLiveTranscriptTurn(meetings),
      finishMeeting: new FinishLiveMeeting(meetings),
      refreshMeeting: new RefreshLiveMeeting({ meetings, projector, summarizer: new SummaryStub() }),
      startMeeting: new StartLiveMeeting({ meetings }),
      packetFlowControl: { maximumQueuedPacketsPerSpeaker: 512, maximumQueuedPacketsGlobally: 1024,
        maximumConcurrentSessions: 2, packetBackpressureTimeoutMs: 2000 },
      packetInspector: { durationSamples48Khz: opusPacketDurationSamples }, transcriber,
      markLivePacketDelivered: async (id) => {
        expect(await ingress.markLivePacketDelivered(id)).toBe("marked"); delivered.push(id);
      },
    });
    await runtime.acceptLifecycle({ ...started(), occurredAt: new Date(0).toISOString() });
    // Exercise real historical offset reads before measuring the indexed drain.
    const beforePendingReads = io.reads;
    expect((await ingress.pendingLivePackets(recordingId)).map(livePacketIdentity))
      .toEqual(all.map(livePacketIdentity));
    expect(io.reads - beforePendingReads).toBeGreaterThanOrEqual(3731);
    const reads = io.reads;
    const syncs = io.syncs;
    // Last 200 packets per speaker remain queued at meeting end. Their first
    // ACK is held for <4s, within the real provider ACK budget.
    const tailStart = (counts[1]! - 200) * 20;
    let admitted = 0;
    for (let time = 0; time < counts[1]! * 20; time += 20) {
      await vi.advanceTimersByTimeAsync(time - Date.now());
      if (time === tailStart) { sockets.forEach((socket) => { socket.hold = true; }); }
      for (const stream of streams) {
        const packet = stream.find((candidate) => candidate.relativeTimeMs === time);
        if (packet) { await runtime.acceptVoiceBatch({ format: packets().format, packets: [packet] }); admitted++; }
      }
      if (time < tailStart) { await until(() => delivered.length === admitted); }
      for (const stream of streams) {
        const queued = stream.filter((p) => p.relativeTimeMs <= time).length -
          delivered.filter((id) => id.split(":")[1] === stream[0]!.speakerId).length;
        expect(queued).toBeLessThanOrEqual(512);
      }
      // Release a bounded journal stall every source second. Capture continues
      // while its real fsync completion remains withheld.
      if (time % 1000 === 980) {
        if (time === 980) { expect(io.journal).toHaveLength(1); expect(delivered.length).toBeGreaterThan(0); }
        io.journal.splice(0).forEach((release) => { release(); }); }
    }
    expect(admitted).toBe(3731);
    expect(delivered).toHaveLength(3331);
    expect(sockets.every((socket) => socket.release !== undefined)).toBe(true);
    expect(existsSync(join(root, "live-native.jsonl"))).toBe(false);
    const finishAt = Date.now();
    const finish = runtime.acceptLifecycle({ type: "meeting.ended", recordingId,
      occurredAt: new Date(Date.now()).toISOString() });
    io.holdReceipt = true;
    sockets.forEach((socket) => { socket.hold = false; socket.release!(); });
    for (let index = 0; index < 400; index++) {
      await until(() => io.receipts.length === 1);
      expect(io.durableRows).toHaveLength(3331 + index);
      await vi.advanceTimersByTimeAsync(10);
      expect(sockets.map((socket) => socket.terminated)).toEqual([0, 0]);
      io.receipts.shift()!();
      await until(() => delivered.length === 3332 + index);
      io.journal.splice(0).forEach((release) => { release(); });
    }
    await finish;
    await runtime.settleBeforeFinalPublication(recordingId);
    expect(Date.now() - finishAt).toBe(4000);
    expect(io.syncs - syncs).toBe(3731);
    expect(io.reads - reads).toBeLessThanOrEqual(1);
    expect(io.durableRows).toEqual(delivered);
    expect(new Set(delivered).size).toBe(3731);
    for (const stream of streams) {
      expect(delivered.filter((id) => id.split(":")[1] === stream[0]!.speakerId)).toEqual(stream.map(livePacketIdentity));
    }
    expect(meetings.finalizedTurns.map((turn) => turn.speakerId).toSorted()).toEqual(streams.map((stream) => stream[0]!.speakerId).toSorted());
    expect(sockets.map((s) => [s.sent, s.acked, s.finalizeCount, s.closeCount, s.terminated]).toSorted((a, b) => a[0]! - b[0]!))
      .toEqual([[1312, 1312, 1, 1, 0], [2419, 2419, 1, 1, 0]]);
    expect(await ingress.pendingLivePackets(recordingId)).toEqual([]);
    io.holdJournal = false;
    io.journal.splice(0).forEach((release) => { release(); });
    await journal.close();
    const text = readFileSync(join(root, "live-native.jsonl"), "utf8");
    const lines = text.trimEnd().split("\n");
    const rows = lines.map((line) => JSON.parse(line) as { index: number; session?: string;
      event?: OssSessionEvidenceEvent; type?: string; priorSha256?: string });
    expect(rows.map((row) => row.index)).toEqual(rows.map((_, i) => i + 1));
    expect(rows.at(-1)).toMatchObject({ type: "capture_seal",
      priorSha256: createHash("sha256").update(lines.slice(0, -1).join("\n") + "\n").digest("hex") });
    for (const kind of ["audio_send", "audio_sent", "audio_accepted"]) {
      expect(rows.filter((row) => row.event?.type === kind)).toHaveLength(3731);
    }
    const sends = rows.flatMap((row) => row.event?.type === "audio_send" ? [row.event.packetId] : []);
    expect(new Set(sends)).toEqual(new Set(delivered));
    for (const session of new Set(rows.flatMap((row) => row.session !== undefined ? [row.session] : []))) {
      const events = rows.filter((row) => row.session === session).map((row) => row.event!);
      const seqs = events.flatMap((event) => event.type === "audio_accepted" ? [event.seq] : []);
      expect(seqs).toEqual(seqs.map((_, i) => i + 1));
      for (const type of ["success", "finalize_send", "close"]) {
        expect(events.filter((event) => event.type === type)).toHaveLength(1);
      }
    }
    expect(meetings.snapshot?.status).toBe("ended");
    const persisted = structuredClone(meetings.finalizedTurns);
    const projectionCount = projector.requests.length;
    const latePacket = { ...streams[0]!.at(-1)!, sequenceNumber: counts[0]!,
      mediaTimestamp: counts[0]! * 960, relativeTimeMs: counts[1]! * 20, receivedAtMs: counts[1]! * 20 };
    expect(delivered).not.toContain(livePacketIdentity(latePacket));
    await runtime.acceptVoiceBatch({ format: packets().format, packets: [latePacket] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(delivered).toHaveLength(3731);
    expect(readFileSync(join(root, "live-native.jsonl"), "utf8")).toBe(text);
    expect(meetings.finalizedTurns).toEqual(persisted);
    expect(projector.requests).toHaveLength(projectionCount);
    await runtime.close();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    io.holdJournal = false; io.holdReceipt = false;
    io.journal.splice(0).forEach((release) => { release(); });
    io.receipts.splice(0).forEach((release) => { release(); });
    try {
      // Abort delivery before close so held ACKs cannot wait on the fake clock.
      await runtime?.close(AbortSignal.abort());
    } finally {
      try { await journal.close(); } finally {
        try { await ingress.close(); } finally { await fs.rm(root, { recursive: true, force: true }); }
      }
    }
  }
}, 60_000);
