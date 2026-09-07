import { afterEach, expect, it, vi } from "vitest";
import { SpeakerTranscriptionProviderSession } from "../../src/live-runtime/speaker-transcription-provider-session.js";
import { SpeakerTranscriptionSession } from "../../src/live-runtime/speaker-transcription-session.js";
import { GlobalPacketFlowControl, LiveSessionAdmission } from "../../src/live-runtime/live-packet-flow-control.js";
import { livePacketIdentity, LivePacketDeliveryLedger } from "../../src/live-runtime/packet-delivery-ledger.js";
import { systemLiveRuntimeClock, systemLiveRuntimeTimer } from "../../src/live-runtime/runtime-clock.js";
import { LiveTranscriptionTerminalFailure, type LiveTranscriptionEvent, type LiveTranscriptionPort } from "../../src/live-runtime/contracts.js";
import { logger, packets } from "./live-runtime-fixtures.js";

afterEach(() => vi.useRealTimers());

function provider() {
  let complete!: () => void;
  let rejectFinalize!: (error: Error) => void;
  let running = false;
  const events: string[] = [];
  let onTranscript: ((event: LiveTranscriptionEvent) => void) | undefined;
  const finalize = vi.fn(() => {
    running = true;
    return new Promise<void>((resolve, reject) => {
      rejectFinalize = reject;
      complete = () => { if (running) { onTranscript?.({ meetingId: "meeting", speakerId: "speaker", startMs: 0, endMs: 20, text: "Late final evidence", isFinal: true }); running = false; resolve(); } };
    });
  });
  const terminate = vi.fn(() => {
    running = false;
    rejectFinalize(new Error("terminated"));
  });
  const transcriber: LiveTranscriptionPort = {
    openSession: async (request) => {
      onTranscript = request.onTranscript;
      return { finalize, terminate, sendPacket: async () => "accepted" };
    },
  };
  return { transcriber, finalize, terminate, events, complete: () => { complete(); }, running: () => running };
}

it("finish deadline terminates the owned finalizing provider exactly once and releases its slot", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const p = provider();
  const admission = new LiveSessionAdmission(1);
  let finishing = false;
  const speaker = new SpeakerTranscriptionSession({
    clock: systemLiveRuntimeClock, timer: systemLiveRuntimeTimer,
    isMeetingFinishing: () => finishing, ledger: new LivePacketDeliveryLedger(), logger,
    maximumQueuedPackets: 1, meetingId: "meeting", onTranscript: (event) => { p.events.push(event.text); },
    packetAdmission: new GlobalPacketFlowControl(2), packetBackpressureTimeoutMs: 100,
    packetInspector: { durationSamples48Khz: () => 960 }, sessionAdmission: admission,
    speakerId: "speaker", speakerIdleFinalizeMs: 1000, startedAtMs: 0, transcriber: p.transcriber,
  });
  await speaker.accept([{ ...packets().packets[0]!, relativeTimeMs: 0 }], 100);
  await vi.advanceTimersByTimeAsync(0);
  finishing = true;
  speaker.beginFinish();
  let settled = false;
  const finish = speaker.finish().then(() => { settled = true; return null; });
  await vi.advanceTimersByTimeAsync(0);
  expect(p.running()).toBe(true);
  await vi.advanceTimersByTimeAsync(34_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toBe(true);
  expect(p.running()).toBe(false);
  expect(p.terminate).toHaveBeenCalledTimes(1);
  await finish;
  const release = await admission.acquire(new AbortController().signal);
  expect(release).not.toBeNull();
  release?.();
  p.complete();
  await speaker.finish();
  expect(p.events).toEqual([]);
  expect(p.finalize).toHaveBeenCalledTimes(1);
  expect(p.terminate).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps late successful finalization owned until its final evidence completes, then cleans up once", async () => {
  const p = provider();
  const admission = new LiveSessionAdmission(1);
  const owner = new SpeakerTranscriptionProviderSession({
    logger, meetingId: "meeting", speakerId: "speaker", onTranscript: (event) => { p.events.push(event.text); },
    sessionAdmission: admission, transcriber: p.transcriber,
  });
  await owner.open(new AbortController().signal);
  const finish = owner.finalize("synthetic finalize failure");
  expect(owner.isOpen).toBe(true);
  let acquired = false;
  const next = admission.acquire(new AbortController().signal).then((release) => { acquired = true; return release; });
  await Promise.resolve();
  expect(acquired).toBe(false);
  p.complete();
  await finish;
  expect(p.events).toEqual(["Late final evidence"]);
  expect(owner.isOpen).toBe(false);
  (await next)?.();
  owner.terminate();
  await owner.finalize("synthetic finalize failure");
  expect(p.finalize).toHaveBeenCalledTimes(1);
  expect(p.terminate).not.toHaveBeenCalled();
});

it.each(["healthy", "stalled ACK", "stalled receipt", "stalled finalize", "cancelled", "cancelled finalize"] as const)(
  "drains 201 overdue packets with independent finalization supervision: %s", async (mode) => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const sent: string[] = [];
    const receipts: string[] = [];
    const rejection = new AbortController();
    const terminate = vi.fn();
    const finalize = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        if (mode !== "stalled finalize") { setTimeout(resolve, 3_000); }
      });
    });
    const packetAdmission = new GlobalPacketFlowControl(512);
    const speaker = new SpeakerTranscriptionSession({
      admissionRejection: rejection,
      clock: systemLiveRuntimeClock, timer: systemLiveRuntimeTimer,
      isMeetingFinishing: () => false, ledger: new LivePacketDeliveryLedger(), logger,
      maximumQueuedPackets: 512, meetingId: "meeting", onTranscript: () => {},
      packetAdmission, packetBackpressureTimeoutMs: 2_000,
      packetInspector: { durationSamples48Khz: () => 960 }, sessionAdmission: new LiveSessionAdmission(1),
      speakerId: "speaker", speakerIdleFinalizeMs: 750, startedAtMs: 0,
      markLivePacketDelivered: async (id) => {
        if (mode === "stalled receipt") { await new Promise<void>(() => {}); }
        receipts.push(id);
      },
      transcriber: { openSession: async () => ({ finalize, terminate, sendPacket: async (packet) => {
        sent.push(packet.packetId);
        if (mode === "stalled ACK") { await new Promise<void>(() => {}); }
        return "accepted";
      } }) },
    });
    const batch = Array.from({ length: 201 }, (_, index) => ({
      ...packets().packets[0]!, relativeTimeMs: index * 20, sequenceNumber: index, mediaTimestamp: index * 960,
    }));
    await speaker.accept(batch, 12_000);
    const finish = speaker.finish();
    const duplicateFinish = speaker.finish();
    const finished = Promise.allSettled([finish, duplicateFinish]);
    await speaker.accept([{ ...batch[0]!, relativeTimeMs: 9_000 }], 12_000);
    await vi.advanceTimersByTimeAsync(1_000);
    if (mode === "cancelled") { rejection.abort(); }
    await vi.advanceTimersByTimeAsync(4_000);
    if (mode === "cancelled finalize") { rejection.abort(); }
    await vi.advanceTimersByTimeAsync(35_000);
    const outcomes = await finished;
    expect(outcomes.map((outcome) => outcome.status)).toEqual(
      mode === "stalled receipt" ? ["rejected", "rejected"] : ["fulfilled", "fulfilled"],
    );
    if (mode === "healthy" || mode === "stalled finalize" || mode === "cancelled finalize") {
      expect(sent).toEqual(batch.map(livePacketIdentity));
      expect(new Set(sent).size).toBe(201);
      expect(receipts).toEqual(sent);
      expect(finalize).toHaveBeenCalledTimes(1);
    } else {
      expect(sent.length).toBeLessThan(201);
      expect(finalize).not.toHaveBeenCalled();
    }
    expect(terminate).toHaveBeenCalledTimes(mode === "healthy" ? 0 : 1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("freezes a pending queue reservation without cancelling already admitted audio", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let acknowledge!: () => void;
  const finalize = vi.fn(async () => {});
  const terminate = vi.fn();
  const sendPacket = vi.fn(async () => {
    await new Promise<void>((resolve) => { acknowledge = resolve; });
    return "accepted" as const;
  });
  const packetAdmission = new GlobalPacketFlowControl(2);
  const speaker = new SpeakerTranscriptionSession({
    clock: systemLiveRuntimeClock, timer: systemLiveRuntimeTimer,
    isMeetingFinishing: () => false, ledger: new LivePacketDeliveryLedger(), logger,
    maximumQueuedPackets: 1, meetingId: "meeting", onTranscript: () => {},
    packetAdmission, packetBackpressureTimeoutMs: 2_000,
    packetInspector: { durationSamples48Khz: () => 960 }, sessionAdmission: new LiveSessionAdmission(1),
    speakerId: "speaker", speakerIdleFinalizeMs: 750, startedAtMs: 0,
    transcriber: { openSession: async () => ({ finalize, terminate, sendPacket }) },
  });
  await speaker.accept([{ ...packets().packets[0]!, relativeTimeMs: 0 }], 2_000);
  await vi.advanceTimersByTimeAsync(0);
  const pending = speaker.accept([{ ...packets().packets[0]!, relativeTimeMs: 20, sequenceNumber: 2 }], 2_000);
  await vi.advanceTimersByTimeAsync(0);
  const finish = speaker.finish();
  await pending;
  acknowledge();
  await finish;
  expect(sendPacket).toHaveBeenCalledTimes(1);
  expect(finalize).toHaveBeenCalledTimes(1);
  expect(terminate).not.toHaveBeenCalled();
  expect(await packetAdmission.reserve(2, 2_000, new AbortController().signal)).toBe(true);
  packetAdmission.release(2);
  expect(vi.getTimerCount()).toBe(0);
});

function freezeFixture(packetAdmission = new GlobalPacketFlowControl(2), stalled = false) {
  const sendPacket = vi.fn(async () => {
    if (stalled) { await new Promise<void>(() => {}); }
    return "accepted" as const;
  });
  const finalize = vi.fn(async () => {});
  const terminate = vi.fn();
  const speaker = new SpeakerTranscriptionSession({
    clock: systemLiveRuntimeClock, timer: systemLiveRuntimeTimer,
    isMeetingFinishing: () => false, ledger: new LivePacketDeliveryLedger(), logger,
    maximumQueuedPackets: 2, meetingId: "meeting", onTranscript: () => {},
    packetAdmission, packetBackpressureTimeoutMs: 2_000,
    packetInspector: { durationSamples48Khz: () => 960 }, sessionAdmission: new LiveSessionAdmission(1),
    speakerId: "speaker", speakerIdleFinalizeMs: 750, startedAtMs: 0,
    transcriber: { openSession: async () => ({ finalize, terminate, sendPacket }) },
  });
  const packet = { ...packets().packets[0]!, relativeTimeMs: 0 };
  return { speaker, packet, sendPacket, finalize, terminate, packetAdmission };
}

it("bounds a stalled drain to two relative seconds across a backward one-hour wall-clock jump", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const f = freezeFixture(undefined, true);
  await f.speaker.accept([f.packet], 12_000);
  await vi.advanceTimersByTimeAsync(0);
  let finished = false;
  const finish = f.speaker.finish().then(() => { finished = true; return null; });
  await vi.advanceTimersByTimeAsync(0);
  vi.setSystemTime(Date.now() - 3_600_000);
  await vi.advanceTimersByTimeAsync(1_999);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(finished).toBe(true);
  await finish;
  expect(f.sendPacket).toHaveBeenCalledTimes(1);
  expect(f.terminate).toHaveBeenCalledTimes(1);
  expect(f.finalize).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("rechecks finish after the resolved queue-capacity await before reserving the first packet", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const f = freezeFixture();
  const accept = f.speaker.accept([f.packet], 2_000);
  await Promise.resolve();
  await Promise.resolve();
  const finish = f.speaker.finish();
  await Promise.all([accept, finish]);
  expect(f.sendPacket).not.toHaveBeenCalled();
  expect(f.finalize).not.toHaveBeenCalled();
  expect(await f.packetAdmission.reserve(2, 2_000, new AbortController().signal)).toBe(true);
  f.packetAdmission.release(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("finish removes a pending global admission timer and FIFO head without blocking another speaker", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const f = freezeFixture();
  const signal = new AbortController().signal;
  expect(await f.packetAdmission.reserve(1, 2_000, signal)).toBe(true);
  let accepted = false;
  const accept = f.speaker.accept([f.packet, { ...f.packet, sequenceNumber: 2 }], 2_000)
    .then(() => { accepted = true; return null; });
  const other = freezeFixture(f.packetAdmission);
  const otherAccept = other.speaker.accept([other.packet], 2_000);
  expect(vi.getTimerCount()).toBe(2);
  await f.speaker.finish();
  expect(accepted).toBe(true);
  await accept;
  await otherAccept;
  await other.speaker.finish();
  expect(other.sendPacket).toHaveBeenCalledTimes(1);
  expect(f.sendPacket).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  f.packetAdmission.release(1);
  expect(await f.packetAdmission.reserve(2, 2_000, signal)).toBe(true);
  f.packetAdmission.release(2);
});

it.each(["healthy", "stalled"] as const)("joins idle finalize with its original provider budget: %s", async (mode) => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const p = provider();
  const speaker = new SpeakerTranscriptionSession({
    clock: systemLiveRuntimeClock, timer: systemLiveRuntimeTimer,
    isMeetingFinishing: () => false, ledger: new LivePacketDeliveryLedger(), logger,
    maximumQueuedPackets: 512, meetingId: "meeting", onTranscript: (event) => { p.events.push(event.text); },
    packetAdmission: new GlobalPacketFlowControl(512), packetBackpressureTimeoutMs: 2_000,
    packetInspector: { durationSamples48Khz: () => 960 }, sessionAdmission: new LiveSessionAdmission(1),
    speakerId: "speaker", speakerIdleFinalizeMs: 750, startedAtMs: 0, transcriber: p.transcriber,
  });
  await speaker.accept([{ ...packets().packets[0]!, relativeTimeMs: 0 }], 2_000);
  await vi.advanceTimersByTimeAsync(750);
  expect(p.finalize).toHaveBeenCalledTimes(1);
  if (mode === "stalled") { await vi.advanceTimersByTimeAsync(34_000); }
  let settled = false;
  const finish = speaker.finish().then(() => { settled = true; return null; });
  await vi.advanceTimersByTimeAsync(mode === "healthy" ? 3_000 : 999);
  expect(settled).toBe(false);
  expect(p.terminate).not.toHaveBeenCalled();
  if (mode === "healthy") { p.complete(); } else { await vi.advanceTimersByTimeAsync(1); }
  await finish;
  expect(p.events).toEqual(mode === "healthy" ? ["Late final evidence"] : []);
  expect(p.finalize).toHaveBeenCalledTimes(1);
  expect(p.terminate).toHaveBeenCalledTimes(mode === "healthy" ? 0 : 1);
  expect(vi.getTimerCount()).toBe(0);
});


it("retries failed settlement after a stalled receipt without repeating provider effects", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const receipt = Promise.withResolvers<void>();
  const receiptStarted = Promise.withResolvers<void>();
  const sendPacket = vi.fn(async () => "accepted" as const);
  const finalize = vi.fn(async () => {});
  const terminate = vi.fn();
  const openSession = vi.fn(async () => ({ sendPacket, finalize, terminate }));
  const markLivePacketDelivered = vi.fn(async () => {
    receiptStarted.resolve();
    await receipt.promise;
  });
  const speaker = new SpeakerTranscriptionSession({
    clock: systemLiveRuntimeClock, timer: systemLiveRuntimeTimer,
    isMeetingFinishing: () => false, ledger: new LivePacketDeliveryLedger(), logger,
    maximumQueuedPackets: 2, meetingId: "meeting", onTranscript: () => {},
    packetAdmission: new GlobalPacketFlowControl(2), packetBackpressureTimeoutMs: 2_000,
    packetInspector: { durationSamples48Khz: () => 960 }, sessionAdmission: new LiveSessionAdmission(1),
    speakerId: "speaker", speakerIdleFinalizeMs: 750, startedAtMs: 0,
    markLivePacketDelivered, transcriber: { openSession },
  });
  const packet = { ...packets().packets[0]!, relativeTimeMs: 0 };
  await speaker.accept([packet], 2_000);
  await receiptStarted.promise;
  const first = speaker.finish();
  expect(speaker.finish()).toBe(first);
  let settled = false;
  const failure = first.catch((error: unknown) => { settled = true; return error; });
  await vi.advanceTimersByTimeAsync(1_999);
  expect(settled).toBe(false);
  expect(terminate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await failure).toEqual(new Error("Live packet durable receipt is still pending"));
  expect(terminate).toHaveBeenCalledTimes(1);
  const stillPending = speaker.finish();
  expect(stillPending).not.toBe(first);
  expect(speaker.finish()).toBe(stillPending);
  await expect(stillPending).rejects.toThrow("Live packet durable receipt is still pending");
  receipt.resolve();
  await vi.advanceTimersByTimeAsync(0);
  const retry = speaker.finish();
  expect(speaker.finish()).toBe(retry);
  await expect(retry).resolves.toBeUndefined();
  expect(speaker.finish()).toBe(retry);
  await speaker.accept([{ ...packet, sequenceNumber: 2, relativeTimeMs: 20 }], 4_000);
  await speaker.recover([packet]);
  expect(openSession).toHaveBeenCalledTimes(1);
  expect(sendPacket).toHaveBeenCalledTimes(1);
  expect(markLivePacketDelivered).toHaveBeenCalledTimes(1);
  expect(finalize).not.toHaveBeenCalled();
  expect(terminate).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("idle terminal finalization fences queued new speech and repeated finish without losing accepted effects", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const finalization = Promise.withResolvers<void>();
  const failure = new LiveTranscriptionTerminalFailure();
  const finalize = vi.fn(() => finalization.promise); const terminate = vi.fn();
  const sendPacket = vi.fn(async () => "accepted" as const);
  const openSession = vi.fn(async () => ({ finalize, terminate, sendPacket }));
  const delivered = vi.fn(async () => {}); const warn = vi.fn<typeof logger.warn>();
  const packetAdmission = new GlobalPacketFlowControl(8); const sessionAdmission = new LiveSessionAdmission(1);
  const ledger = new LivePacketDeliveryLedger();
  const speaker = new SpeakerTranscriptionSession({
    clock: systemLiveRuntimeClock, timer: systemLiveRuntimeTimer, isMeetingFinishing: () => false,
    logger: { ...logger, warn }, markLivePacketDelivered: delivered, maximumQueuedPackets: 8,
    ledger, meetingId: "meeting", speakerId: "speaker", onTranscript: () => {},
    packetAdmission, packetBackpressureTimeoutMs: 100, packetInspector: { durationSamples48Khz: () => 960 },
    sessionAdmission, speakerIdleFinalizeMs: 1000, startedAtMs: 0, transcriber: { openSession },
  });
  const packet = { ...packets().packets[0]!, relativeTimeMs: 0 };
  await speaker.accept([packet], 100); await vi.advanceTimersByTimeAsync(1000);
  expect(finalize).toHaveBeenCalledTimes(1);
  await speaker.accept([{ ...packet, sequenceNumber: 2, relativeTimeMs: 1000 }], 1100);
  finalization.reject(failure); await vi.advanceTimersByTimeAsync(0);
  await expect(speaker.finish()).rejects.toBe(failure);
  await expect(speaker.finish()).rejects.toBe(failure);
  expect(openSession).toHaveBeenCalledTimes(1); expect(sendPacket).toHaveBeenCalledTimes(1);
  expect(delivered).toHaveBeenCalledExactlyOnceWith(livePacketIdentity(packet));
  expect(ledger.isDelivered(livePacketIdentity(packet))).toBe(true);
  expect(finalize).toHaveBeenCalledTimes(1); expect(terminate).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls.filter(call => call[1]?.errorCode === "LIVE_TRANSCRIPTION_PROVIDER_TERMINAL")).toHaveLength(1);
  expect(await packetAdmission.reserve(8, 1100, new AbortController().signal)).toBe(true); packetAdmission.release(8);
  const lease = await sessionAdmission.acquire(new AbortController().signal); expect(lease).not.toBeNull(); lease?.();
  expect(vi.getTimerCount()).toBe(0);
});
