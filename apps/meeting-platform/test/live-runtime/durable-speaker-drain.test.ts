import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as yieldIo } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { DurableCraigRecordingIngress } from "@discord-meeting/recording-ingress-adapter";
import { AppendLiveTranscriptTurn, FinishLiveMeeting, RefreshLiveMeeting, StartLiveMeeting } from "@discord-meeting/meeting-core/live-meeting";
import { mapLiveSttDurability } from "../../src/composition/live-stt-durability-mapper.js";
import { PlatformLiveMeetingRuntime } from "../../src/live-runtime/platform-live-meeting-runtime.js";
import { VoicetextLiveTranscriptionAdapter, type OssSessionEvidenceEvent, type VoicetextInboundFrame,
  type VoicetextWebSocketConnection } from "@discord-meeting/voicetext-adapter";
import { mapLiveAdmission } from "../../src/composition/live-admission-mapper.js";
import { MemoryLiveMeetingRepository, ProjectionStub, SummaryStub, started, logger } from "./live-runtime-fixtures.js";

const a = "33333333333333333", b = "44444444444444444";
const event = { schemaVersion: 1, recordingId: "r", guildId: "11111111111111111", channelId: "22222222222222222" } as const;
const endedAt = "2026-08-02T10:01:00.000Z";
const packet = (speakerId: string, index: number, time = index * 20) => ({ ...event, speakerId,
  opusBase64: "+P/+", receivedAtMs: 0, relativeTimeMs: time, rtpTimestamp: index * 960, rtpSequence: index });
afterEach(() => vi.useRealTimers());
async function until(check: () => boolean): Promise<void> {
  for (let n = 0; n < 4000 && !check(); n++) { await yieldIo(1); }
  expect(check()).toBe(true);
}
async function advance(ms: number): Promise<void> {
  for (let n = 0; n < ms; n += 20) { await vi.advanceTimersByTimeAsync(20); await yieldIo(15); }
}
// Real adapter protocol and native evidence, with an entirely offline gateway.
class SyntheticSocket implements VoicetextWebSocketConnection {
  private readonly frames: VoicetextInboundFrame[] = [];
  private waiter: ((frame: VoicetextInboundFrame) => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sequence = 0;
  public unattended = false;
  public readonly held = Promise.withResolvers<void>();
  public holdAck = false;
  public async sendText(data: string): Promise<void> {
    const message = JSON.parse(data) as { type: string };
    if (message.type === "config") {
      this.message({ type: "ready", provider: "deepgram", model: "nova-3",
        session_id: "00000000-0000-4000-8000-000000000001" });
    } else if (message.type === "finalize") {
      clearTimeout(this.timer);
      this.message({ type: "final", start_ms: 0, duration_ms: 20, text: "Synthetic final" });
      this.message({ type: "finalize_complete", status: "flushed", saw_result: true });
      this.push({ type: "close", code: 1000, reason: "synthetic" });
    } else { throw new Error("Unexpected offline control"); }
  }
  public async sendBinary(): Promise<void> {
    this.sequence++;
    this.message({ type: "partial", start_ms: 0, duration_ms: 20, text: "Synthetic partial" });
    clearTimeout(this.timer); this.timer = setTimeout(() => {
      this.unattended = true; this.message({ type: "error", code: "PROVIDER_UNAVAILABLE", message: "synthetic unattended session" });
    }, 12_000);
    if (this.holdAck) { this.held.resolve(); }
    else { this.ack(); }
  }
  public ack(): void { this.message({ type: "ack", seq: this.sequence }); }
  public async close(): Promise<void> { throw new Error("Gateway must own normal close"); }
  public terminate(): void { clearTimeout(this.timer); }
  public message(message: Readonly<Record<string, unknown>>): void { this.push({ type: "text", data: JSON.stringify(message) }); }
  private push(frame: VoicetextInboundFrame): void {
    const waiter = this.waiter;
    if (waiter === undefined) { this.frames.push(frame); } else { this.waiter = undefined; waiter(frame); }
  }
  public receive(signal: AbortSignal): Promise<VoicetextInboundFrame> {
    signal.throwIfAborted();
    const frame = this.frames.shift();
    if (frame !== undefined) { return Promise.resolve(frame); }
    return new Promise((resolve, reject) => {
      const abort = () => { this.waiter = undefined; reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      this.waiter = received => { signal.removeEventListener("abort", abort); resolve(received); };
    });
  }
}
async function fixture() {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(Date.parse(endedAt));
  const root = await mkdtemp(join(tmpdir(), "durable-speaker-drain-"));
  const ingress = new DurableCraigRecordingIngress({ spoolRoot: root, artifactLocatorPrefix: "synthetic",
    writer: { write: () => { throw new Error("No authoritative writes in derived drain"); } } });
  const meetings = new MemoryLiveMeetingRepository();
  const sessions: { speaker: string; sent: string[]; partials: number; finalized: number; closed: boolean;
    events: OssSessionEvidenceEvent[] }[] = [];
  const sockets: SyntheticSocket[] = [];
  const adapter = new VoicetextLiveTranscriptionAdapter({ endpoint: "wss://offline.invalid", token: "synthetic-machine-token",
    evidenceSink: { open: () => {
      const session = { speaker: "", sent: [] as string[], partials: 0, finalized: 0, closed: false, events: [] as OssSessionEvidenceEvent[] };
      sessions.push(session);
      return { record: evidence => {
        session.events.push(evidence);
        if (evidence.type === "opening") { session.speaker = evidence.speakerId; }
        if (evidence.type === "audio_send") { session.sent.push(evidence.packetId); }
        if (evidence.type === "transcript_emitted" && !evidence.isFinal) { session.partials++; }
        if (evidence.type === "finalize_send") { session.finalized++; }
        if (evidence.type === "close" && evidence.code === 1000) { session.closed = true; }
      } };
    } },
  }, { connect: async () => { const socket = new SyntheticSocket(); sockets.push(socket); return socket; } });
  const storage = mapLiveSttDurability(ingress.liveSttDurability);
  const receiptHeld = Promise.withResolvers<void>(), releaseReceipt = Promise.withResolvers<void>();
  let holdReceipt = false; let readUnavailable = false;
  const readHeld = Promise.withResolvers<void>(), releaseRead = Promise.withResolvers<void>();
  let holdRead = false;
  const pages: number[] = [];
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings), startMeeting: new StartLiveMeeting({ meetings }),
    finishMeeting: new FinishLiveMeeting(meetings),
    refreshMeeting: new RefreshLiveMeeting({ meetings, projector: new ProjectionStub(), summarizer: new SummaryStub() }),
    transcriber: mapLiveAdmission(adapter), logger, speakerIdleFinalizeMs: 750,
    liveSttDurability: { ...storage, complete: async completion => {
      if (holdReceipt && completion.outcome === "accepted" && completion.operation.session.speakerId === a) {
        receiptHeld.resolve(); await releaseReceipt.promise;
      }
      await storage.complete(completion);
    } },
    pendingLivePackets: async (id, after) => { const page = await ingress.pendingLivePackets(id, after); pages.push(page.length); return page; },
    pendingLiveSpeakerPackets: async (id: string, speaker: string) => {
      if (readUnavailable) { throw new Error("synthetic unavailable durable observation"); }
      if (holdRead && speaker === a) { readHeld.resolve(); await releaseRead.promise; }
      return await ingress.pendingLiveSpeakerPackets(id, speaker);
    },
    packetFlowControl: { maximumQueuedPacketsPerSpeaker: 1, maximumQueuedPacketsGlobally: 2 },
  });
  await ingress.ingestLifecycleEvent({ ...event, type: "meeting.started", eventId: "start",
    occurredAt: "2026-08-02T10:00:00.000Z", participantIds: [a, b] });
  const ingest = async (packets: ReturnType<typeof packet>[]) => {
    for (let n = 0; n < packets.length; n += 256) { await ingress.ingestPacketBatch({ schemaVersion: 1, packets: packets.slice(n, n + 256) }); }
  };
  const finish = async () => {
    await ingress.ingestLifecycleEvent({ ...event, type: "meeting.ended", eventId: "end", occurredAt: endedAt, reason: null });
    return runtime.acceptLifecycle({ type: "meeting.ended", recordingId: "r", occurredAt: endedAt });
  };
  const originals = async () => Promise.all((await readdir(root, { recursive: true })).filter(path => path.endsWith(".packets")).toSorted()
    .map(async path => ({ path, bytes: (await readFile(join(root, path))).toString("base64") })));
  const notify = async () => runtime.acceptVoiceBatch({ format: { channelCount: 1, codec: "opus", sampleRateHz: 48_000 },
    packets: await ingress.pendingLivePackets("r", "") });
  return { ingress, runtime, sessions, sockets, storage, pages, ingest, finish, originals, notify,
    setReadUnavailable: (unavailable: boolean) => { readUnavailable = unavailable; },
    holdReceipt: () => { holdReceipt = true; }, receiptHeld, releaseReceipt,
    holdRead: () => { holdRead = true; }, readHeld, releaseRead,
    cleanup: async () => {
      releaseRead.resolve(); releaseReceipt.resolve(); for (const socket of sockets) { socket.ack(); }
      let done = false; const isDone = () => done; const releasing = runtime.releaseForRestart().catch(() => {}).finally(() => { done = true; });
      for (let n = 0; n < 60 && !isDone(); n++) { await advance(1000); }
      await releasing; await ingress.close(); await rm(root, { recursive: true, force: true });
    } };
}

it.each([255, 256])("durable preflight: actual 256 page with %i A independently drains contiguous B without premature close", async aCount => {
  const f = await fixture();
  try {
    await f.ingest([...Array.from({ length: aCount }, (_, n) => packet(a, n)), packet(b, 0, (aCount - 1) * 20), packet(b, 1, aCount * 20)]);
    const starting = f.runtime.acceptLifecycle(started("r", [a, b]));
    await until(() => f.sessions.some(s => s.speaker === b && s.sent.length === 1));
    await advance(1000);
    expect(f.pages[0]).toBe(256);
    expect(f.sessions.filter(s => s.speaker === b)).toHaveLength(1);
    expect(f.sessions.find(s => s.speaker === b)?.sent).toHaveLength(2);
    expect(f.sessions.find(s => s.speaker === a)?.sent.length).toBeLessThan(aCount);
    await advance(6000);
    for (let n = 0; n < 40 && f.sessions.find(session => session.speaker === a)?.sent.length !== aCount; n++) { await advance(1000); }
    await starting; await f.finish();
    expect(f.sessions).toHaveLength(2);
    for (const s of f.sessions) { expect(s.partials).toBeGreaterThan(0); expect(s.finalized).toBe(1); expect(s.closed).toBe(true); expect(s.events.filter(e => e.type === "success")).toHaveLength(1); }
    expect(await f.ingress.pendingLivePackets("r")).toEqual([]);
    expect(f.sockets.some(socket => socket.unattended)).toBe(false);
  } finally { await f.cleanup(); }
}, 90_000);

it("durable preflight: closed exhausted A finalizes while B still has over 13 seconds to drain", async () => {
  const f = await fixture();
  try {
    await f.ingest([packet(a, 0), packet(b, 0)]);
    const initial = f.runtime.acceptLifecycle(started("r", [a, b]));
    await until(() => f.sessions.length === 2 && f.sessions.every(s => s.sent.length === 1));
    await advance(20); await initial;
    await f.ingest([packet(a, 1), ...Array.from({ length: 750 }, (_, n) => packet(b, n + 1))]);
    const finishing = f.finish(); void finishing.catch(() => {});
    await advance(1000);
    expect(f.sessions.find(s => s.speaker === a)?.finalized).toBe(1);
    expect(f.sessions.find(s => s.speaker === b)?.sent.length).toBeLessThan(101);
    await advance(17_000);
    for (let n = 0; n < 20 && f.sessions.some(session => !session.closed); n++) { await advance(1000); }
    await finishing;
    expect(f.sessions).toHaveLength(2);
    for (const s of f.sessions) { expect(s.partials).toBeGreaterThan(0); expect(s.finalized).toBe(1); expect(s.closed).toBe(true); expect(s.events.filter(e => e.type === "success")).toHaveLength(1); }
    expect(f.sessions.find(s => s.speaker === b)?.sent).toHaveLength(751);
    expect(await f.ingress.pendingLivePackets("r")).toEqual([]);
    expect(f.sockets.some(socket => socket.unattended)).toBe(false);
  } finally { await f.cleanup(); }
}, 90_000);


it.each(["ACK", "receipt", "already exhausted", "resumed speech", "resumed speech delayed read"] as const)("durable preflight: ending during a live drain waits for A's delayed %s, independently of B", async mode => {
  const f = await fixture();
  try {
    await f.ingest([packet(a, 0), packet(b, 0)]);
    const initial = f.runtime.acceptLifecycle(started("r", [a, b]));
    await until(() => f.sessions.length === 2 && f.sessions.every(s => s.sent.length === 1));
    await advance(20); await initial;
    const socket = f.sockets[f.sessions.findIndex(s => s.speaker === a)]!;
    if (mode === "ACK") { socket.holdAck = true; } else if (mode === "receipt") { f.holdReceipt(); }
    await f.ingest([...(mode.startsWith("resumed speech") ? [] : [packet(a, 1)]), ...Array.from({ length: 700 }, (_, n) => packet(b, n + 1))]);
    const draining = f.notify();
    await advance(100);
    if (mode.startsWith("resumed speech")) {
      if (mode === "resumed speech delayed read") { f.holdRead(); }
      await f.ingest([packet(a, 1)]); await f.notify();
      if (mode === "resumed speech delayed read") { await f.readHeld.promise; }
      await advance(100);
      if (mode === "resumed speech delayed read") {
        // Notification acknowledges ingress, not the asynchronous filesystem read.
        // Hold that read across the old assertion window, without wall-clock sleeps.
        expect(f.sessions.find(s => s.speaker === a)?.sent).toHaveLength(1);
        f.releaseRead.resolve();
      }
      // Pacing is already due. Keep logical time fixed while real spool I/O settles;
      // waiting for native send evidence must not consume the latency budget.
      await until(() => f.sessions.find(s => s.speaker === a)?.sent.length === 2);
      expect(f.sessions.find(s => s.speaker === a)?.sent).toHaveLength(2);
    }
    const original = await f.originals(); expect(original).toHaveLength(2);
    if (mode === "ACK" || mode === "receipt") { await (mode === "ACK" ? socket.held.promise : f.receiptHeld.promise); }
    const finishing = f.finish(); void finishing.catch(() => {});
    await advance(1000);
    expect(f.sessions.find(s => s.speaker === a)?.finalized).toBe(mode === "ACK" || mode === "receipt" ? 0 : 1);
    expect((await f.ingress.pendingLiveSpeakerPackets("r", a)).packets).toHaveLength(mode === "ACK" || mode === "receipt" ? 1 : 0);
    if (mode === "ACK") { socket.holdAck = false; socket.ack(); } else { f.releaseReceipt.resolve(); }
    await advance(1000);
    expect(f.sessions.find(s => s.speaker === a)?.finalized).toBe(1);
    expect(f.sessions.find(s => s.speaker === b)?.closed).toBe(false);
    for (let n = 0; n < 40 && f.sessions.some(s => !s.closed); n++) { await advance(1000); }
    await draining; await finishing;
    expect(await f.originals()).toEqual(original);
    expect(await f.ingress.pendingLivePackets("r")).toEqual([]);
    expect(f.sessions).toHaveLength(2);
    expect(f.sessions.find(s => s.speaker === a)?.sent).toHaveLength(2);
    expect(f.sessions.find(s => s.speaker === b)?.sent).toHaveLength(701);
    for (const s of f.sessions) {
      expect(new Set(s.sent).size).toBe(s.sent.length);
      expect(s.partials).toBeGreaterThan(0); expect(s.finalized).toBe(1); expect(s.closed).toBe(true);
      expect(s.events.filter(e => e.type === "success")).toHaveLength(1);
    }
    expect(f.sockets.some(s => s.unattended)).toBe(false);
  } finally { await f.cleanup(); }
}, 90_000);

it.each(["cancel", "terminal error"] as const)("durable preflight: %s during A's unacknowledged send never replays uncertainty or loses originals", async mode => {
  const f = await fixture();
  try {
    await f.ingest([packet(a, 0), packet(b, 0)]);
    const initial = f.runtime.acceptLifecycle(started("r", [a, b]));
    await until(() => f.sessions.length === 2 && f.sessions.every(s => s.sent.length === 1));
    await advance(20); await initial;
    const session = f.sessions.find(s => s.speaker === a)!;
    const socket = f.sockets[f.sessions.indexOf(session)]!; socket.holdAck = true;
    await f.ingest([packet(a, 1), packet(a, 2), packet(b, 1), packet(b, 2)]);
    const original = await f.originals(); expect(original).toHaveLength(2);
    const draining = f.notify(); void draining.catch(() => {});
    await advance(100); await socket.held.promise;
    if (mode === "cancel") { await f.runtime.acceptLifecycle({ type: "meeting.connection_lost", recordingId: "r", occurredAt: endedAt }); }
    else { socket.message({ type: "error", code: "PROVIDER_UNAVAILABLE", message: "synthetic terminal error" }); }
    await advance(100); await draining;
    socket.ack(); await advance(100);
    if (mode === "cancel") {
      const recovered = f.runtime.acceptLifecycle({ type: "meeting.connection_recovered", recordingId: "r", occurredAt: endedAt });
      await advance(100); await recovered;
    }
    const finishing = f.finish(); await advance(1000); await finishing;
    expect(f.sessions.filter(s => s.speaker === a)).toHaveLength(1);
    expect(session.sent).toHaveLength(2); expect(session.finalized).toBe(0);
    expect(session.events.some(e => e.type === "success")).toBe(false);
    expect((await f.storage.recoverRecording("r")).fences).toContainEqual({ speakerId: a, reason: "acceptance-unknown" });
    expect((await f.ingress.pendingLivePackets("r")).filter(p => p.speakerId === a)).toHaveLength(2);
    expect((await f.ingress.pendingLiveSpeakerPackets("r", a)).packets).toEqual([]);
    expect(await f.originals()).toEqual(original);
  } finally { await f.cleanup(); }
}, 90_000);


it("closed derived ingress retains late authoritative packets without resurrecting exhausted live speech", async () => {
  const f = await fixture();
  try {
    await f.ingest([packet(a, 0)]); await f.runtime.acceptLifecycle(started("r", [a]));
    const before = await f.originals();
    const owner = (await f.storage.recoverRecording("r")).owner;
    await f.storage.closeRecording(owner, Date.parse(endedAt));
    await f.ingest([packet(a, 1)]);
    const after = await f.originals();
    expect(after).toHaveLength(1);
    const original = Buffer.from(before[0]!.bytes, "base64"), retained = Buffer.from(after[0]!.bytes, "base64");
    expect(retained.length).toBeGreaterThan(original.length);
    expect(retained.subarray(0, original.length)).toEqual(original);
    expect(await f.ingress.pendingLiveSpeakerPackets("r", a)).toEqual({ packets: [], closed: true });
    await f.finish();
    expect(f.sessions).toHaveLength(1); expect(f.sessions[0]!.sent).toHaveLength(1);
    expect(f.sessions[0]!.closed).toBe(true);
    expect(await f.originals()).toEqual(after);
  } finally { await f.cleanup(); }
}, 30_000);


it("an unavailable durable observation never masquerades as speaker exhaustion", async () => {
  const f = await fixture();
  try {
    await f.ingest([packet(a, 0)]); await f.runtime.acceptLifecycle(started("r", [a]));
    const original = await f.originals();
    f.setReadUnavailable(true); await advance(1000);
    expect(f.sessions[0]!.finalized).toBe(0);
    await expect(f.finish()).rejects.toBeInstanceOf(AggregateError);
    expect(f.sessions[0]!.finalized).toBe(0);
    f.setReadUnavailable(false); await f.finish();
    expect(f.sessions).toHaveLength(1); expect(f.sessions[0]!.sent).toHaveLength(1);
    expect(f.sessions[0]!.finalized).toBe(1); expect(f.sessions[0]!.closed).toBe(true);
    expect(await f.originals()).toEqual(original);
  } finally { await f.cleanup(); }
}, 30_000);
