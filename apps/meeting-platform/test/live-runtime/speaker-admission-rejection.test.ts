import { afterEach, expect, it, vi } from "vitest";
import { SpeakerTranscriptionSessions } from "../../src/live-runtime/speaker-transcription-sessions.js";
import { LiveTranscriptionAcceptanceUnknown, LiveTranscriptionTerminalFailure, LiveTranscriptionAdmissionRejected } from "../../src/live-runtime/contracts.js";
import { GlobalPacketFlowControl, LiveSessionAdmission } from "../../src/live-runtime/live-packet-flow-control.js";
import { systemLiveRuntimeClock, systemLiveRuntimeTimer } from "../../src/live-runtime/runtime-clock.js";
import { logger, packets } from "./live-runtime-fixtures.js";

afterEach(() => vi.useRealTimers());
it.each([false, true].flatMap(cancel => [LiveTranscriptionAdmissionRejected, LiveTranscriptionTerminalFailure, LiveTranscriptionAcceptanceUnknown].map(Failure => ({ cancel, Failure }))))("%j: latches across queued packets, duplicate ingress, repeated recovery, cancellation and recreation without ACKs or leaked slots", async ({ cancel, Failure }) => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let reject!: (error: Error) => void;
  const openSession = vi.fn(() => new Promise<never>((_resolve, _reject) => { reject = _reject; }));
  const warn = vi.fn<typeof logger.warn>();
  const delivered = vi.fn(async () => {});
  const packetAdmission = new GlobalPacketFlowControl(128);
  const sessionAdmission = new LiveSessionAdmission(1);
  const registry = new SpeakerTranscriptionSessions({
    clock: systemLiveRuntimeClock, timer: systemLiveRuntimeTimer, isMeetingFinishing: () => false,
    logger: { ...logger, warn }, markLivePacketDelivered: delivered,
    maximumQueuedPackets: 64, meetingId: "meeting", onTranscript: () => {},
    packetAdmission, packetBackpressureTimeoutMs: 100, packetInspector: { durationSamples48Khz: () => 960 },
    sessionAdmission, speakerIdleFinalizeMs: 1000, startedAtMs: 0, transcriber: { openSession },
  });
  const batch = { ...packets(), packets: Array.from({ length: 40 }, (_, i) => ({ ...packets().packets[0]!, sequenceNumber: i, relativeTimeMs: 0 })) };
  await registry.accept(batch);
  await vi.advanceTimersByTimeAsync(0);
  const recovery = registry.recover(batch.packets);
  if (cancel) { registry.cancelRecovery(); } // delete the old speaker while its opening is unresolved
  reject(new Failure());
  await vi.advanceTimersByTimeAsync(0);
  await recovery;
  await registry.accept(batch);
  await registry.accept(batch);
  await registry.recover(batch.packets);
  await registry.recover(batch.packets);
  await vi.advanceTimersByTimeAsync(2000);
  registry.beginFinish();
  if (Failure === LiveTranscriptionAdmissionRejected) { await registry.finish(); }
  else { await expect(registry.finish()).rejects.toBeInstanceOf(AggregateError); }
  expect(openSession).toHaveBeenCalledTimes(1);
  expect(delivered).not.toHaveBeenCalled();
  expect(warn.mock.calls.filter(call => call[1]?.errorCode === (Failure === LiveTranscriptionAdmissionRejected ? "LIVE_TRANSCRIPTION_ADMISSION_REJECTED" : Failure === LiveTranscriptionTerminalFailure ? "LIVE_TRANSCRIPTION_PROVIDER_TERMINAL" : "LIVE_TRANSCRIPTION_ACCEPTANCE_UNKNOWN"))).toHaveLength(1);
  expect(await packetAdmission.reserve(128, 3000, new AbortController().signal)).toBe(true);
  packetAdmission.release(128);
  const release = await sessionAdmission.acquire(new AbortController().signal);
  expect(release).not.toBeNull();
  release?.();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([true, false])("keeps unclassified retryable=%s failures visible and retryable", async (retryable) => {
  const error = Object.assign(new Error("synthetic uncertain provider outcome"), { retryable });
  const openSession = vi.fn(async () => { throw error; });
  const warn = vi.fn<typeof logger.warn>();
  const registry = new SpeakerTranscriptionSessions({
    clock: systemLiveRuntimeClock, timer: systemLiveRuntimeTimer, isMeetingFinishing: () => false,
    logger: { ...logger, warn }, maximumQueuedPackets: 8, meetingId: "meeting", onTranscript: () => {},
    packetAdmission: new GlobalPacketFlowControl(8), packetBackpressureTimeoutMs: 100,
    packetInspector: { durationSamples48Khz: () => 960 }, sessionAdmission: new LiveSessionAdmission(1),
    speakerIdleFinalizeMs: 1000, startedAtMs: 0, transcriber: { openSession },
  });
  await registry.recover([packets().packets[0]!]);
  await registry.recover([packets().packets[0]!]);
  expect(openSession).toHaveBeenCalledTimes(4);
  expect(warn.mock.calls.some(call => call[1]?.errorCode === "LIVE_TRANSCRIPTION_ADMISSION_REJECTED")).toBe(false);
  expect(warn.mock.calls.some(call => call[0] === "Derived live transcription packet failed")).toBe(true);
  registry.beginFinish();
  await registry.finish();
});

// Keep the old provider promise alive across deletion and recreation.
it.each((["waiting", "granted", "opening"] as const).flatMap(phase => [LiveTranscriptionAdmissionRejected, LiveTranscriptionTerminalFailure, LiveTranscriptionAcceptanceUnknown].map(Failure => ({ phase, Failure }))))("fences a recreated speaker during %j admission", async ({ phase, Failure }) => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const oldOpening = Promise.withResolvers<never>();
  const lateOpening = Promise.withResolvers<import("../../src/live-runtime/contracts.js").LiveTranscriptionSession>();
  const sendPacket = vi.fn(async () => "accepted" as const);
  const terminate = vi.fn();
  const openSession = vi.fn().mockImplementationOnce(() => oldOpening.promise)
    .mockImplementation(() => lateOpening.promise);
  const warn = vi.fn<typeof logger.warn>();
  const delivered = vi.fn(async () => {});
  const packetAdmission = new GlobalPacketFlowControl(8);
  const sessionAdmission = new LiveSessionAdmission(1);
  const acquire = vi.spyOn(sessionAdmission, "acquire");
  const registry = new SpeakerTranscriptionSessions({
    clock: systemLiveRuntimeClock, timer: systemLiveRuntimeTimer, isMeetingFinishing: () => false,
    logger: { ...logger, warn }, markLivePacketDelivered: delivered,
    maximumQueuedPackets: 8, meetingId: "meeting", onTranscript: () => {},
    packetAdmission, packetBackpressureTimeoutMs: 100, packetInspector: { durationSamples48Khz: () => 960 },
    sessionAdmission, speakerIdleFinalizeMs: 1000, startedAtMs: 0, transcriber: { openSession },
  });
  const packet = { ...packets().packets[0]!, relativeTimeMs: 0 };
  const oldRecovery = registry.recover([packet]);
  await vi.advanceTimersByTimeAsync(0);
  expect(openSession).toHaveBeenCalledTimes(1);
  expect(registry.cancelRecovery()).toBe(true);
  await oldRecovery;
  const occupied = await sessionAdmission.acquire(new AbortController().signal);
  expect(occupied).not.toBeNull();
  const replacement = registry.recover([packet]);
  await vi.advanceTimersByTimeAsync(0);
  expect(acquire).toHaveBeenCalledTimes(3);
  expect(openSession).toHaveBeenCalledTimes(1);
  if (phase === "opening") {
    occupied?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(openSession).toHaveBeenCalledTimes(2);
  }
  oldOpening.reject(new Failure());
  if (phase === "granted") {
    // Queue the rejection continuation ahead of the newly granted lease continuation.
    await Promise.resolve();
    occupied?.();
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(warn.mock.calls.filter(call => call[1]?.errorCode === (Failure === LiveTranscriptionAdmissionRejected ? "LIVE_TRANSCRIPTION_ADMISSION_REJECTED" : Failure === LiveTranscriptionTerminalFailure ? "LIVE_TRANSCRIPTION_PROVIDER_TERMINAL" : "LIVE_TRANSCRIPTION_ACCEPTANCE_UNKNOWN"))).toHaveLength(1);
  let completed = false;
  void replacement.then(() => { completed = true; return true; });
  await vi.advanceTimersByTimeAsync(0);
  // Cancellation settles recovery even while the occupied lease/provider remains unresolved.
  const completedBeforeRelease = completed;
  occupied?.();
  lateOpening.resolve({ sendPacket, terminate, finalize: async () => {} });
  await vi.advanceTimersByTimeAsync(0);
  await replacement;
  await registry.recover([packet]);
  registry.beginFinish();
  if (Failure === LiveTranscriptionAdmissionRejected) { await registry.finish(); }
  else { await expect(registry.finish()).rejects.toBeInstanceOf(AggregateError); }
  expect(openSession).toHaveBeenCalledTimes(phase === "opening" ? 2 : 1);
  expect(completedBeforeRelease).toBe(true);
  expect(sendPacket).not.toHaveBeenCalled();
  expect(delivered).not.toHaveBeenCalled();
  expect(terminate).toHaveBeenCalledTimes(phase === "opening" ? 1 : 0);
  expect(warn.mock.calls.filter(call => call[1]?.errorCode === (Failure === LiveTranscriptionAdmissionRejected ? "LIVE_TRANSCRIPTION_ADMISSION_REJECTED" : Failure === LiveTranscriptionTerminalFailure ? "LIVE_TRANSCRIPTION_PROVIDER_TERMINAL" : "LIVE_TRANSCRIPTION_ACCEPTANCE_UNKNOWN"))).toHaveLength(1);
  expect(await packetAdmission.reserve(8, 100, new AbortController().signal)).toBe(true);
  packetAdmission.release(8);
  const lease = await sessionAdmission.acquire(new AbortController().signal);
  expect(lease).not.toBeNull();
  const blocked = new AbortController();
  const extraLease = sessionAdmission.acquire(blocked.signal);
  blocked.abort();
  expect(await extraLease).toBeNull();
  lease?.();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([LiveTranscriptionTerminalFailure, LiveTranscriptionAcceptanceUnknown])("%s send fences queued/duplicate/recovered audio while another speaker progresses", async (Failure) => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const failure = new Failure();
  const sendPacket = vi.fn(async () => { throw failure; });
  const otherSend = vi.fn(async () => "accepted" as const);
  const terminate = vi.fn();
  const openSession = vi.fn(async (request: { speakerId: string }) => ({
    sendPacket: request.speakerId === "other" ? otherSend : sendPacket,
    finalize: async () => {}, terminate,
  }));
  const delivered = vi.fn(async () => {}); const warn = vi.fn<typeof logger.warn>();
  const packetAdmission = new GlobalPacketFlowControl(8); const sessionAdmission = new LiveSessionAdmission(1);
  const registry = new SpeakerTranscriptionSessions({
    clock: systemLiveRuntimeClock, timer: systemLiveRuntimeTimer, isMeetingFinishing: () => false,
    logger: { ...logger, warn }, markLivePacketDelivered: delivered, maximumQueuedPackets: 8,
    meetingId: "meeting", onTranscript: () => {}, packetAdmission, packetBackpressureTimeoutMs: 100,
    packetInspector: { durationSamples48Khz: () => 960 }, sessionAdmission,
    speakerIdleFinalizeMs: 1000, startedAtMs: 0, transcriber: { openSession },
  });
  const packet = { ...packets().packets[0]!, relativeTimeMs: 0 };
  const batch = { ...packets(), packets: [packet, { ...packet, sequenceNumber: 2 }] };
  await registry.accept(batch); await vi.advanceTimersByTimeAsync(0);
  await registry.accept(batch); await registry.recover(batch.packets); await registry.recover(batch.packets);
  expect(openSession).toHaveBeenCalledTimes(1); expect(sendPacket).toHaveBeenCalledTimes(1);
  expect(delivered).not.toHaveBeenCalled();
  await registry.accept({ ...batch, packets: [{ ...packet, speakerId: "other" }] });
  await vi.advanceTimersByTimeAsync(0);
  expect(otherSend).toHaveBeenCalledTimes(1); expect(delivered).toHaveBeenCalledTimes(1);
  await expect(registry.finish()).rejects.toBeInstanceOf(AggregateError);
  expect(terminate).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls.filter(call => call[1]?.errorCode === (Failure === LiveTranscriptionTerminalFailure ? "LIVE_TRANSCRIPTION_PROVIDER_TERMINAL" : "LIVE_TRANSCRIPTION_ACCEPTANCE_UNKNOWN"))).toHaveLength(1);
  expect(await packetAdmission.reserve(8, 100, new AbortController().signal)).toBe(true); packetAdmission.release(8);
  const lease = await sessionAdmission.acquire(new AbortController().signal); expect(lease).not.toBeNull(); lease?.();
  expect(vi.getTimerCount()).toBe(0);
});
