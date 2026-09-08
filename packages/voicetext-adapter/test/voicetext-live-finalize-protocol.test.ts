import type { OssSessionEvidence, OssSessionEvidenceEvent } from "../src/oss-native-evidence.js";
import { setImmediate as nextTask } from "node:timers/promises";

import { describe, expect, it, vi } from "vitest";

import { VoicetextAdapterError } from "../src/errors.js";
import { validateLiveSessionFinalizeStatus } from
  "../src/voicetext-live-session-primitives.js";
import { LiveSession } from "../src/voicetext-live-session.js";
import { validateVoicetextLiveTranscriptionOptions } from
  "../src/voicetext-live-transcription-configuration.js";
import { parseServerMessage } from "../src/protocol.js";
import type {
  VoicetextInboundFrame,
  VoicetextWebSocketConnection,
} from "../src/websocket-connector.js";

const terminal = {
  saw_result: true,
  status: "flushed",
  type: "finalize_complete",
} as const;

describe("VoiceText live finalize terminal evidence", () => {
  it("captures real parsed receive and send boundaries in order", async () => {
    const events: OssSessionEvidenceEvent[] = [];
    await finalize(new FinalizeSocket("compliant"), 1000, { record: (event) => { events.push(event); } });
    expect(events.map((event) => event.type === "received" ? event.message.type : event.type))
      .toEqual(["ready", "finalize_send", "finalize_sent", "finalize_complete", "close", "success"]);
  });

  it("retains native contradictory finalize and failure evidence", async () => {
    const events: OssSessionEvidenceEvent[] = [];
    await expect(finalize(new FinalizeSocket("synchronous"), 1000,
      { record: (event) => { events.push(event); } })).rejects.toThrow();
    expect(events.filter((event) => event.type === "received" && event.message.type === "finalize_complete"))
      .toHaveLength(2);
    expect(events.some((event) => event.type === "failure")).toBe(true);
    expect(events.some((event) => event.type === "success")).toBe(false);
  });

  it.each(["receive-failure", "synchronous"] as const)(
    "classifies flush then %s without leaking external diagnostics or retrying",
    async (behavior) => {
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        const events: OssSessionEvidenceEvent[] = [];
        const socket = new FinalizeSocket(behavior);
        const session = await openSession(socket, 1000, { record: event => { events.push(event); } });
        const failure: unknown = await session.finalize().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        await expect(session.finalize()).rejects.toBe(failure);
        await expect(session.sendPacket({ packetId: "pending", opus: new Uint8Array([1]),
          durationSamples48Khz: 960, relativeTimeMs: 0 })).rejects.toBe(failure);
        expect(socket.finalizeCalls).toBe(1);
        expect(socket.terminated).toBe(true);
        expect(events.some(event => event.type === "received" && event.message.type === "finalize_complete")).toBe(true);
        expect(events.some(event => event.type === "success")).toBe(false);
        expect(events.filter(event => event.type === "failure").length).toBeGreaterThan(0);
        expect(stderr.mock.calls).toEqual([[JSON.stringify({ event: "voicetext-live-finalization-failed",
          stage: behavior === "receive-failure" ? "receive" : "protocol-boundary",
          code: "terminal-boundary-unproven" }) + "\n"]]);
        expect(JSON.stringify([stderr.mock.calls, events])).not.toContain("synthetic-secret");
      } finally { stderr.mockRestore(); }
    },
  );

  it("preserves saw_result beside every terminal status", () => {
    expect(parseServerMessage(
      '{"type":"finalize_complete","status":"flushed","saw_result":true}',
      100,
    )).toEqual({ sawResult: true, status: "flushed", type: "finalize_complete" });
    expect(parseServerMessage(
      '{"type":"finalize_complete","status":"timeout","saw_result":false}',
      100,
    )).toEqual({ sawResult: false, status: "timeout", type: "finalize_complete" });
  });

  it.each([
    [{ sawResult: false, status: "flushed", type: "finalize_complete" }],
    [{ sawResult: true, status: "no_provider", type: "finalize_complete" }],
  ] as const)("rejects inconsistent terminal evidence %j", (evidence) => {
    expect(() => {
      validateLiveSessionFinalizeStatus(evidence, 0);
    }).toThrow(VoicetextAdapterError);
    try {
      validateLiveSessionFinalizeStatus(evidence, 0);
    } catch (error) {
      expect(error).toMatchObject({ code: "protocol_error", retryable: false });
    }
  });

  it("accepts empty no-provider evidence only when no audio was acknowledged", () => {
    const evidence = {
      sawResult: false,
      status: "no_provider",
      type: "finalize_complete",
    } as const;
    expect(() => {
      validateLiveSessionFinalizeStatus(evidence, 0);
    }).not.toThrow();
    expect(() => {
      validateLiveSessionFinalizeStatus(evidence, 1);
    }).toThrow("Voicetext did not create a provider session for acknowledged audio");
  });

  it("preserves timeout evidence while classifying the terminal as retryable", () => {
    for (const sawResult of [false, true]) {
      try {
        validateLiveSessionFinalizeStatus({
          sawResult,
          status: "timeout",
          type: "finalize_complete",
        }, 1);
        throw new Error("expected timeout rejection");
      } catch (error) {
        expect(error).toMatchObject({ code: "provider_error", retryable: true });
      }
    }
  });

  it("completes only after one terminal and the ordered transport close boundary", async () => {
    const socket = new FinalizeSocket("gated-close");
    const finalization = finalize(socket);
    await socket.closeStarted;
    let settled = false;
    void finalization.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    socket.completeClose();
    await expect(finalization).resolves.toBeUndefined();
    expect(socket.closeCalls).toBe(0);
    expect(socket.terminated).toBe(false);
  });

  it.each(["gated-close", "immediate-server-close"] as const)(
    "requires observed normal closure at %s after valid finalize evidence",
    async (behavior) => {
      for (const closeCode of [1000, 1005, 1006]) {
        const socket = new FinalizeSocket(behavior, closeCode);
        const events: OssSessionEvidenceEvent[] = [];
        const session = await openSession(socket, 1000, { record: (event) => { events.push(event); } });
        const finalization = session.finalize();
        expect(session.finalize()).toBe(finalization);
        const outcome = finalization.catch((error: unknown) => error);
        if (behavior === "gated-close") {
          await socket.closeStarted;
          expect(events.some((event) => event.type === "success")).toBe(false);
          socket.completeClose();
        }
        const failure: unknown = await outcome;
        expect(events.filter((event) => event.type === "received" && event.message.type === "finalize_complete"))
          .toHaveLength(1);
        expect(events.filter((event) => event.type === "close"))
          .toEqual([{ type: "close", code: closeCode }]);
        if (closeCode === 1000) {
          expect(failure).toBeUndefined();
          await expect(session.finalize()).resolves.toBeUndefined();
          expect(events.filter((event) => event.type === "success")).toHaveLength(1);
        } else {
          expect(failure).toMatchObject({
            code: "transport_error", retryable: true,
            message: "Voicetext closed live session with code " + closeCode,
          });
          await expect(session.finalize()).rejects.toBe(failure);
          await expect(session.sendPacket({ packetId: "late", opus: new Uint8Array([1]),
            durationSamples48Khz: 960, relativeTimeMs: 0 })).rejects.toBe(failure);
          expect(events.some((event) => event.type === "success")).toBe(false);
          expect(events.some((event) => event.type === "failure")).toBe(true);
        }
        expect(socket.finalizeCalls).toBe(1);
        expect(socket.closeCalls).toBe(0);
        expect(socket.terminated).toBe(false);
      }
    },
  );

  it.each([1005, 1006])("keeps timeout termination without peer closure unsuccessful (%s)", async (closeCode) => {
    vi.useFakeTimers();
    try {
      const events: OssSessionEvidenceEvent[] = [];
      const socket = new FinalizeSocket("never-close", closeCode);
      const session = await openSession(socket, 1000, { record: (event) => { events.push(event); } });
      const outcome = session.finalize().catch((error: unknown) => error);
      await socket.closeStarted;
      await vi.advanceTimersByTimeAsync(1000);
      const failure: unknown = await outcome;
      expect(failure).toMatchObject({ code: "timeout", retryable: true });
      await expect(session.finalize()).rejects.toBe(failure);
      expect(socket.terminated).toBe(true);
      expect(socket.finalizeCalls).toBe(1);
      expect(socket.closeCalls).toBe(0);
      expect(events.some((event) => event.type === "close")).toBe(false);
      expect(events.some((event) => event.type === "success")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["synchronous", "later-task", "duplicate-before-close", "contradictory-before-close"] as const)(
    "fails closed for %s terminal evidence",
    async (behavior) => {
      const socket = new FinalizeSocket(behavior);
      await expect(finalize(socket)).rejects.toThrow(
        "duplicate live finalize terminal evidence",
      );
      expect(socket.terminated).toBe(true);
    },
  );

  it("fails closed when transport closure races ahead of terminal evidence", async () => {
    const socket = new FinalizeSocket("close-before-terminal");
    await expect(finalize(socket)).rejects.toThrow(
      "Voicetext closed live session with code 1000",
    );
    expect(socket.terminated).toBe(false);
  });

  it("bounds a terminal without a close boundary by the configured finalize timeout", async () => {
    const socket = new FinalizeSocket("never-close");
    await expect(finalize(socket, 100)).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
    });
    expect(socket.terminated).toBe(true);
  });
});

type FinalizeBehavior =
  | "receive-failure"
  | "PROVIDER_TERMINAL"
  | "PROVIDER_OUTCOME_UNKNOWN"
  | "immediate-server-close"
  | "duplicate-before-close"
  | "close-before-terminal"
  | "compliant"
  | "contradictory-before-close"
  | "gated-close"
  | "later-task"
  | "never-close"
  | "synchronous";

class FinalizeSocket implements VoicetextWebSocketConnection {
  public closeCalls = 0;
  public finalizeCalls = 0;
  public readonly closeStarted: Promise<void>;
  public terminated = false;
  private readonly closeRelease: Promise<void>;
  private releaseClose!: () => void;
  private resolveCloseStarted!: () => void;
  private readonly frames: VoicetextInboundFrame[] = [];
  private waiter: ((frame: VoicetextInboundFrame) => void) | undefined;

  public constructor(private readonly behavior: FinalizeBehavior, private readonly closeCode = 1000) {
    this.closeStarted = new Promise((resolve) => {
      this.resolveCloseStarted = resolve;
    });
    this.closeRelease = new Promise((resolve) => {
      this.releaseClose = resolve;
    });
  }

  public completeClose(): void {
    this.releaseClose();
  }

  public async sendText(data: string): Promise<void> {
    const message = JSON.parse(data) as { readonly type?: unknown };
    if (message.type === "config") {
      this.enqueue({
        model: "nova-3",
        provider: "deepgram",
        session_id: "00000000-0000-4000-8000-000000000001",
        type: "ready",
      });
      return;
    }
    if (message.type === "finalize") {
      this.finalizeCalls += 1;
      if (this.behavior === "PROVIDER_TERMINAL" || this.behavior === "PROVIDER_OUTCOME_UNKNOWN") { this.enqueue({ type: "error", code: this.behavior, message: "synthetic" }); return; }
      if (this.behavior === "close-before-terminal") {
        this.enqueueClose();
        return;
      }
      this.enqueue(terminal);
      if (this.behavior === "synchronous") {
        this.enqueue(terminal);
      } else if (this.behavior === "later-task") {
        void (async () => {
          await nextTask();
          this.enqueue(terminal);
        })();
      }
      if (["duplicate-before-close", "contradictory-before-close"].includes(this.behavior)) {
        this.enqueue(this.behavior === "contradictory-before-close"
          ? { saw_result: false, status: "timeout", type: "finalize_complete" } : terminal);
      }
      this.resolveCloseStarted();
      if (this.behavior === "immediate-server-close") { this.enqueueClose(); }
      else if (this.behavior !== "never-close") {
        void (async () => {
          if (this.behavior === "gated-close") { await this.closeRelease; }
          else { await nextTask(); }
          this.enqueueClose();
        })();
      }
      return;
    }
  }

  public async sendBinary(): Promise<void> {}

  public receive(signal: AbortSignal): Promise<VoicetextInboundFrame> {
    signal.throwIfAborted();
    if (this.behavior === "receive-failure" && this.finalizeCalls > 0 && this.frames.length === 0) {
      return Promise.reject(new Error("Bearer synthetic-secret"));
    }
    const frame = this.frames.shift();
    if (frame !== undefined) {
      return Promise.resolve(frame);
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      this.waiter = (next) => {
        signal.removeEventListener("abort", abort);
        resolve(next);
      };
    });
  }

  public async close(): Promise<void> {
    this.closeCalls += 1;
  }

  public terminate(): void {
    this.terminated = true;
  }

  public enqueue(message: Readonly<Record<string, unknown>>): void {
    this.push({ data: JSON.stringify(message), type: "text" });
  }

  private enqueueClose(): void {
    this.push({ code: this.closeCode, reason: "finalized", type: "close" });
  }

  private push(frame: VoicetextInboundFrame): void {
    if (this.waiter === undefined) {
      this.frames.push(frame);
      return;
    }
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter(frame);
  }
}

async function finalize(socket: FinalizeSocket, timeoutMs = 1_000, evidence?: OssSessionEvidence): Promise<void> {
  const session = await openSession(socket, timeoutMs, evidence);
  await session.finalize();
}

async function openSession(socket: FinalizeSocket, timeoutMs = 1000, evidence?: OssSessionEvidence): Promise<LiveSession> {
  const session = new LiveSession(socket, {
    idempotencyKey: "terminal-evidence",
    meetingId: "meeting-1",
    onTranscript: () => {},
    speakerId: "speaker-1",
  }, validateVoicetextLiveTranscriptionOptions({
    endpoint: "wss://voice.example.test/api/v1/transcribe/stream",
    finalizeTimeoutMs: timeoutMs,
    token: "test-machine-token",
  }), evidence);
  await session.start();
  return session;
}

it.each(["idle", "finalizing"].flatMap(phase => (["PROVIDER_TERMINAL", "PROVIDER_OUTCOME_UNKNOWN"] as const).map(code => ({ phase, code }))))("retains deployed failure through %j cleanup and repeated finalization", async ({ phase, code }) => {
  const socket = new FinalizeSocket(code);
  const session = new LiveSession(socket, {
    idempotencyKey: "quota", meetingId: "meeting", speakerId: "speaker", onTranscript: () => {},
  }, validateVoicetextLiveTranscriptionOptions({ endpoint: "wss://voice.example.test/api/v1/transcribe/stream", token: "test-machine-token", finalizeTimeoutMs: 1000 }));
  await session.start();
  if (phase === "idle") {
    socket.enqueue({ type: "error", code, message: "synthetic" });
    await nextTask();
  }
  const failure: unknown = await session.finalize().catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: code === "PROVIDER_TERMINAL" ? "live_provider_terminal" : "live_acceptance_unknown", gatewayCode: code, retryable: false });
  session.terminate();
  await expect(session.finalize()).rejects.toBe(failure);
  await expect(session.sendPacket({ packetId: "later", opus: new Uint8Array([1]), durationSamples48Khz: 960, relativeTimeMs: 0 })).rejects.toBe(failure);
  expect(socket.terminated).toBe(true);
});
