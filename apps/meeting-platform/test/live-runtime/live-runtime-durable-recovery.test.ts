import { AppendLiveTranscriptTurn, FinishLiveMeeting, RefreshLiveMeeting, StartLiveMeeting } from "@discord-meeting/meeting-core/live-meeting";
import { afterEach, expect, it, vi } from "vitest";
import { PlatformLiveMeetingRuntime } from "../../src/live-meeting-runtime.js";
import type { LivePacketFlowControl, LiveVoicePacket, LiveTranscriptionPort } from "../../src/live-runtime/contracts.js";
import { livePacketIdentity } from "../../src/live-runtime/packet-delivery-ledger.js";
import { logger, MemoryLiveMeetingRepository, packets, ProjectionStub, started, SummaryStub } from "./live-runtime-fixtures.js";

afterEach(() => vi.useRealTimers());

function fixture(
  pending: readonly LiveVoicePacket[] = [], failAt?: string, firstSend?: Promise<void>,
  options: { flow?: LivePacketFlowControl; failAck?: boolean; duplicate?: boolean } = {},
) {
  let failingPacketId = failAt;
  const meetings = new MemoryLiveMeetingRepository();
  const durable = new Map(pending.map((packet) => [livePacketIdentity(packet), packet]));
  const sends: string[] = [];
  const acknowledgements: string[] = [];
  const transcriber: LiveTranscriptionPort = {
    openSession: async () => ({
      finalize: async () => {}, terminate: () => {},
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
    startMeeting: new StartLiveMeeting({ meetings }), transcriber,
    markLivePacketDelivered: async (packetId) => {
      if (options.failAck) { throw new Error("synthetic acknowledgement failure"); }
      acknowledgements.push(packetId); durable.delete(packetId);
    },
    pendingLivePackets: async () => options.duplicate
      ? [...durable.values(), ...durable.values()].sort((left, right) => left.sequenceNumber - right.sequenceNumber)
      : [...durable.values()],
  });
  return { acknowledgements, durable, makeRuntime, sends, repair: () => { failingPacketId = undefined; } };
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


it("holds recovery and concurrent live ingress behind a slow send", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = backlog(514);
  const f = fixture(pending.slice(0, 513), undefined, gate);
  const runtime = f.makeRuntime();
  const recovery = runtime.acceptLifecycle(started());
  await vi.advanceTimersByTimeAsync(100);
  const live = runtime.acceptVoiceBatch({ ...packets(), packets: [pending[513]!] });
  await vi.advanceTimersByTimeAsync(100);
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
  expect(f.sends).toEqual([livePacketIdentity(pending[0]!)]);
  expect(f.acknowledgements).toHaveLength(0);
  expect(f.durable.size).toBe(513);
  await runtime.acceptVoiceBatch({ ...packets(), packets: [pending[512]!] });
  await runtime.close();
  expect(f.sends).toHaveLength(1);
});
