import { expect, it, vi } from "vitest";
import { liveMeetingVocabulary, meetingVocabulary } from "../src/composition/meeting-vocabulary.js";
import { VoicetextAdapterError, VoicetextLiveTranscriptionAdapter } from "@discord-meeting/voicetext-adapter";

const options = { endpoint: "ws://localhost", token: "synthetic-token-123456", profile: "elevenlabs-scribe-v2-realtime" as const };
const request = { meetingId: "m", speakerId: "s", idempotencyKey: "k", onTranscript: () => {} };
it("retains exact batch vocabulary and changes only the live phrase", () => {
  expect(meetingVocabulary).toEqual(["BullMQ", "Craig", "Craig recording", "Dima", "Discord", "Discord thread", "idempotency key", "Iliya", "landing page", "landing slug", "live Pipecat assistant", "Marina", "Mark", "Meeting Platform", "Nazar", "Pipecat", "PostgreSQL", "PostgreSQL pipeline", "QID", "Quanta", "Quanta ID", "Quanta Pages", "Redis", "Redis queue", "referral code", "referral link", "timestamp", "Vlad"]);
  expect(liveMeetingVocabulary).toEqual(meetingVocabulary.map(term => term === "live Pipecat assistant" ? "Pipecat assistant" : term));
  expect(Array.from("Pipecat assistant")).toHaveLength(17);
});
for (const keyterms of [liveMeetingVocabulary, ["a".repeat(20)], ["😀".repeat(20)], ["  Pipecat   assistant  "], ["a\u0085b"]]) {
  it(`admits normalized scalar vocabulary before connecting: ${keyterms[0]}`, async () => {
    const connect = vi.fn(async () => { throw new Error("connection reached"); });
    const adapter = new VoicetextLiveTranscriptionAdapter({ ...options, keyterms }, { connect });
    await expect(adapter.openSession(request)).rejects.toThrow("connection reached");
    expect(connect).toHaveBeenCalledTimes(1);
  });
}
for (const keyterms of [["a".repeat(21)], ["a".repeat(22)], ["😀".repeat(21)], meetingVocabulary, Array.from({ length: 51 }, (_, i) => String(i))]) {
  it(`rejects at OPEN without construction failure or connection: ${keyterms[0]}`, async () => {
    const connect = vi.fn();
    const adapter = new VoicetextLiveTranscriptionAdapter({ ...options, keyterms }, { connect });
    await expect(adapter.openSession(request)).rejects.toMatchObject({ code: "live_admission_rejected", retryable: false });
    expect(connect).not.toHaveBeenCalled();
  });
}

import { mapLiveAdmission } from "../src/composition/discord-live.js";
import { LiveTranscriptionAdmissionRejected, LiveTranscriptionTerminalFailure, LiveTranscriptionAcceptanceUnknown } from "../src/live-runtime/contracts.js";

it.each(["open", "send", "finalize"] as const)("composition translates actual %s failures", async (phase) => {
  for (const [code, expected] of [
    ["live_admission_rejected", LiveTranscriptionAdmissionRejected],
    ["live_provider_terminal", LiveTranscriptionTerminalFailure],
    ["live_acceptance_unknown", LiveTranscriptionAcceptanceUnknown],
  ] as const) {
    const error = new VoicetextAdapterError(code, "synthetic", false);
    const mapped = mapLiveAdmission({ openSession: async () => {
      if (phase === "open") { throw error; }
      return { sendPacket: async () => { throw error; }, finalize: async () => { throw error; }, terminate: () => {} };
    } });
    if (phase === "open") { await expect(mapped.openSession(request)).rejects.toBeInstanceOf(expected); }
    else {
      const session = await mapped.openSession(request);
      await expect(phase === "finalize" ? session.finalize() : session.sendPacket({
        packetId: "p", opus: new Uint8Array([1]), durationSamples48Khz: 960, relativeTimeMs: 0,
      })).rejects.toBeInstanceOf(expected);
    }
  }
});
it("composition does not trust arbitrary retryable:false", async () => {
  const error = Object.assign(new Error("unclassified"), { retryable: false });
  await expect(mapLiveAdmission({ openSession: async () => { throw error; } }).openSession(request)).rejects.toBe(error);
});

it.each(["open", "send", "finalize"] as const)("translates deployed two-field gateway errors from %s through the real adapter", async (phase) => {
  for (const [code, Expected] of [
    ["PROVIDER_TERMINAL", LiveTranscriptionTerminalFailure],
    ["PROVIDER_OUTCOME_UNKNOWN", LiveTranscriptionAcceptanceUnknown],
  ] as const) {
    type Frame = import("@discord-meeting/voicetext-adapter").VoicetextInboundFrame;
    const frames: Frame[] = [];
    let waiting: ((frame: Frame) => void) | undefined;
    const enqueue = (message: object) => {
      const frame: Frame = { type: "text", data: JSON.stringify(message) };
      if (waiting === undefined) { frames.push(frame); }
      else { const resolve = waiting; waiting = undefined; resolve(frame); }
    };
    const fail = () => { enqueue({ type: "error", code, message: "synthetic" }); };
    const socket: import("@discord-meeting/voicetext-adapter").VoicetextWebSocketConnection = {
      sendText: async (raw) => {
        const message = JSON.parse(raw) as { type: string };
        if (message.type === "config") {
          if (phase === "open") { fail(); }
          else { enqueue({ type: "ready", provider: "elevenlabs", model: "scribe_v2_realtime", session_id: "00000000-0000-4000-8000-000000000001" }); }
        } else if (message.type === "finalize") { fail(); }
      },
      sendBinary: async () => { fail(); },
      receive: async (signal) => {
        signal.throwIfAborted();
        const frame = frames.shift();
        if (frame !== undefined) { return frame; }
        return new Promise<Frame>((resolve, reject) => {
          const abort = () => { waiting = undefined; reject(signal.reason); };
          signal.addEventListener("abort", abort, { once: true });
          waiting = (value) => { signal.removeEventListener("abort", abort); resolve(value); };
        });
      },
      close: async () => {}, terminate: () => {},
    };
    const port = mapLiveAdmission(new VoicetextLiveTranscriptionAdapter(options, { connect: async () => socket }));
    if (phase === "open") { await expect(port.openSession(request)).rejects.toBeInstanceOf(Expected); }
    else {
      const session = await port.openSession(request);
      await expect(phase === "finalize" ? session.finalize() : session.sendPacket({
        packetId: "p", opus: new Uint8Array([0xf8, 0xff, 0xfe]), durationSamples48Khz: 960, relativeTimeMs: 0,
      })).rejects.toBeInstanceOf(Expected);
      session.terminate();
    }
  }
});
