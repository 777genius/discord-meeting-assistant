import { parseServerMessage } from "../src/protocol.js";
import { createHash } from "node:crypto";
import type { OssSessionEvidenceEvent } from "../src/oss-native-evidence.js";
import { describe, expect, it, vi } from "vitest";

import {
  VoicetextLiveTranscriptionAdapter,
  type VoicetextInboundFrame,
  type VoicetextLiveTranscriptEvent,
  type VoicetextLiveProfile,
  type VoicetextWebSocketConnection,
  type VoicetextWebSocketConnector,
  type VoicetextWebSocketConnectRequest,
} from "../src/index.js";
import { validateVoicetextLiveTranscriptionOptions } from "../src/voicetext-live-transcription-configuration.js";

class QueueSocket implements VoicetextWebSocketConnection {
  public readonly binary: Uint8Array[] = [];
  public readonly text: Array<Readonly<Record<string, unknown>>> = [];
  public closed = false;
  public closeError: Error | undefined;
  public finalizeStatus: "flushed" | "no_provider" | "timeout" = "flushed";
  public terminated = false;
  private readonly frames: VoicetextInboundFrame[] = [];
  private waiter: ((frame: VoicetextInboundFrame) => void) | undefined;

  public enqueue(message: Readonly<Record<string, unknown>>): void {
    this.enqueueFrame({ data: JSON.stringify(message), type: "text" });
  }

  public enqueueFrame(frame: VoicetextInboundFrame): void {
    const waiter = this.waiter;
    if (waiter === undefined) {
      this.frames.push(frame);
    } else {
      this.waiter = undefined;
      waiter(frame);
    }
  }

  public async sendText(data: string): Promise<void> {
    const message = JSON.parse(data) as Readonly<Record<string, unknown>>;
    this.text.push(message);
    if (message.type === "config") {
      this.enqueue({
        model: message.model,
        provider: message.provider,
        session_id: "00000000-0000-4000-8000-000000000001",
        type: "ready",
      });
    } else if (message.type === "finalize") {
      this.enqueue({
        saw_result: this.finalizeStatus === "flushed",
        status: this.finalizeStatus,
        type: "finalize_complete",
      });
      this.closed = true;
      this.enqueueFrame({ type: "close", code: 1000, reason: "finalized" });
    }
  }

  public async sendBinary(data: Uint8Array): Promise<void> {
    this.binary.push(Uint8Array.from(data));
    if (this.binary.length === 1) {
      this.enqueue({
        confidence: 0.8,
        duration_ms: 700,
        start_ms: 100,
        text: " готовим ",
        type: "partial",
      });
      this.enqueue({
        confidence: 0.95,
        duration_ms: 1_000,
        start_ms: 100,
        text: "готовим релиз",
        type: "final",
      });
      this.enqueue({
        confidence: 0.95,
        duration_ms: 1_000,
        is_segment_final: true,
        start_ms: 100,
        text: "готовим релиз",
        type: "partial",
      });
    }
    this.enqueue({ seq: this.binary.length, type: "ack" });
  }

  public async receive(signal: AbortSignal): Promise<VoicetextInboundFrame> {
    signal.throwIfAborted();
    const frame = this.frames.shift();
    if (frame !== undefined) {
      return frame;
    }
    return await new Promise((resolve, reject) => {
      const onAbort = () => {
        this.waiter = undefined;
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiter = (queued) => {
        signal.removeEventListener("abort", onAbort);
        resolve(queued);
      };
    });
  }

  public close(code: number, reason: string): Promise<void> {
    this.closed = true;
    this.enqueueFrame({ code, reason, type: "close" });
    return this.closeError === undefined
      ? Promise.resolve()
      : Promise.reject(this.closeError);
  }

  public terminate(): void {
    this.terminated = true;
  }
}

class SingleSocketConnector implements VoicetextWebSocketConnector {
  public readonly requests: VoicetextWebSocketConnectRequest[] = [];

  public constructor(public readonly socket: QueueSocket) { }

  public connect(
    request: VoicetextWebSocketConnectRequest,
  ): Promise<VoicetextWebSocketConnection> {
    this.requests.push(request);
    return Promise.resolve(this.socket);
  }
}

class DelayedAckSocket extends QueueSocket {
  public override async sendBinary(data: Uint8Array): Promise<void> {
    this.binary.push(Uint8Array.from(data));
  }

  public acknowledge(sequence: number): void {
    this.enqueue({ seq: sequence, type: "ack" });
  }
}

class TimelineGapSocket extends QueueSocket {
  public override async sendBinary(data: Uint8Array): Promise<void> {
    this.binary.push(Uint8Array.from(data));
    if (this.binary.length === 2) {
      this.enqueue({
        confidence: 0.99,
        duration_ms: 20,
        start_ms: 0,
        text: "до паузы",
        type: "final",
      });
      this.enqueue({
        confidence: 0.99,
        duration_ms: 20,
        start_ms: 20,
        text: "после паузы",
        type: "final",
      });
    }
    this.enqueue({ seq: this.binary.length, type: "ack" });
  }
}

class FractionalTimelineSocket extends QueueSocket {
  public override async sendBinary(data: Uint8Array): Promise<void> {
    this.binary.push(Uint8Array.from(data));
    if (this.binary.length === 2) {
      this.enqueue({
        duration_ms: 1,
        start_ms: 3,
        text: "дробная граница",
        type: "final",
      });
    }
    this.enqueue({ seq: this.binary.length, type: "ack" });
  }
}

class DeferredSendSocket extends QueueSocket {
  private releaseSend: (() => void) | undefined;

  public override async sendBinary(data: Uint8Array): Promise<void> {
    this.binary.push(Uint8Array.from(data));
    await new Promise<void>((resolve) => {
      this.releaseSend = resolve;
    });
    this.enqueue({ seq: this.binary.length, type: "ack" });
  }

  public release(): void {
    this.releaseSend?.();
  }
}

class NoFinalizeResponseSocket extends QueueSocket {
  public override async sendText(data: string): Promise<void> {
    const message = JSON.parse(data) as Readonly<Record<string, unknown>>;
    if (message.type === "finalize") {
      this.text.push(message);
      return;
    }
    await super.sendText(data);
  }
}

function adapter(
  socket: QueueSocket,
  profile: VoicetextLiveProfile = "deepgram-nova-3",
): VoicetextLiveTranscriptionAdapter {
  return new VoicetextLiveTranscriptionAdapter(
    {
      audioAckTimeoutMs: 1_000,
      endpoint: "wss://voicetext.test/api/v1/transcribe/stream",
      finalizeTimeoutMs: 1_000,
      keyterms: ["Craig", "Craig", "Discord"],
      profile,
      readyTimeoutMs: 1_000,
      token: "service-token-that-is-long-enough",
    },
    new SingleSocketConnector(socket),
  );
}

function liveRequest(idempotencyKey: string) {
  return { idempotencyKey, meetingId: "meeting-1", speakerId: "speaker-a", onTranscript: () => {} };
}

describe("VoicetextLiveTranscriptionAdapter", () => {
  it("fails closed for an unsupported runtime live profile", () => {
    expect(() => validateVoicetextLiveTranscriptionOptions({
      endpoint: "wss://api.voicetext.test/api/v1/transcribe/stream",
      profile: "elevenlabs-scribe-v2-realtime-typo" as VoicetextLiveProfile,
      token: "x".repeat(16),
    })).toThrow("Live configuration rejected before connection");
  });

  it.each([
    ["deepgram-nova-3", "deepgram", "nova-3"],
    ["elevenlabs-scribe-v2-realtime", "elevenlabs", "scribe_v2_realtime"],
  ] as const)("requires the exact ready identity for %s before raw Opus audio", async (profile, provider, model) => {
    const socket = new QueueSocket();
    const session = await adapter(socket, profile).openSession(liveRequest("live-session-profile"));

    expect(socket.text[0]).toMatchObject({
      encoding: "opus",
      model,
      protocol_v: 2,
      provider,
      sample_rate: 48_000,
    });
    expect(socket.binary).toEqual([]);
    session.terminate();
  });

  it.each([
    ["absent", {}],
    ["provider mismatch", { model: "nova-3", provider: "elevenlabs" }],
    ["model mismatch", { model: "scribe_v2_realtime", provider: "deepgram" }],
  ])("fails closed for %s ready identity and sends no audio", async (_label, readyIdentity) => {
    class InvalidReadySocket extends QueueSocket {
      public override async sendText(data: string): Promise<void> {
        const message = JSON.parse(data) as Readonly<Record<string, unknown>>;
        this.text.push(message);
        if (message.type === "config") {
          this.enqueue({
            ...readyIdentity,
            session_id: "00000000-0000-4000-8000-000000000001",
            type: "ready",
          });
        }
      }
    }
    const socket = new InvalidReadySocket();

    await expect(adapter(socket).openSession(liveRequest("live-session-invalid-ready"))).rejects.toMatchObject({ code: "protocol_error", retryable: false });
    expect(socket.binary).toEqual([]);
  });

  it("streams raw Opus, emits bounded per-speaker partial/final events, and deduplicates", async () => {
    const socket = new QueueSocket();
    const events: VoicetextLiveTranscriptEvent[] = [];
    const session = await adapter(socket).openSession({
      idempotencyKey: "live-session-1",
      meetingId: "meeting-1",
      onTranscript: (event) => events.push(event),
      speakerId: "speaker-a",
    });

    expect(socket.text[0]).toMatchObject({
      capabilities: ["finalize_ack"],
      channels: 1,
      encoding: "opus",
      keyterms: ["Craig", "Discord"],
      language: "ru",
      model: "nova-3",
      protocol_v: 2,
      provider: "deepgram",
      sample_rate: 48_000,
      type: "config",
    });
    expect(await session.sendPacket({
      durationSamples48Khz: 960,
      opus: Uint8Array.from([0xf8, 0xff, 0xfe]),
      packetId: "packet-1",
      relativeTimeMs: 10_000,
    })).toBe("accepted");
    expect(await session.sendPacket({
      durationSamples48Khz: 960,
      opus: Uint8Array.from([0xf8, 0xff, 0xfe]),
      packetId: "packet-1",
      relativeTimeMs: 10_000,
    })).toBe("reused");
    expect(socket.binary).toHaveLength(1);
    expect(events).toEqual([
      {
        confidence: 0.8,
        endMs: 10_800,
        isFinal: false,
        meetingId: "meeting-1",
        speakerId: "speaker-a",
        startMs: 10_100,
        text: "готовим",
      },
      {
        confidence: 0.95,
        endMs: 11_100,
        isFinal: true,
        meetingId: "meeting-1",
        speakerId: "speaker-a",
        startMs: 10_100,
        text: "готовим релиз",
      },
    ]);

    await session.finalize();
    expect(socket.text.at(-1)).toEqual({ type: "finalize" });
    expect(socket.text.filter(({ type }) => type === "close")).toHaveLength(0);
    expect(socket.closed).toBe(true);
    expect(socket.terminated).toBe(false);
  });

  it("rejects oversized packets before touching the transport", async () => {
    const socket = new QueueSocket();
    const session = await adapter(socket).openSession(liveRequest("live-session-1"));

    await expect(session.sendPacket({
      durationSamples48Khz: 960,
      opus: new Uint8Array(65_537),
      packetId: "packet-too-large",
      relativeTimeMs: 0,
    })).rejects.toThrow("Live Opus packet is invalid");
    expect(socket.binary).toEqual([]);
    session.terminate();
    expect(socket.terminated).toBe(true);
  });

  it("treats no_provider finalize as an empty success and gracefully closes the session", async () => {
    const socket = new QueueSocket();
    socket.finalizeStatus = "no_provider";
    const session = await adapter(socket).openSession(liveRequest("live-session-no-provider"));

    await expect(session.finalize()).resolves.toBeUndefined();
    expect(socket.text.at(-1)).toEqual({ type: "finalize" });
    expect(socket.text.filter(({ type }) => type === "close")).toHaveLength(0);
    expect(socket.closed).toBe(true);
    expect(socket.terminated).toBe(false);
  });

  it("rejects no_provider after acknowledged audio and still gracefully closes", async () => {
    const socket = new QueueSocket();
    socket.finalizeStatus = "no_provider";
    const session = await adapter(socket).openSession(liveRequest("live-session-no-provider-after-audio"));
    await session.sendPacket({
      durationSamples48Khz: 960,
      opus: Uint8Array.from([0xf8, 0xff, 0xfe]),
      packetId: "packet-1",
      relativeTimeMs: 0,
    });

    await expect(session.finalize()).rejects.toThrow(
      "Voicetext did not create a provider session for acknowledged audio",
    );
    expect(socket.text.at(-1)).toEqual({ type: "finalize" });
    expect(socket.text.filter(({ type }) => type === "close")).toHaveLength(0);
    expect(socket.closed).toBe(true);
    expect(socket.terminated).toBe(false);
  });

  it("gracefully closes after a provider finalize timeout before surfacing the error", async () => {
    const socket = new QueueSocket();
    socket.finalizeStatus = "timeout";
    const session = await adapter(socket).openSession(liveRequest("live-session-timeout"));

    await expect(session.finalize()).rejects.toThrow("Voicetext live finalize completed with timeout");
    expect(socket.text.at(-1)).toEqual({ type: "finalize" });
    expect(socket.text.filter(({ type }) => type === "close")).toHaveLength(0);
    expect(socket.closed).toBe(true);
    expect(socket.terminated).toBe(false);
  });

});

describe("VoicetextLiveTranscriptionAdapter ACK pacing", () => {

  it("allows only one unacknowledged packet and finalizes after the last ACK", async () => {
    const socket = new DelayedAckSocket();
    const session = await adapter(socket).openSession(liveRequest("live-session-ack-paced"));

    const first = session.sendPacket({
      durationSamples48Khz: 960,
      opus: Uint8Array.from([0xf8, 0xff, 0xfe]),
      packetId: "packet-1",
      relativeTimeMs: 20,
    });
    await Promise.resolve();
    expect(socket.binary).toHaveLength(1);
    socket.acknowledge(1);
    await expect(first).resolves.toBe("accepted");

    const second = session.sendPacket({
      durationSamples48Khz: 960,
      opus: Uint8Array.from([0xf8, 0xff, 0xfe]),
      packetId: "packet-2",
      relativeTimeMs: 40,
    });
    await Promise.resolve();
    expect(socket.binary).toHaveLength(2);
    socket.acknowledge(2);
    await expect(second).resolves.toBe("accepted");
    expect(socket.binary).toHaveLength(2);

    const finalization = session.finalize();
    await finalization;
    expect(socket.text.some(({ type }) => type === "finalize")).toBe(true);
    expect(socket.text.at(-1)).toEqual({ type: "finalize" });
  });

  it("fails the session boundedly when ACK pacing times out", async () => {
    vi.useFakeTimers();
    try {
      const socket = new DelayedAckSocket();
      const session = await adapter(socket).openSession(liveRequest("live-session-ack-timeout"));
      const first = session.sendPacket({
        durationSamples48Khz: 960,
        opus: Uint8Array.from([0xf8, 0xff, 0xfe]),
        packetId: "packet-1",
        relativeTimeMs: 0,
      });

      const rejected = expect(first).rejects.toThrow(
        "Voicetext live packet acknowledgement timed out",
      );
      await vi.advanceTimersByTimeAsync(1_001);

      await rejected;
      expect(socket.binary).toHaveLength(1);
      expect(socket.terminated).toBe(true);
      await expect(session.finalize()).rejects.toThrow(
        "Voicetext live packet acknowledgement timed out",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["duplicate", [{ seq: 1, type: "ack" }, { seq: 1, type: "ack" }]],
    ["invalid", [{ seq: 0, type: "ack" }]],
  ] as const)("fails closed on a %s ACK", async (_label, acknowledgements) => {
    const socket = new DelayedAckSocket();
    const session = await adapter(socket).openSession(liveRequest(`live-session-${_label}-ack`));
    const packet = session.sendPacket({
      durationSamples48Khz: 960,
      opus: Uint8Array.from([0xf8, 0xff, 0xfe]),
      packetId: "packet-1",
      relativeTimeMs: 0,
    });

    for (const acknowledgement of acknowledgements) {
      socket.enqueue(acknowledgement);
    }
    await packet.catch(() => { });
    await vi.waitFor(() => {
      expect(socket.terminated).toBe(true);
    });
    await expect(session.finalize()).rejects.toMatchObject({
      code: _label === "invalid" ? "live_acceptance_unknown" : "protocol_error",
      retryable: false,
    });
  });

});

describe("VoicetextLiveTranscriptionAdapter finalization", () => {
  it("shares one finalization across concurrent callers", async () => {
    const socket = new DelayedAckSocket();
    const session = await adapter(socket).openSession(liveRequest("live-session-single-finalize"));
    const packet = session.sendPacket({
      durationSamples48Khz: 960,
      opus: Uint8Array.from([0xf8, 0xff, 0xfe]),
      packetId: "packet-1",
      relativeTimeMs: 0,
    });

    socket.acknowledge(1);
    await expect(packet).resolves.toBe("accepted");
    const first = session.finalize();
    const second = session.finalize();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(session.finalize()).toBe(first);
    expect(socket.text.filter(({ type }) => type === "finalize")).toHaveLength(1);
    expect(socket.text.filter(({ type }) => type === "close")).toHaveLength(0);
  });

  it("surfaces a transport failure that rejected an outstanding ACK before finalize", async () => {
    const socket = new DelayedAckSocket();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const session = await adapter(socket).openSession(liveRequest("live-session-disconnect-before-finalize"));
    const packet = session.sendPacket({
      durationSamples48Khz: 960,
      opus: Uint8Array.from([0xf8, 0xff, 0xfe]),
      packetId: "packet-1",
      relativeTimeMs: 0,
    });
    const packetFailure = expect(packet).rejects.toThrow(
      "Voicetext closed live session with code 1011",
    );
    socket.enqueueFrame({ code: 1_011, reason: "provider unavailable", type: "close" });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    try {
      expect(unhandled).toEqual([]);
      await packetFailure;
      await expect(session.finalize()).rejects.toThrow(
        "Voicetext closed live session with code 1011",
      );
      expect(socket.terminated).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("accepts server closure without invoking local socket close", async () => {
    const socket = new QueueSocket();
    socket.closeError = new Error("close failed");
    const session = await adapter(socket).openSession(liveRequest("live-session-close-failure"));

    const close = vi.spyOn(socket, "close");
    await expect(session.finalize()).resolves.toBeUndefined();
    expect(close).not.toHaveBeenCalled();
    expect(socket.terminated).toBe(false);
  });

  it("maps a provider-contiguous packet across a source timeline gap", async () => {
    const socket = new TimelineGapSocket();
    const events: VoicetextLiveTranscriptEvent[] = [];
    const session = await adapter(socket).openSession({
      idempotencyKey: "live-session-timeline-gap",
      meetingId: "meeting-1",
      onTranscript: (event) => events.push(event),
      speakerId: "speaker-a",
    });
    const packet = session.sendPacket({
      durationSamples48Khz: 960,
      opus: Uint8Array.from([0xf8, 0xff, 0xfe]),
      packetId: "packet-1",
      relativeTimeMs: 350_000,
    });
    await packet;
    await session.sendPacket({
      durationSamples48Khz: 960,
      opus: Uint8Array.from([0xf8, 0xff, 0xfe]),
      packetId: "packet-2",
      relativeTimeMs: 352_000,
    });
    await Promise.resolve();

    expect(events).toContainEqual({
      confidence: 0.99,
      endMs: 350_020,
      isFinal: true,
      meetingId: "meeting-1",
      speakerId: "speaker-a",
      startMs: 350_000,
      text: "до паузы",
    });
    expect(events).toContainEqual({
      confidence: 0.99,
      endMs: 352_020,
      isFinal: true,
      meetingId: "meeting-1",
      speakerId: "speaker-a",
      startMs: 352_000,
      text: "после паузы",
    });
    await session.finalize();
  });

});

describe("VoicetextLiveTranscriptionAdapter timeline and termination", () => {
  it("rounds a valid 2.5ms Opus timeline to integer source timestamps", async () => {
    const socket = new FractionalTimelineSocket();
    const events: VoicetextLiveTranscriptEvent[] = [];
    const session = await adapter(socket).openSession({
      idempotencyKey: "live-session-fractional-timeline",
      meetingId: "meeting-1",
      onTranscript: (event) => events.push(event),
      speakerId: "speaker-a",
    });
    await session.sendPacket({
      durationSamples48Khz: 120,
      opus: Uint8Array.from([0x80]),
      packetId: "packet-1",
      relativeTimeMs: 1_000,
    });
    await session.sendPacket({
      durationSamples48Khz: 120,
      opus: Uint8Array.from([0x80]),
      packetId: "packet-2",
      relativeTimeMs: 1_004,
    });
    await Promise.resolve();

    expect(events).toContainEqual({
      endMs: 1_006,
      isFinal: true,
      meetingId: "meeting-1",
      speakerId: "speaker-a",
      startMs: 1_005,
      text: "дробная граница",
    });
    expect(events.every(({ endMs, startMs }) =>
      Number.isSafeInteger(startMs) && Number.isSafeInteger(endMs)
    )).toBe(true);
    await session.finalize();
  });

  it("rejects a concurrent packet send before sequence reservation", async () => {
    const socket = new DeferredSendSocket();
    const session = await adapter(socket).openSession(liveRequest("live-session-concurrent-send"));
    const first = session.sendPacket({
      durationSamples48Khz: 960,
      opus: Uint8Array.from([0xf8, 0xff, 0xfe]),
      packetId: "packet-1",
      relativeTimeMs: 0,
    });
    await Promise.resolve();

    await expect(session.sendPacket({
      durationSamples48Khz: 960,
      opus: Uint8Array.from([0xf8, 0xff, 0xfe]),
      packetId: "packet-2",
      relativeTimeMs: 20,
    })).rejects.toThrow("Concurrent live packet sends are not supported");
    expect(socket.binary).toHaveLength(1);
    socket.release();
    await first;
    await session.finalize();
  });

  it("force-terminates after a client-side finalize timeout without more controls", async () => {
    vi.useFakeTimers();
    try {
      const socket = new NoFinalizeResponseSocket();
      const close = vi.spyOn(socket, "close");
      const terminate = vi.spyOn(socket, "terminate");
      const session = await adapter(socket).openSession(liveRequest("live-session-local-timeout"));
      const finalization = session.finalize();
      expect(session.finalize()).toBe(finalization);
      const rejected = expect(finalization).rejects.toThrow(
        "Voicetext live finalize timed out",
      );
      await vi.advanceTimersByTimeAsync(1_001);

      await rejected;
      expect(socket.text.filter(({ type }) => type === "close")).toHaveLength(0);
      expect(socket.closed).toBe(false);
      expect(socket.terminated).toBe(true);
      const failure: unknown = await finalization.catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "timeout", retryable: true });
      await expect(session.finalize()).rejects.toBe(failure);
      session.terminate();
      await expect(session.finalize()).rejects.toBe(failure);
      expect(close).not.toHaveBeenCalled();
      expect(terminate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a client-side finalize timeout without invoking failing socket close", async () => {
    vi.useFakeTimers();
    try {
      const socket = new NoFinalizeResponseSocket();
      socket.closeError = new Error("close failed");
      const close = vi.spyOn(socket, "close");
      const terminate = vi.spyOn(socket, "terminate");
      const session = await adapter(socket).openSession(liveRequest("live-session-local-timeout-close-failure"));
      const finalization = session.finalize();
      const rejected = expect(finalization).rejects.toThrow(
        "Voicetext live finalize timed out",
      );
      await vi.advanceTimersByTimeAsync(1_001);

      await rejected;
      expect(socket.terminated).toBe(true);
      const failure: unknown = await finalization.catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "timeout", retryable: true });
      await expect(session.finalize()).rejects.toBe(failure);
      session.terminate();
      await expect(session.finalize()).rejects.toBe(failure);
      expect(socket.text.filter(({ type }) => type === "close")).toHaveLength(0);
      expect(close).not.toHaveBeenCalled();
      expect(terminate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels one in-flight finalization and force-closes transport on terminate", async () => {
    const socket = new DelayedAckSocket();
    const session = await adapter(socket).openSession(liveRequest("live-session-terminate-finalize-race"));
    const packet = session.sendPacket({
      durationSamples48Khz: 960,
      opus: Uint8Array.from([0xf8, 0xff, 0xfe]),
      packetId: "packet-1",
      relativeTimeMs: 0,
    });
    socket.acknowledge(1);
    await expect(packet).resolves.toBe("accepted");
    const finalization = session.finalize();

    session.terminate();

    await expect(finalization).rejects.toThrow("cancelled");
    expect(socket.terminated).toBe(true);
    expect(socket.text.filter(({ type }) => type === "finalize")).toHaveLength(0);
  });
});

it("captures actual packet hashes, accepted order and every normalized server result", async () => {
  const events: OssSessionEvidenceEvent[] = [];
  const socket = new QueueSocket();
  const capturingAdapter = new VoicetextLiveTranscriptionAdapter({
    endpoint: "wss://offline.test", token: "offline-machine-token",
    evidenceSink: { open: () => ({ record: (event) => { events.push(event); } }) },
  }, new SingleSocketConnector(socket));
  const session = await capturingAdapter.openSession({
    meetingId: "meeting-1", speakerId: "speaker-1",
    idempotencyKey: "session-1", onTranscript: () => { }
  });
  const opus = Uint8Array.from([0xf8, 0xff, 0xfe]);
  await session.sendPacket({ opus, packetId: "packet-1", relativeTimeMs: 0, durationSamples48Khz: 960 });
  await session.sendPacket({ opus, packetId: "packet-1", relativeTimeMs: 0, durationSamples48Khz: 960 });
  await session.finalize();
  expect(events.filter((event) => event.type === "audio_send")).toEqual([{
    type: "audio_send", seq: 1, packetId: "packet-1", size: 3, toc: 0xf8,
    sha256: createHash("sha256").update(opus).digest("hex"), relativeTimeMs: 0, durationSamples48Khz: 960,
  }]);
  expect(events.filter((event) => event.type === "received").map((event) => event.message.type))
    .toEqual(["ready", "partial", "final", "segment_final", "ack", "finalize_complete"]);
  expect(events.filter((event) => event.type === "audio_accepted")).toEqual([{ type: "audio_accepted", seq: 1 }]);
  expect(events.at(-1)).toEqual({ type: "success" });
  expect(JSON.stringify(events)).not.toContain("offline-machine-token");
});

for (const code of ["INVALID_CONFIG", "PROVIDER_UNAVAILABLE", "OTHER"]) {
  it(`classifies only proven opening rejection: ${code}`, async () => {
    const socket = new QueueSocket();
    socket.sendText = async () => { socket.enqueue({ type: "error", code, message: "synthetic" }); };
    const connect = vi.fn(async () => socket);
    const admissionAdapter = new VoicetextLiveTranscriptionAdapter({ endpoint: "ws://localhost", token: "synthetic-token-123456" }, { connect });
    await expect(admissionAdapter.openSession({ meetingId: "m", speakerId: "s", idempotencyKey: "k", onTranscript: () => {} }))
      .rejects.toMatchObject({ code: code === "INVALID_CONFIG" ? "live_admission_rejected" : "provider_error",
        retryable: code !== "INVALID_CONFIG" });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(socket.binary).toEqual([]);
    expect(socket.terminated).toBe(true);
  });
}

it("does not classify INVALID_CONFIG after ready as permanent admission", async () => {
  const socket = new QueueSocket();
  socket.sendBinary = async () => { socket.enqueue({ type: "error", code: "INVALID_CONFIG", message: "synthetic uncertain failure" }); };
  const admissionAdapter = new VoicetextLiveTranscriptionAdapter({ endpoint: "ws://localhost", token: "synthetic-token-123456" }, { connect: async () => socket });
  const session = await admissionAdapter.openSession({ meetingId: "m", speakerId: "s", idempotencyKey: "k", onTranscript: () => {} });
  await expect(session.sendPacket({ opus: new Uint8Array([0xf8, 0xff, 0xfe]), durationSamples48Khz: 960, packetId: "p", relativeTimeMs: 0 }))
    .rejects.toMatchObject({ code: "live_acceptance_unknown", retryable: false });
  session.terminate();
});

const quota = { type: "error", code: "PROVIDER_TERMINAL", message: "synthetic quota" };
const terminalRequest = { idempotencyKey: "quota", meetingId: "meeting", speakerId: "speaker", onTranscript: () => {} };
const terminalPacket = { packetId: "quota-packet", opus: new Uint8Array([0xf8, 0xff, 0xfe]), durationSamples48Khz: 960, relativeTimeMs: 0 };

it.each([undefined, "known_accepted_terminal"])("retains quota code and classification before ready: %s", async (failure_class) => {
  const socket = new QueueSocket();
  socket.enqueue({ ...quota, ...(failure_class === undefined ? {} : { failure_class }) });
  await expect(adapter(socket).openSession(terminalRequest)).rejects.toMatchObject({
    code: "live_provider_terminal", gatewayCode: quota.code, retryable: false,
    ...(failure_class === undefined ? {} : { failureClass: failure_class }),
  });
  expect(socket.terminated).toBe(true);
});

it.each(["awaiting-ack", "between-packets"].flatMap(phase => [
  ["PROVIDER_TERMINAL", "live_provider_terminal"],
  ["PROVIDER_OUTCOME_UNKNOWN", "live_acceptance_unknown"],
].map(([code, expected]) => ({ phase, code, expected }))))("preserves first gateway failure %j through send, finalize and cleanup", async ({ phase, code, expected }) => {
  const socket = new DelayedAckSocket();
  const session = await adapter(socket).openSession(terminalRequest);
  const sent = session.sendPacket(terminalPacket);
  const outcome = sent.catch((error: unknown) => error);
  await Promise.resolve();
  if (phase === "between-packets") { socket.acknowledge(1); await expect(sent).resolves.toBe("accepted"); }
  socket.enqueue({ type: "error", code, message: "synthetic provider failure" });
  await vi.waitFor(() => { expect(socket.terminated).toBe(true); });
  const failure: unknown = await session.finalize().catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: expected, gatewayCode: code, retryable: false });
  if (phase === "awaiting-ack") { expect(await outcome).toBe(failure); }
  session.terminate();
  await expect(session.sendPacket({ ...terminalPacket, packetId: "later" })).rejects.toBe(failure);
  await expect(session.finalize()).rejects.toBe(failure);
  expect(socket.binary).toHaveLength(1);
});

it("keeps opening INVALID_CONFIG distinct from provider terminal failure", async () => {
  const socket = new QueueSocket();
  socket.enqueue({ type: "error", code: "INVALID_CONFIG", message: "synthetic" });
  await expect(adapter(socket).openSession(terminalRequest)).rejects.toMatchObject({ code: "live_admission_rejected", retryable: false });
});

it("validates bounded terminal wire evidence without trusting arbitrary classification", async () => {
  for (const failure_class of [false, {}, "terminal", "retryable:false"]) {
    expect(parseServerMessage(JSON.stringify({ ...quota, code: "OTHER", failure_class }), 100))
      .toEqual({ type: "error", code: "OTHER", message: quota.message });
  }
  expect(() => parseServerMessage(JSON.stringify({ ...quota, code: "q".repeat(129) }), 100)).toThrow();
  const socket = new QueueSocket();
  socket.enqueue({ ...quota, code: "OTHER", failure_class: "known_accepted_terminal" });
  await expect(adapter(socket).openSession(terminalRequest)).rejects.toMatchObject({
    code: "live_provider_terminal", gatewayCode: "OTHER", failureClass: "known_accepted_terminal",
  });
});

it("maps the deployed unknown outcome before ready without a failure_class", async () => {
  const socket = new QueueSocket();
  socket.enqueue({ type: "error", code: "PROVIDER_OUTCOME_UNKNOWN", message: "synthetic" });
  await expect(adapter(socket).openSession(terminalRequest)).rejects.toMatchObject({
    code: "live_acceptance_unknown", gatewayCode: "PROVIDER_OUTCOME_UNKNOWN", retryable: false,
  });
  expect(socket.terminated).toBe(true);
});

it("retains proven nonacceptance while awaiting an ACK", async () => {
  const socket = new DelayedAckSocket();
  const session = await adapter(socket).openSession(terminalRequest);
  const sent = session.sendPacket(terminalPacket);
  const assertion = expect(sent).rejects.toMatchObject({
    code: "provider_error", gatewayCode: "PROVIDER_UNAVAILABLE", retryable: true,
  });
  await Promise.resolve();
  socket.enqueue({ type: "error", code: "PROVIDER_UNAVAILABLE", message: "synthetic" });
  await assertion;
  session.terminate();
});
