import { afterEach, expect, it, vi } from "vitest";
import { SpeakerTranscriptionProviderSession } from "../../src/live-runtime/speaker-transcription-provider-session.js";
import { SpeakerTranscriptionSession } from "../../src/live-runtime/speaker-transcription-session.js";
import { GlobalPacketFlowControl, LiveSessionAdmission } from "../../src/live-runtime/live-packet-flow-control.js";
import { LivePacketDeliveryLedger } from "../../src/live-runtime/packet-delivery-ledger.js";
import { systemLiveRuntimeClock, systemLiveRuntimeTimer } from "../../src/live-runtime/runtime-clock.js";
import type { LiveTranscriptionEvent, LiveTranscriptionPort } from "../../src/live-runtime/contracts.js";
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
  await vi.advanceTimersByTimeAsync(99);
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
