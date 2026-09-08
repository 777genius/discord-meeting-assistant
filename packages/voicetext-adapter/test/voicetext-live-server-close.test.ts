import { describe, expect, it, vi } from "vitest";
import type { OssSessionEvidenceEvent } from "../src/oss-native-evidence.js";
import { LiveSession } from "../src/voicetext-live-session.js";
import { validateVoicetextLiveTranscriptionOptions } from "../src/voicetext-live-transcription-configuration.js";
import type { VoicetextInboundFrame, VoicetextWebSocketConnection } from "../src/websocket-connector.js";

const terminal = { type: "finalize_complete", status: "flushed", saw_result: true };

// Server events and the finalize send callback are independently controlled.
class ServerCloseSocket implements VoicetextWebSocketConnection {
  public readonly controls: string[] = [];
  public readonly finalizeSent = Promise.withResolvers<void>();
  public readonly sendRelease = Promise.withResolvers<void>();
  public holdFinalizeSend = false;
  public open = true;
  public closeCalls = 0;
  public terminateCalls = 0;
  private readonly frames: VoicetextInboundFrame[] = [];
  private waiter: ((frame: VoicetextInboundFrame) => void) | undefined;

  public async sendText(data: string): Promise<void> {
    const message = JSON.parse(data) as { type: string };
    this.controls.push(message.type);
    if (!this.open) { throw new Error("transport is no longer OPEN"); }
    if (message.type === "config") {
      this.message({ type: "ready", provider: "deepgram", model: "nova-3",
        session_id: "00000000-0000-4000-8000-000000000001" });
    }
    if (message.type === "finalize") {
      this.finalizeSent.resolve();
      if (this.holdFinalizeSend) { await this.sendRelease.promise; }
    }
  }
  public async sendBinary(): Promise<void> { this.message({ type: "ack", seq: 1 }); }
  public async close(): Promise<void> { this.closeCalls += 1; }
  public terminate(): void { this.terminateCalls += 1; }
  public message(message: Readonly<Record<string, unknown>>): void {
    this.push({ type: "text", data: JSON.stringify(message) });
  }
  public serverClose(code = 1000): void {
    this.open = false;
    this.push({ type: "close", code, reason: "synthetic" });
  }
  public receive(signal: AbortSignal): Promise<VoicetextInboundFrame> {
    signal.throwIfAborted();
    const frame = this.frames.shift();
    if (frame !== undefined) { return Promise.resolve(frame); }
    return new Promise((resolve, reject) => {
      const abort = () => { this.waiter = undefined; reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      this.waiter = received => {
        signal.removeEventListener("abort", abort);
        resolve(received);
      };
    });
  }
  private push(frame: VoicetextInboundFrame): void {
    const waiter = this.waiter;
    if (waiter === undefined) { this.frames.push(frame); return; }
    this.waiter = undefined;
    waiter(frame);
  }
}

async function open(socket: ServerCloseSocket, signal?: AbortSignal) {
  const events: OssSessionEvidenceEvent[] = [];
  const terminalObserved = Promise.withResolvers<void>();
  const closeObserved = Promise.withResolvers<void>();
  const session = new LiveSession(socket, {
    meetingId: "synthetic-meeting", speakerId: "synthetic-speaker", idempotencyKey: "synthetic",
    onTranscript: () => {}, ...(signal === undefined ? {} : { signal }),
  }, validateVoicetextLiveTranscriptionOptions({
    endpoint: "wss://offline.test", token: "synthetic-machine-token", finalizeTimeoutMs: 1000,
  }), { record: event => {
    events.push(event);
    if (event.type === "close") { closeObserved.resolve(); }
    if (event.type === "received" && event.message.type === "finalize_complete") { terminalObserved.resolve(); }
  } });
  await session.start();
  return { session, events, terminalObserved, closeObserved };
}

function expectSingleFinalize(socket: ServerCloseSocket): void {
  expect(socket.controls).toEqual(["config", "finalize"]);
  expect(socket.closeCalls).toBe(0);
}

describe("gateway-owned live terminal close", () => {
  it("accepts observed normal server close before the finalize send continuation on non-OPEN transport", async () => {
    const socket = new ServerCloseSocket();
    socket.holdFinalizeSend = true;
    const { session, events, closeObserved } = await open(socket);
    const finalization = session.finalize();
    const outcome = finalization.catch((error: unknown) => error);
    expect(session.finalize()).toBe(finalization);
    await socket.finalizeSent.promise;
    socket.message(terminal);
    socket.serverClose();
    await closeObserved.promise;
    expect(socket.open).toBe(false);
    expect(events.some(event => event.type === "success")).toBe(false);
    socket.sendRelease.resolve();
    expect(await outcome).toBeUndefined();
    await expect(session.finalize()).resolves.toBeUndefined();
    expectSingleFinalize(socket);
    expect(socket.terminateCalls).toBe(0);
    expect(events.filter(event => event.type === "close" || event.type === "success"))
      .toEqual([{ type: "close", code: 1000 }, { type: "success" }]);
  });

  it("keeps flushed finalization pending until delayed normal server close", async () => {
    vi.useFakeTimers();
    try {
      const socket = new ServerCloseSocket();
      const { session, events, terminalObserved } = await open(socket);
      let settled = false;
      const finalization = session.finalize();
      void finalization.then(() => (settled = true), () => (settled = true));
      await socket.finalizeSent.promise;
      socket.message(terminal);
      await terminalObserved.promise;
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      expect(events.some(event => event.type === "success")).toBe(false);
      expectSingleFinalize(socket);
      socket.message({ type: "usage_update", audio_duration_ms: 0 });
      socket.serverClose();
      await expect(finalization).resolves.toBeUndefined();
      expectSingleFinalize(socket);
    } finally { vi.useRealTimers(); }
  });

  it.each([
    "duplicate", "contradictory", "abnormal", "close-before-finalize", "missing-close",
    "cancel", "abort", "PROVIDER_TERMINAL", "PROVIDER_OUTCOME_UNKNOWN", "invalid-status",
    "flushed-without-result", "no-provider-with-result", "no-provider-after-audio",
  ] as const)("rejects %s without retries or post-finalize controls", async behavior => {
    vi.useFakeTimers();
    try {
      const socket = new ServerCloseSocket();
      const controller = new AbortController();
      const { session, events, terminalObserved } = await open(socket, controller.signal);
      if (behavior === "no-provider-after-audio") {
        await session.sendPacket({ packetId: "one", opus: new Uint8Array([1]), relativeTimeMs: 0, durationSamples48Khz: 960 });
      }
      const finalization = session.finalize();
      const outcome = finalization.catch((error: unknown) => error);
      await socket.finalizeSent.promise;
      if (behavior !== "close-before-finalize") {
        socket.message(behavior === "invalid-status" ? { ...terminal, status: "timeout" } :
          behavior === "flushed-without-result" ? { ...terminal, saw_result: false } :
          behavior === "no-provider-with-result" ? { ...terminal, status: "no_provider" } :
          behavior === "no-provider-after-audio" ? { ...terminal, status: "no_provider", saw_result: false } : terminal);
        await terminalObserved.promise;
      }
      if (behavior === "duplicate") { socket.message(terminal); }
      if (behavior === "contradictory") { socket.message({ ...terminal, status: "timeout", saw_result: false }); }
      if (behavior === "PROVIDER_TERMINAL" || behavior === "PROVIDER_OUTCOME_UNKNOWN") {
        socket.message({ type: "error", code: behavior, message: "synthetic" });
      }
      if (behavior === "cancel") { session.terminate(); }
      if (behavior === "abort") { controller.abort(); }
      if (behavior !== "missing-close") { socket.serverClose(behavior === "abnormal" ? 1006 : 1000); }
      await vi.advanceTimersByTimeAsync(1000);
      const failure: unknown = await outcome;
      expect(failure).toBeInstanceOf(Error);
      if (behavior === "missing-close") { expect(failure).toMatchObject({ code: "timeout" }); }
      if (behavior === "cancel" || behavior === "abort") { expect(failure).toMatchObject({ code: "cancelled" }); }
      if (behavior === "PROVIDER_OUTCOME_UNKNOWN") { expect(failure).toMatchObject({ code: "live_acceptance_unknown", retryable: false }); }
      if (behavior === "PROVIDER_TERMINAL") { expect(failure).toMatchObject({ code: "live_provider_terminal", retryable: false }); }
      await expect(session.finalize()).rejects.toBe(failure);
      expect(events.some(event => event.type === "success")).toBe(false);
      expectSingleFinalize(socket);
    } finally { vi.useRealTimers(); }
  });
});
