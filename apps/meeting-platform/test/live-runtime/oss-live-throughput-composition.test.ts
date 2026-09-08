import * as fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTask } from "node:timers/promises";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { parseCraigLifecycleEvent, parseVoicePacketBatch } from "@discord-meeting/craig-gateway-contracts";
import { DurableCraigRecordingIngress, opusPacketDurationSamples, type SttCompletion } from "@discord-meeting/recording-ingress-adapter";
import { OssNativeEvidenceJournal, VoicetextLiveTranscriptionAdapter,
  type VoicetextInboundFrame, type VoicetextWebSocketConnection,
  type OssSessionEvidenceEvent } from "@discord-meeting/voicetext-adapter";
import { mapLiveSttDurability } from "../../src/composition/live-stt-durability-mapper.js";
import { PlatformLiveMeetingRuntime } from "../../src/live-meeting-runtime.js";
import { AppendLiveTranscriptTurn, FinishLiveMeeting, RefreshLiveMeeting, StartLiveMeeting } from "@discord-meeting/meeting-core/live-meeting";
import { livePacketIdentity } from "../../src/live-runtime/packet-delivery-ledger.js";
import { logger, packets, started, MemoryLiveMeetingRepository, ProjectionStub, SummaryStub } from "./live-runtime-fixtures.js";

// Delay only external durability completions; retain real bytes, fsync and adapters.
const io = vi.hoisted(() => ({ holdJournal: true, journal: [] as (() => void)[],
  journalArrived: () => {}, receiptArrived: () => {},
  afterReceiptSync: async () => {},
  holdReceipt: false, receipts: [] as (() => void)[], syncs: 0, reads: 0, durableRows: [] as string[] }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, fsync: (fd: number, callback: (error: NodeJS.ErrnoException | null) => void) => {
    actual.fsync(fd, (error) => {
      const done = () => { callback(error); };
      if (io.holdJournal) { io.journal.push(done); io.journalArrived(); } else { done(); }
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
            const row = JSON.parse(line) as { type: string; completion?: SttCompletion };
            if (row.type === "stt-outcome" && row.completion?.outcome === "accepted") { pendingRows.push(row.completion.operation.packetId); }
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
          if (io.holdReceipt && rows.length > 0) { await new Promise<void>((resolve) => { io.receipts.push(resolve); io.receiptArrived(); }); }
          io.durableRows.push(...rows);
          if (rows.length > 0) { await io.afterReceiptSync(); }
        };
      }
      return handle;
    },
  };
});

class Gateway implements VoicetextWebSocketConnection {
  public constructor(private readonly onSend: () => void, private readonly onFailure: (error: unknown) => void) {}
  public sent = 0;
  public acked = 0;
  public finalizeCount = 0;
  public closeCount = 0;
  public readonly textTypes: string[] = [];
  public holdServerClose = false;
  public releaseServerClose: (() => void) | undefined;
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
    this.textTypes.push(value.type);
    if (value.type === "config") {
      this.message({ type: "ready", provider: value.provider, model: value.model,
        session_id: "00000000-0000-4000-8000-000000000001" });
    }
    if (value.type === "finalize") {
      this.finalizeCount++;
      this.message({ type: "final", start_ms: 0, duration_ms: this.sent * 20, text: "Synthetic final turn." });
      this.message({ type: "finalize_complete", status: "flushed", saw_result: true });
      const close = () => {
        this.releaseServerClose = undefined;
        this.push({ type: "close", code: 1000, reason: "finalized" });
      };
      if (this.holdServerClose) { this.releaseServerClose = close; } else { close(); }
    }
  }
  public async sendBinary(data: Uint8Array): Promise<void> {
    try {
      expect([...data]).toEqual([0xf8, 0xff, 0xfe]);
      this.sent++;
      expect(this.sent - this.acked).toBe(1);
      const ack = () => { this.release = undefined; this.acked++; this.message({ type: "ack", seq: this.acked }); };
      if (this.hold) { this.release = ack; } else { ack(); }
      this.onSend();
    } catch (error) { this.onFailure(error); throw error; }
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
  public async close(): Promise<void> { this.closeCount++; }
  public terminate(): void { this.terminated++; }
}

// Runtime delivery catches port failures, so every test barrier must also observe
// the first failure. Keep its identity even when finish or cleanup fails later.
function synchronization() {
  let primary: { error: unknown } | undefined;
  const pending = new Set<(error: unknown) => void>();
  const fail = (error: unknown) => {
    primary ??= { error };
    for (const reject of pending) { reject(primary.error); }
    pending.clear();
  };
  return {
    fail,
    observe(operation: Promise<unknown>): void { void operation.catch(fail); },
    wait(operation: Promise<void>): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const rejected = (error: unknown) => { pending.delete(rejected); reject(error); };
        void operation.then(() => { pending.delete(rejected); resolve(); return; }, fail);
        if (primary) { rejected(primary.error); } else { pending.add(rejected); }
      });
    },
  };
}

// Count arrivals, including those that precede the waiter; host turns are not a clock.
function arrivals(waits: ReturnType<typeof synchronization>) {
  let count = 0;
  const waiters = new Map<number, (() => void)[]>();
  return {
    arrive() {
      count++;
      waiters.get(count)?.forEach((resolve) => { resolve(); });
      waiters.delete(count);
    },
    wait(target: number): Promise<void> {
      if (count >= target) { return waits.wait(Promise.resolve()); }
      return waits.wait(new Promise((resolve) => {
        waiters.set(target, [...(waiters.get(target) ?? []), resolve]);
      }));
    },
  };
}

// Always attempt every cleanup step. A body failure retains its original identity;
// cleanup failures remain available as evidence rather than replacing that cause.
async function withCleanup(body: () => Promise<void>, steps: (() => Promise<unknown>)[],
  cleanupFailures: unknown[] = []): Promise<void> {
  let primary: { error: unknown } | undefined;
  try { await body(); } catch (error) { primary = { error }; }
  for (const step of steps) {
    try { await step(); } catch (error) { cleanupFailures.push(error); }
  }
  if (primary) { throw primary.error; }
  if (cleanupFailures.length) { throw new AggregateError(cleanupFailures, "Throughput cleanup failed"); }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("keeps finalization pending after finalize_complete until the same gateway sends server WS1000", async () => {
  vi.useFakeTimers();
  const socket = new Gateway(() => {}, (error) => { throw error; });
  socket.holdServerClose = true;
  const finalizeComplete = Promise.withResolvers<void>();
  const receive = socket.receive.bind(socket);
  vi.spyOn(socket, "receive").mockImplementation(async (signal) => {
    const frame = await receive(signal);
    if (frame.type === "text" && (JSON.parse(frame.data) as { type: string }).type === "finalize_complete") {
      finalizeComplete.resolve();
    }
    return frame;
  });
  const transcriber = new VoicetextLiveTranscriptionAdapter({ endpoint: "ws://offline.invalid",
    token: "synthetic-offline-token" }, { connect: async () => socket });
  const session = await transcriber.openSession({ meetingId: "meeting-delayed-close",
    speakerId: "speaker-1", idempotencyKey: "delayed-close", onTranscript: () => {} });
  let settled = false;
  const finish = session.finalize();
  void finish.then(() => { settled = true; return; }, () => { settled = true; });
  try {
    await finalizeComplete.promise;
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);
    expect(socket.finalizeCount).toBe(1);
    expect(socket.releaseServerClose).toBeTypeOf("function");
    expect(socket.closeCount).toBe(0);
    expect(socket.textTypes).toEqual(["config", "finalize"]);
    expect(socket.terminated).toBe(0);
    socket.releaseServerClose!();
    await finish;
    expect(settled).toBe(true);
    expect(socket.closeCount).toBe(0);
    expect(socket.textTypes).not.toContain("close");
    expect(socket.terminated).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    socket.releaseServerClose?.();
    await finish;
  }
});

it("composes full two-speaker Opus load, nonblocking native capture and indexed durable healthy drain past 2s", async () => {
  const waits = synchronization();
  const journalArrivals = arrivals(waits);
  const receiptArrivals = arrivals(waits);
  const completions = arrivals(waits);
  const packetSends = arrivals(waits);
  const sendAttempts = arrivals(waits);
  Object.assign(io, { holdJournal: true, holdReceipt: false, journal: [], receipts: [],
    syncs: 0, reads: 0, durableRows: [],
    journalArrived: () => { journalArrivals.arrive(); },
    receiptArrived: () => { receiptArrivals.arrive(); } });
  const outstanding = new Set<Promise<void>>();
  const sockets: Gateway[] = [];
  let finish: ReturnType<PlatformLiveMeetingRuntime["acceptLifecycle"]> | undefined;
  const cleanupFailures: unknown[] = [];
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
  await withCleanup(async () => {
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
    await journalArrivals.wait(1);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(0);
    const transcriber = new VoicetextLiveTranscriptionAdapter({ endpoint: "ws://offline.invalid",
      token: "synthetic-offline-token", evidenceSink: journal }, { connect: async () => {
        const socket = new Gateway(() => { packetSends.arrive(); }, waits.fail); sockets.push(socket); return socket;
      } });
    const delivered: string[] = [];
    const progress = streams.map((stream) => ({ stream, cursor: 0, delivered: 0 }));
    const bySpeaker = new Map(progress.map((state) => [state.stream[0]!.speakerId, state]));
    const meetings = new MemoryLiveMeetingRepository();
    const projector = new ProjectionStub();
    const durability = mapLiveSttDurability(ingress.liveSttDurability);
    // Establish the real spool owner before measuring per-operation journal I/O.
    await durability.recoverRecording(recordingId);
    runtime = new PlatformLiveMeetingRuntime({
      logger, appendTurn: new AppendLiveTranscriptTurn(meetings),
      finishMeeting: new FinishLiveMeeting(meetings),
      refreshMeeting: new RefreshLiveMeeting({ meetings, projector, summarizer: new SummaryStub() }),
      startMeeting: new StartLiveMeeting({ meetings }),
      packetFlowControl: { maximumQueuedPacketsPerSpeaker: 512, maximumQueuedPacketsGlobally: 1024,
        maximumConcurrentSessions: 2, packetBackpressureTimeoutMs: 2000 },
      packetInspector: { durationSamples48Khz: opusPacketDurationSamples }, transcriber,
      // Observe real production completions; accepted outcomes are the delivery receipts.
      liveSttDurability: {
        ...durability,
        beginSend: (session, packetId) => {
          const operation = durability.beginSend(session, packetId);
          sendAttempts.arrive();
          waits.observe(operation);
          return operation;
        },
        complete: (completion) => {
          const operation = (async () => {
            await durability.complete(completion);
            if (completion.outcome === "accepted") {
              const id = completion.operation.packetId;
              delivered.push(id);
              bySpeaker.get(id.split(":")[1]!)!.delivered++;
              completions.arrive();
            }
          })();
          outstanding.add(operation);
          waits.observe(operation);
          void operation.then(() => outstanding.delete(operation),
            () => outstanding.delete(operation));
          return operation;
        },
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
      for (const state of progress) {
        const packet = state.stream[state.cursor];
        if (packet?.relativeTimeMs === time) {
          await runtime.acceptVoiceBatch({ format: packets().format, packets: [packet] });
          state.cursor++; admitted++;
        }
      }
      if (time < tailStart) { await completions.wait(admitted); }
      if (time === tailStart) { await packetSends.wait(admitted); }
      for (const state of progress) {
        const queued = state.cursor - state.delivered;
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
    finish = runtime.acceptLifecycle({ type: "meeting.ended", recordingId,
      occurredAt: new Date(Date.now()).toISOString() });
    waits.observe(finish);
    io.holdReceipt = true;
    sockets.forEach((socket) => { socket.hold = false; socket.release!(); });
    for (let index = 0; index < 400; index++) {
      await receiptArrivals.wait(index + 1);
      expect(io.receipts).toHaveLength(1);
      expect(io.durableRows).toHaveLength(3331 + index);
      await vi.advanceTimersByTimeAsync(10);
      expect(sockets.map((socket) => socket.terminated)).toEqual([0, 0]);
      const postSync = Promise.withResolvers<void>();
      const postSyncArrived = Promise.withResolvers<void>();
      if (index === 0) {
        io.afterReceiptSync = async () => { postSyncArrived.resolve(); await postSync.promise; };
      }
      io.receipts.shift()!();
      if (index === 0) {
        try {
          await waits.wait(postSyncArrived.promise);
          const frozenAt = Date.now();
          // A released real fsync is not durable operation completion.
          // Arbitrary host turns must neither acknowledge it nor consume budget.
          for (let turn = 0; turn < 37; turn++) { await nextTask(); }
          expect(Date.now()).toBe(frozenAt);
          expect(io.durableRows).toHaveLength(3332);
          expect(delivered).toHaveLength(3331);
        } finally { io.afterReceiptSync = async () => {}; postSync.resolve(); }
      }
      await completions.wait(3332 + index);
      // Observe the next attempt after source pacing, before advancing time.
      // Its real intent queues behind the other speaker's held outcome in the
      // shared journal. Waiting for Gateway.sendBinary here deadlocks: that
      // intent cannot fsync until the next receipt slot releases the outcome.
      // beginSend entry fixes the pacing timestamp without awaiting that lock;
      // the real grant still precedes provider send. The last two receipts
      // have no following packet. Keep exactly 400 held 10ms receipts.
      await sendAttempts.wait(Math.min(3334 + index, 3731));
      if (index === 0) {
        await receiptArrivals.wait(2);
        expect(io.receipts).toHaveLength(1);
        expect(sockets.reduce((total, socket) => total + socket.sent, 0)).toBe(3333);
      }
      io.journal.splice(0).forEach((release) => { release(); });
    }
    await waits.wait(finish.then(() => void 0));
    await runtime.settleBeforeFinalPublication(recordingId);
    expect(Date.now() - finishAt).toBe(4000);
    // Each send, open and finalize has a fsynced intent and outcome; close is one tombstone.
    expect(io.syncs - syncs).toBe(3731 * 2 + 2 * 2 * 2 + 1);
    expect(io.reads - reads).toBeLessThanOrEqual(1);
    expect(io.durableRows).toEqual(delivered);
    expect(new Set(delivered).size).toBe(3731);
    for (const stream of streams) {
      expect(delivered.filter((id) => id.split(":")[1] === stream[0]!.speakerId)).toEqual(stream.map(livePacketIdentity));
    }
    expect(meetings.finalizedTurns.map((turn) => turn.speakerId).toSorted()).toEqual(streams.map((stream) => stream[0]!.speakerId).toSorted());
    expect(sockets.map((s) => [s.sent, s.acked, s.finalizeCount, s.closeCount, s.terminated]).toSorted((a, b) => a[0]! - b[0]!))
      .toEqual([[1312, 1312, 1, 0, 0], [2419, 2419, 1, 0, 0]]);
    for (const socket of sockets) { expect(socket.textTypes).not.toContain("close"); }
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
  }, [
    async () => {
      io.holdJournal = false; io.holdReceipt = false;
      io.journal.splice(0).forEach((release) => { release(); });
      io.receipts.splice(0).forEach((release) => { release(); });
      sockets.forEach((socket) => { socket.hold = false; socket.release?.(); socket.release = undefined; });
      // sync release is not receipt completion: descriptor verification and close
      // still belong to the live consumer before cancellation or ingress closure.
      while (outstanding.size) { await Promise.allSettled(outstanding); }
    },
    async () => { await runtime?.close(AbortSignal.abort()); },
    async () => { await finish; },
    async () => { while (outstanding.size) { await Promise.allSettled(outstanding); } },
    async () => { await journal.close(); },
    async () => { await ingress.close(); },
    async () => { await fs.rm(root, { recursive: true, force: true }); },
  ], cleanupFailures);
// Outer host-I/O budget for 7,471 real fsyncs; the 4,000ms virtual drain assertion stays exact.
}, 120_000);

it("retains the primary failure while draining receipt work and collecting cleanup failures", async () => {
  const primary = new Error("primary assertion");
  const secondary = new Error("cleanup failure");
  const receipt = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const failures: unknown[] = [];
  let receiptComplete = false;
  let ingressClosed = false;
  const operation = receipt.promise.then(() => { receiptComplete = true; return; });
  const result = withCleanup(async () => { throw primary; }, [
    async () => { entered.resolve(); await operation; },
    async () => { throw secondary; },
    async () => { expect(receiptComplete).toBe(true); ingressClosed = true; },
  ], failures);
  const observed = expect(result).rejects.toBe(primary);
  await entered.promise;
  for (let turn = 0; turn < 37; turn++) { await nextTask(); }
  expect(ingressClosed).toBe(false);
  receipt.resolve();
  await observed;
  expect(ingressClosed).toBe(true);
  expect(failures).toEqual([secondary]);
  await expect(withCleanup(async () => {}, [async () => { throw secondary; }]))
    .rejects.toMatchObject({ errors: [secondary] });
});

it("unblocks every barrier on receipt or finish failure and tears down with the first error", async () => {
  for (const source of ["receipt", "marked assertion", "finish"] as const) {
    const waits = synchronization();
    const journal = arrivals(waits);
    const receipts = arrivals(waits);
    const completions = arrivals(waits);
    const receipt = Promise.withResolvers<void>();
    const terminal = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const primary = new Error(source);
    const secondary = new Error("later terminal failure");
    const cleanupFailures: unknown[] = [];
    const closed: string[] = [];
    const operation = receipt.promise.then(() => {
      if (source === "marked assertion") { throw primary; }
      completions.arrive();
      return;
    });
    waits.observe(operation);
    waits.observe(terminal.promise);
    const pending = [journal.wait(1), receipts.wait(1), receipts.wait(2), completions.wait(2),
      waits.wait(new Promise<void>(() => {}))];
    const outcomes = Promise.allSettled(pending);
    const result = withCleanup(async () => {
      entered.resolve();
      await completions.wait(1);
      await receipts.wait(1);
    }, [
      async () => { await Promise.allSettled([operation, terminal.promise]); },
      async () => { closed.push("runtime"); throw secondary; },
      async () => { closed.push("journal"); },
      async () => { closed.push("ingress"); },
    ], cleanupFailures);
    const observed = expect(result).rejects.toBe(primary);
    await entered.promise;
    if (source === "finish") { terminal.reject(primary); receipt.resolve(); }
    else {
      if (source === "receipt") { receipt.reject(primary); } else { receipt.resolve(); }
      await operation.catch(() => {});
      terminal.reject(secondary);
    }
    await observed;
    for (const outcome of await outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") { expect(outcome.reason).toBe(primary); }
    }
    await expect(receipts.wait(3)).rejects.toBe(primary);
    // Even an already counted arrival must not hide a latched failure.
    receipts.arrive();
    await expect(receipts.wait(1)).rejects.toBe(primary);
    expect(closed).toEqual(["runtime", "journal", "ingress"]);
    expect(cleanupFailures).toEqual([secondary]);
  }
}, 1000);

it("latches pre-receipt Gateway assertions for pending and future barriers before cleanup", async () => {
  for (const source of ["payload", "in-flight"] as const) {
    const waits = synchronization();
    const barriers = Array.from({ length: 4 }, () => arrivals(waits)); // journal, receipt, completion, send
    const socket = new Gateway(() => { barriers[3]!.arrive(); }, waits.fail);
    socket.hold = true;
    if (source === "in-flight") { await socket.sendBinary(Uint8Array.of(0xf8, 0xff, 0xfe)); }
    const outcomes = Promise.allSettled(barriers.map((barrier) => barrier.wait(2)));
    const cleanupFailures: unknown[] = [];
    const secondary = new Error("later cleanup failure");
    const closed: string[] = [];
    const result = withCleanup(async () => { await barriers[2]!.wait(1); }, [
      async () => { socket.hold = false; socket.release?.(); await socket.close(); closed.push("gateway"); },
      async () => { throw secondary; },
      async () => { closed.push("ingress"); },
    ], cleanupFailures);
    const bodyOutcome = Promise.allSettled([result]);
    // Deliberately do not observe this promise: production may swallow the send
    // rejection before any receipt exists. The Gateway itself must latch it.
    const [send] = await Promise.allSettled([socket.sendBinary(
      source === "payload" ? Uint8Array.of(0) : Uint8Array.of(0xf8, 0xff, 0xfe))]);
    expect(send.status).toBe("rejected");
    if (send.status !== "rejected") { throw new Error("expected injected Gateway assertion"); }
    const primary: unknown = send.reason;
    expect(primary).toBeInstanceOf(Error);
    for (const outcome of [...await outcomes, ...await bodyOutcome]) {
      expect(outcome).toEqual({ status: "rejected", reason: primary });
      if (outcome.status === "rejected") { expect(outcome.reason).toBe(primary); }
    }
    waits.fail(secondary);
    for (const barrier of barriers) {
      await expect(barrier.wait(3)).rejects.toBe(primary);
      barrier.arrive();
      await expect(barrier.wait(1)).rejects.toBe(primary);
    }
    expect(socket.sent).toBe(source === "payload" ? 0 : 2);
    expect(socket.acked).toBe(source === "payload" ? 0 : 1);
    expect(socket.release).toBeUndefined();
    expect(socket.closeCount).toBe(1);
    expect(closed).toEqual(["gateway", "ingress"]);
    expect(cleanupFailures).toEqual([secondary]);
  }
}, 1000);
