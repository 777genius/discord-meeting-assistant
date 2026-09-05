import { AppendLiveTranscriptTurn, FinishLiveMeeting, RefreshLiveMeeting, StartLiveMeeting } from "@discord-meeting/meeting-core/live-meeting";
import { afterEach, expect, it, vi } from "vitest";
import { PlatformLiveMeetingRuntime } from "../../src/live-meeting-runtime.js";
import type { LivePacketFlowControl, LiveVoicePacket, LiveTranscriptionPort } from "../../src/live-runtime/contracts.js";
import { livePacketIdentity } from "../../src/live-runtime/packet-delivery-ledger.js";
import { ended, logger, MemoryLiveMeetingRepository, packets, ProjectionStub, started, SummaryStub } from "./live-runtime-fixtures.js";

afterEach(() => vi.useRealTimers());

function fixture(
  pending: readonly LiveVoicePacket[] = [], failAt?: string, firstSend?: Promise<void>,
  options: { transcriber?: LiveTranscriptionPort; flow?: LivePacketFlowControl; failAck?: boolean; duplicate?: boolean; failReadOnce?: boolean; readGate?: Promise<void> } = {},
) {
  let failingPacketId = failAt;
  let reads = 0;
  let terminations = 0;
  const meetings = new MemoryLiveMeetingRepository();
  const durable = new Map(pending.map((packet) => [livePacketIdentity(packet), packet]));
  const sends: string[] = [];
  const acknowledgements: string[] = [];
  const transcriber: LiveTranscriptionPort = {
    openSession: async () => ({
      finalize: async () => {}, terminate: () => { terminations += 1; },
      sendPacket: async (packet) => {
        sends.push(packet.packetId);
        if (sends.length === 1) { await firstSend; }
        if (packet.packetId === failingPacketId) { throw new Error("synthetic send failure"); }
        return "accepted";
      },
    }),
  };
  const makeRuntime = () => new PlatformLiveMeetingRuntime({
    ...(options.flow === undefined ? {} : { packetFlowControl: options.flow }),
    appendTurn: new AppendLiveTranscriptTurn(meetings),
    finishMeeting: new FinishLiveMeeting(meetings), logger,
    refreshMeeting: new RefreshLiveMeeting({ meetings, projector: new ProjectionStub(), summarizer: new SummaryStub() }),
    startMeeting: new StartLiveMeeting({ meetings }), transcriber: options.transcriber ?? transcriber,
    markLivePacketDelivered: async (packetId) => {
      if (options.failAck) { throw new Error("synthetic acknowledgement failure"); }
      acknowledgements.push(packetId); durable.delete(packetId);
    },
    pendingLivePackets: async () => {
      reads += 1;
      await options.readGate;
      if (options.failReadOnce && reads === 1) { throw Object.assign(new Error("synthetic EIO"), { code: "EIO" }); }
      return options.duplicate
        ? [...durable.values(), ...durable.values()].toSorted((left, right) => left.sequenceNumber - right.sequenceNumber)
        : [...durable.values()];
    },
  });
  return { acknowledgements, durable, makeRuntime, sends, reads: () => reads, terminations: () => terminations, repair: () => { failingPacketId = undefined; } };
}

function backlog(size: number): LiveVoicePacket[] {
  return Array.from({ length: size }, (_, index) => ({
    ...packets().packets[0]!, relativeTimeMs: index * 20,
    mediaTimestamp: (index + 1) * 960, sequenceNumber: index + 1,
  }));
}

it.each([513, 1024, 1025, 2049])("drains %i durable packets in order and does not replay acknowledged packets after restart", async (size) => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const pending = backlog(size);
  const f = fixture([...pending, pending[0]!]);
  const runtime = f.makeRuntime();
  const recovery = runtime.acceptLifecycle(started());
  await vi.advanceTimersByTimeAsync(size * 20 + 1000);
  await recovery;
  expect(f.sends).toEqual(pending.map(livePacketIdentity));
  expect(f.acknowledgements).toEqual(f.sends);
  expect(f.durable.size).toBe(0);
  // Simulate another owner reading the same durable repository after restart.
  const restarted = f.makeRuntime();
  await restarted.acceptLifecycle(started());
  expect(f.sends).toHaveLength(size);
  await restarted.close();
  await runtime.close();
});

it("acknowledges live delivery once despite duplicate ingress and never acknowledges exhausted sends", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const batch = backlog(2);
  const f = fixture([], livePacketIdentity(batch[1]!));
  const runtime = f.makeRuntime();
  await runtime.acceptLifecycle(started());
  const input = { ...packets(), packets: [batch[0]!, batch[0]!, batch[1]!] };
  await runtime.acceptVoiceBatch(input);
  await vi.advanceTimersByTimeAsync(100);
  expect(f.acknowledgements).toEqual([livePacketIdentity(batch[0]!)]);
  expect(f.sends).toEqual([livePacketIdentity(batch[0]!), livePacketIdentity(batch[1]!), livePacketIdentity(batch[1]!)]);
  await runtime.close();
});

it("retains a failed batch and later batches for restart without acknowledging unsent packets", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const pending = backlog(1025);
  const failureId = livePacketIdentity(pending[250]!);
  const f = fixture(pending, failureId);
  const runtime = f.makeRuntime();
  const recovery = runtime.acceptLifecycle(started());
  await vi.advanceTimersByTimeAsync(30_000);
  await recovery;
  expect(f.acknowledgements).toHaveLength(250);
  expect([...f.durable.keys()]).toEqual(pending.slice(250).map(livePacketIdentity));
  expect(f.sends.at(-1)).toBe(failureId);
  f.repair();
  const restarted = f.makeRuntime();
  const resumed = restarted.acceptLifecycle(started());
  await vi.advanceTimersByTimeAsync(30_000);
  await resumed;
  expect(f.acknowledgements).toEqual(pending.map(livePacketIdentity));
  expect(f.durable.size).toBe(0);
  await restarted.close();
  await runtime.close();
});


it("admits concurrent live ingress while preserving recovery order behind a slow send", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = backlog(514);
  const f = fixture(pending.slice(0, 513), undefined, gate);
  const runtime = f.makeRuntime();
  const recovery = runtime.acceptLifecycle(started());
  await vi.advanceTimersByTimeAsync(100);
  let admitted = false;
  const live = runtime.acceptVoiceBatch({ ...packets(), packets: [pending[513]!] }).then(() => { admitted = true; return admitted; });
  await vi.advanceTimersByTimeAsync(100);
  expect(admitted).toBe(true);
  expect(f.sends).toHaveLength(1);
  expect(f.acknowledgements).toHaveLength(0);
  expect(f.durable.size).toBe(513);
  release();
  await vi.advanceTimersByTimeAsync(20_000);
  await recovery;
  await live;
  expect(f.sends).toEqual(pending.map(livePacketIdentity));
  await runtime.close();
});


it("recovers independent speakers with one-slot global and speaker admission and duplicate pending packets", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const pending = [...backlog(513), ...backlog(1025).map((packet) => ({ ...packet, speakerId: "speaker-b" }))];
  const f = fixture(pending, undefined, undefined, {
    flow: { maximumQueuedPacketsPerSpeaker: 1, maximumQueuedPacketsGlobally: 1 }, duplicate: true,
  });
  const runtime = f.makeRuntime();
  const recovery = runtime.acceptLifecycle(started());
  await vi.advanceTimersByTimeAsync(40_000);
  await recovery;
  for (const speakerId of new Set(pending.map((packet) => packet.speakerId))) {
    const expected = pending.filter((packet) => packet.speakerId === speakerId).map(livePacketIdentity);
    const ids = new Set(expected);
    expect(f.sends.filter((id) => ids.has(id))).toEqual(expected);
  }
  expect(f.acknowledgements).toEqual(f.sends);
  await runtime.close();
});

it("leaves failed acknowledgements durable without resending or advancing the backlog", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const pending = backlog(513);
  const f = fixture(pending, undefined, undefined, { failAck: true });
  const runtime = f.makeRuntime();
  await runtime.acceptLifecycle(started());
  await vi.advanceTimersByTimeAsync(0);
  expect(f.sends).toEqual([livePacketIdentity(pending[0]!)]);
  expect(f.acknowledgements).toHaveLength(0);
  expect(f.durable.size).toBe(513);
  await runtime.acceptVoiceBatch({ ...packets(), packets: [pending[512]!] });
  await runtime.close();
  expect(f.sends).toHaveLength(1);
});


it.each([513, 1025])("admits live packets within two seconds during a healthy %i packet recovery", async (size) => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const pending = backlog(size + 1);
  const f = fixture(pending.slice(0, size));
  const runtime = f.makeRuntime();
  const recovery = runtime.acceptLifecycle(started());
  await vi.advanceTimersByTimeAsync(0);
  let admitted = false;
  const live = runtime.acceptVoiceBatch({ ...packets(), packets: [pending[size]!] }).then(() => { admitted = true; return admitted; });
  await vi.advanceTimersByTimeAsync(1_999);
  expect(admitted).toBe(true);
  expect(f.sends.length).toBeLessThan(size);
  await vi.advanceTimersByTimeAsync(size * 20);
  await live;
  await recovery;
  expect(f.sends).toEqual(pending.map(livePacketIdentity));
  expect(f.acknowledgements).toEqual(f.sends);
  await runtime.close();
});

it.each(["end", "disconnect", "shutdown", "restart"] as const)("%s cancels a stalled recovery and fences late sends", async (control) => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = backlog(1025);
  const f = fixture(pending, undefined, gate, { flow: { packetBackpressureTimeoutMs: 100 } });
  const runtime = f.makeRuntime();
  await runtime.acceptLifecycle(started());
  await vi.advanceTimersByTimeAsync(0);
  expect(f.sends).toHaveLength(1);
  let settled = false;
  const operation = (control === "end" ? runtime.acceptLifecycle(ended())
    : control === "disconnect" ? runtime.acceptLifecycle({ ...ended(), type: "meeting.connection_lost" })
    : control === "restart" ? runtime.releaseForRestart() : runtime.close()).then(() => { settled = true; return settled; });
  await vi.advanceTimersByTimeAsync(100);
  expect(settled).toBe(true);
  await operation;
  expect(f.terminations()).toBe(1);
  expect(f.acknowledgements).toHaveLength(0);
  expect(f.durable.size).toBe(1025);
  release();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.sends).toHaveLength(1);
  expect(f.acknowledgements).toHaveLength(0);
  await runtime.close();
  if (control === "restart") {
    const restarted = f.makeRuntime();
    await restarted.acceptLifecycle(started());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.acknowledgements).toEqual(pending.map(livePacketIdentity));
    await restarted.close();
  }
});

it.each(["end", "disconnect", "shutdown"] as const)("%s controls a healthy 513 packet backlog before its drain finishes", async (control) => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const pending = backlog(514);
  const f = fixture(pending.slice(0, 513));
  const runtime = f.makeRuntime();
  await runtime.acceptLifecycle(started());
  const live = runtime.acceptVoiceBatch({ ...packets(), packets: [pending[513]!] });
  let settled = false;
  const operation = (control === "end" ? runtime.acceptLifecycle(ended())
    : control === "disconnect" ? runtime.acceptLifecycle({ ...ended(), type: "meeting.connection_lost" })
    : runtime.close()).then(() => { settled = true; return settled; });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(settled).toBe(true);
  await Promise.all([live, operation]);
  expect(f.sends.length).toBeLessThan(513);
  expect(f.durable.size).toBeGreaterThan(0);
  const sent = [...f.sends];
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.sends).toEqual(sent);
  await runtime.close();
});

it("rereads after EIO and deduplicates concurrent retried starts before accepting live packets", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const pending = backlog(515);
  const f = fixture(pending.slice(0, 513), undefined, undefined, { failReadOnce: true });
  const runtime = f.makeRuntime();
  await expect(runtime.acceptLifecycle(started())).rejects.toMatchObject({ code: "EIO" });
  expect(f.sends).toHaveLength(0);
  await runtime.acceptVoiceBatch({ ...packets(), packets: [pending[513]!] });
  expect(f.sends).toHaveLength(0);
  f.durable.set(livePacketIdentity(pending[513]!), pending[513]!);
  await Promise.all([runtime.acceptLifecycle(started()), runtime.acceptLifecycle(started())]);
  await runtime.acceptVoiceBatch({ ...packets(), packets: [pending[514]!] });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(f.reads()).toBe(2);
  expect(f.sends).toEqual(pending.map(livePacketIdentity));
  expect(f.acknowledgements).toEqual(f.sends);
  await runtime.close();
});


it.each([1, 2])("preserves recovery progress and bounded live admission with %i global slots", async (slots) => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const pending = backlog(514);
  const f = fixture(pending.slice(0, 513), undefined, undefined, {
    flow: { maximumQueuedPacketsGlobally: slots, maximumQueuedPacketsPerSpeaker: 1 },
  });
  const runtime = f.makeRuntime();
  await runtime.acceptLifecycle(started());
  f.durable.set(livePacketIdentity(pending[513]!), pending[513]!);
  let admitted = false;
  const live = runtime.acceptVoiceBatch({ ...packets(), packets: [pending[513]!] }).then(() => { admitted = true; return admitted; });
  await vi.advanceTimersByTimeAsync(1_999);
  expect(admitted).toBe(true);
  await live;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(f.sends).toEqual(pending.slice(0, slots === 1 ? 513 : 514).map(livePacketIdentity));
  expect(f.durable.size).toBe(slots === 1 ? 1 : 0);
  expect(f.acknowledgements).toEqual(f.sends);
  await runtime.close();
});

it("reconnect rereads a cancelled backlog without a duplicate drain or late acknowledgement", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = backlog(513);
  const f = fixture(pending, undefined, gate);
  const runtime = f.makeRuntime();
  await runtime.acceptLifecycle(started());
  await vi.advanceTimersByTimeAsync(0);
  await runtime.acceptLifecycle({ ...ended(), type: "meeting.connection_lost" });
  await Promise.all([
    runtime.acceptLifecycle({ ...ended(), type: "meeting.connection_recovered" }),
    runtime.acceptLifecycle({ ...ended(), type: "meeting.connection_recovered" }),
  ]);
  release();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(f.reads()).toBe(2);
  expect(f.sends).toEqual([livePacketIdentity(pending[0]!), ...pending.map(livePacketIdentity)]);
  expect(f.acknowledgements).toEqual(pending.map(livePacketIdentity));
  await runtime.close();
});

it("bounds live admission during a stalled initialization and discards its late read after shutdown", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  let release!: () => void;
  const readGate = new Promise<void>((resolve) => { release = resolve; });
  const f = fixture(backlog(513), undefined, undefined, { readGate });
  const runtime = f.makeRuntime();
  const start = runtime.acceptLifecycle(started());
  let admitted = false;
  const live = runtime.acceptVoiceBatch(packets()).then(() => { admitted = true; return admitted; });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(admitted).toBe(true);
  await live;
  await runtime.close();
  release();
  await start;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(f.sends).toHaveLength(0);
  expect(f.durable.size).toBe(513);
});


it("disconnect cancels a lease handoff between two 513-packet speakers before opening, then reconnects", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const pending = [...backlog(513), ...backlog(513).map((packet) => ({ ...packet, speakerId: "speaker-b" }))];
  let releaseOpening!: () => void;
  const openingGate = new Promise<void>((resolve) => { releaseOpening = resolve; });
  const opens: string[] = [];
  const active = new Set<string>();
  const sent: string[] = [];
  let terminations = 0;
  const f = fixture(pending, undefined, undefined, {
    flow: { maximumConcurrentSessions: 1, packetBackpressureTimeoutMs: 100 },
    transcriber: {
      openSession: async (request) => {
        opens.push(request.speakerId);
        if (opens.length === 2) { await openingGate; }
        active.add(request.speakerId);
        return {
          sendPacket: async (packet) => { sent.push(packet.packetId); return "accepted"; },
          finalize: async () => { active.delete(request.speakerId); },
          terminate: () => { terminations += 1; active.delete(request.speakerId); },
        };
      },
    },
  });
  const runtime = f.makeRuntime();
  await runtime.acceptLifecycle(started());
  await vi.advanceTimersByTimeAsync(0);
  expect(opens).toEqual([pending[0]!.speakerId]);
  // Cancelling A synchronously grants B's lease, then cancels B before its continuation.
  let disconnected = false;
  const disconnect = runtime.acceptLifecycle({ ...ended(), type: "meeting.connection_lost" })
    .then(() => { disconnected = true; return null; });
  await vi.advanceTimersByTimeAsync(100);
  expect(disconnected).toBe(true);
  await disconnect;
  expect(opens).toHaveLength(1);
  expect(active.size).toBe(0);
  expect(terminations).toBe(1);
  const acknowledged = [...f.acknowledgements];
  await runtime.acceptLifecycle({ ...ended(), type: "meeting.connection_recovered" });
  await vi.advanceTimersByTimeAsync(0);
  expect(opens).toHaveLength(2);
  expect(f.acknowledgements).toEqual(acknowledged);
  releaseOpening();
  await vi.advanceTimersByTimeAsync(40_000);
  expect(f.acknowledgements).toHaveLength(1026);
  expect(new Set(f.acknowledgements).size).toBe(1026);
  expect(sent).toEqual(f.acknowledgements);
  expect(f.durable.size).toBe(0);
  let closed = false;
  const close = runtime.close().then(() => { closed = true; return null; });
  await vi.advanceTimersByTimeAsync(100);
  expect(closed).toBe(true);
  await close;
  expect(active.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
