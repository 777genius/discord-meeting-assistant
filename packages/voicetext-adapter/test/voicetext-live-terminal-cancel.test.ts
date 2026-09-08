import assert from "node:assert/strict";
import { it } from "vitest";

import { VoicetextAdapterError } from "../src/errors.js";
import type { OssSessionEvidenceEvent } from "../src/oss-native-evidence.js";
import { LiveSession } from "../src/voicetext-live-session.js";
import { validateVoicetextLiveTranscriptionOptions } from "../src/voicetext-live-transcription-configuration.js";
import type { VoicetextInboundFrame, VoicetextWebSocketConnection } from "../src/websocket-connector.js";

const packet = {
  packetId: "packet-1", opus: new Uint8Array([0xf8, 0xff, 0xfe]),
  durationSamples48Khz: 960, relativeTimeMs: 0,
};

class CancellationSocket implements VoicetextWebSocketConnection {
  public ignoreAbort = false;
  public readonly text: string[] = [];
  public binaryCalls = 0;
  public closeCalls = 0;
  public terminateCalls = 0;
  public readonly sendStarted = Promise.withResolvers<void>();
  public readonly sendRelease = Promise.withResolvers<void>();
  private readonly frames: VoicetextInboundFrame[] = [];
  private waiter: ((frame: VoicetextInboundFrame) => void) | undefined;

  public enqueue(message: Readonly<Record<string, unknown>>): void {
    const frame: VoicetextInboundFrame = { type: "text", data: JSON.stringify(message) };
    const waiter = this.waiter;
    if (waiter === undefined) { this.frames.push(frame); return; }
    this.waiter = undefined;
    waiter(frame);
  }

  public async sendText(data: string): Promise<void> {
    this.text.push(data);
    this.enqueue({ type: "ready", provider: "deepgram", model: "nova-3",
      session_id: "00000000-0000-4000-8000-000000000001" });
  }

  public async sendBinary(): Promise<void> {
    this.binaryCalls += 1;
    this.sendStarted.resolve();
    await this.sendRelease.promise;
  }

  public receive(signal: AbortSignal): Promise<VoicetextInboundFrame> {
    signal.throwIfAborted();
    const frame = this.frames.shift();
    if (frame !== undefined) { return Promise.resolve(frame); }
    return new Promise((resolve, reject) => {
      const abort = () => { this.waiter = undefined; reject(signal.reason); };
      if (!this.ignoreAbort) { signal.addEventListener("abort", abort, { once: true }); }
      this.waiter = (received) => {
        signal.removeEventListener("abort", abort);
        resolve(received);
      };
    });
  }

  public async close(): Promise<void> { this.closeCalls += 1; }
  public terminate(): void { this.terminateCalls += 1; }
}

async function open(socket: CancellationSocket, events: OssSessionEvidenceEvent[], signal?: AbortSignal) {
  const session = new LiveSession(socket, {
    idempotencyKey: "terminal-cancel", meetingId: "meeting", speakerId: "speaker",
    onTranscript: () => {}, ...(signal === undefined ? {} : { signal }),
  }, validateVoicetextLiveTranscriptionOptions({
    endpoint: "wss://offline.test", token: "synthetic-machine-token",
    audioAckTimeoutMs: 1000, finalizeTimeoutMs: 1000,
  }), { record: (event) => { events.push(event); } });
  await session.start();
  return session;
}

for (const code of ["PROVIDER_TERMINAL", "PROVIDER_OUTCOME_UNKNOWN", "PROVIDER_UNAVAILABLE"] as const) {
  for (const phase of ["pending-binary", "acknowledged"] as const) {
    for (const cancellation of ["terminate", "abort"] as const) {
      it(`retains ${code} after ${phase} receive races with ${cancellation}`, async () => {
        const socket = new CancellationSocket();
        const events: OssSessionEvidenceEvent[] = [];
        const controller = new AbortController();
        const session = await open(socket, events, controller.signal);
        const sent = session.sendPacket(packet);
        const outcome = sent.catch((error: unknown) => error);
        await socket.sendStarted.promise;
        if (phase === "acknowledged") {
          socket.sendRelease.resolve();
          socket.enqueue({ type: "ack", seq: 1 });
          assert.equal(await sent, "accepted");
          assert.equal(await session.sendPacket(packet), "reused");
        }
        // Fulfill receive, then cancel synchronously BEFORE its continuation parses the wire.
        socket.enqueue({ type: "error", code, message: "synthetic provider failure" });
        if (cancellation === "terminate") { session.terminate(); } else { controller.abort(); }
        assert.equal(events.some((event) => event.type === "received" && event.message.type === "error"), false);
        const immediate = session.finalize().catch((error: unknown) => error);
        const concurrent = session.finalize().catch((error: unknown) => error);
        const failure: unknown = await immediate;
        assert.equal(await concurrent, failure);
        assert.equal(events.some((event) => event.type === "received" && event.message.type === "error"), true);
        socket.sendRelease.resolve();
        socket.enqueue({ type: "ack", seq: 1 }); // Late ACK cannot rescue the cancelled send.
        await assert.rejects(session.finalize(), (error: unknown) => error === failure);
        assert.ok(failure instanceof VoicetextAdapterError);
        assert.equal(failure.code, code === "PROVIDER_TERMINAL" ? "live_provider_terminal" :
          code === "PROVIDER_OUTCOME_UNKNOWN" ? "live_acceptance_unknown" : "provider_error");
        assert.equal(failure.gatewayCode, code);
        assert.equal(failure.retryable, code === "PROVIDER_UNAVAILABLE");
        assert.equal(failure.message, "synthetic provider failure");
        assert.equal(failure.failureClass, undefined); // Only deployed code/message evidence.
        if (phase === "pending-binary") { assert.equal(await outcome, failure); }
        session.terminate();
        await assert.rejects(session.finalize(), (error: unknown) => error === failure);
        await assert.rejects(session.finalize(), (error: unknown) => error === failure);
        await assert.rejects(session.sendPacket(packet), (error: unknown) => error === failure);
        await assert.rejects(session.sendPacket({ ...packet, packetId: "later" }), (error: unknown) => error === failure);
        assert.equal(socket.binaryCalls, 1);
        assert.equal(socket.text.length, 1); // Config only: no reopened provider/finalize/close.
        assert.equal(socket.closeCalls, 0);
        assert.equal(socket.terminateCalls, 1);
        assert.equal(events.filter((event) => event.type === "audio_accepted").length,
          phase === "acknowledged" ? 1 : 0);
        assert.equal(events.some((event) => event.type === "success"), false);
      });
    }
  }
}

it("keeps ordinary idle cancellation successful without inventing provider evidence", async () => {
  const socket = new CancellationSocket();
  const session = await open(socket, []);
  session.terminate();
  await session.finalize();
  await session.finalize();
  assert.equal(socket.terminateCalls, 1);
  assert.equal(socket.binaryCalls, 0);
});

for (const ignoreAbort of [false, true]) {
  for (const phase of ["idle", "acknowledged", "pending-binary"] as const) {
    it(`bounds clean ${phase} cancellation when receive ignores abort: ${ignoreAbort}`, async () => {
      const socket = new CancellationSocket();
      socket.ignoreAbort = ignoreAbort;
      const events: OssSessionEvidenceEvent[] = [];
      const session = await open(socket, events);
      let outcome: Promise<unknown> | undefined;
      if (phase !== "idle") {
        const sent = session.sendPacket(packet);
        outcome = sent.catch((error: unknown) => error);
        await socket.sendStarted.promise;
        if (phase === "acknowledged") {
          socket.sendRelease.resolve();
          socket.enqueue({ type: "ack", seq: 1 });
          assert.equal(await sent, "accepted");
        }
      }
      session.terminate();
      const immediate = session.finalize();
      const repeated = session.finalize();
      // Neither a receive nor a binary send that ignores abort may hold this join.
      await immediate;
      await repeated;
      await session.finalize();
      if (phase === "pending-binary") {
        socket.sendRelease.resolve();
        socket.enqueue({ type: "ack", seq: 1 });
        const failure = await outcome;
        assert.ok(failure instanceof VoicetextAdapterError);
        assert.equal(failure.code, "live_acceptance_unknown");
        assert.equal(failure.gatewayCode, undefined);
        await assert.rejects(session.finalize(), (error: unknown) => error === failure);
      }
      // A transport ignoring abort may resolve later; that is beyond cancellation.
      socket.enqueue({ type: "error", code: "PROVIDER_TERMINAL", message: "too late" });
      if (phase !== "pending-binary") { await session.finalize(); }
      assert.equal(events.some((event) => event.type === "received" && event.message.type === "error"), false);
      assert.equal(events.filter((event) => event.type === "audio_accepted").length,
        phase === "acknowledged" ? 1 : 0);
      assert.equal(socket.binaryCalls, phase === "idle" ? 0 : 1);
      assert.equal(socket.text.length, 1);
      assert.equal(socket.closeCalls, 0);
      assert.equal(socket.terminateCalls, 1);
    });
  }
}
