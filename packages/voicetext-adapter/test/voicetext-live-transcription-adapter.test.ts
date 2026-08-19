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

  public constructor(public readonly socket: QueueSocket) {}

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

describe("VoicetextLiveTranscriptionAdapter", () => {
  it("fails closed for an unsupported runtime live profile", () => {
    expect(() => validateVoicetextLiveTranscriptionOptions({
      endpoint: "wss://api.voicetext.test/api/v1/transcribe/stream",
      profile: "elevenlabs-scribe-v2-realtime-typo" as VoicetextLiveProfile,
      token: "x".repeat(16),
    })).toThrow("Voicetext live profile is unsupported");
  });

  it.each([
    ["deepgram-nova-3", "deepgram", "nova-3"],
    ["elevenlabs-scribe-v2-realtime", "elevenlabs", "scribe_v2_realtime"],
  ] as const)("requires the exact ready identity for %s before raw Opus audio", async (profile, provider, model) => {
    const socket = new QueueSocket();
    const session = await adapter(socket, profile).openSession({
      idempotencyKey: "live-session-profile",
      meetingId: "meeting-1",
      onTranscript: () => {},
      speakerId: "speaker-a",
    });

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

    await expect(adapter(socket).openSession({
      idempotencyKey: "live-session-invalid-ready",
      meetingId: "meeting-1",
      onTranscript: () => {},
      speakerId: "speaker-a",
    })).rejects.toMatchObject({ code: "protocol_error", retryable: false });
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
    expect(socket.text.at(-2)).toEqual({ type: "finalize" });
    expect(socket.text.at(-1)).toEqual({ type: "close" });
    expect(socket.closed).toBe(true);
    expect(socket.terminated).toBe(false);
  });

  it("rejects oversized packets before touching the transport", async () => {
    const socket = new QueueSocket();
    const session = await adapter(socket).openSession({
      idempotencyKey: "live-session-1",
      meetingId: "meeting-1",
      onTranscript: () => {},
      speakerId: "speaker-a",
    });

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
    const session = await adapter(socket).openSession({
      idempotencyKey: "live-session-no-provider",
      meetingId: "meeting-1",
      onTranscript: () => {},
      speakerId: "speaker-a",
    });

    await expect(session.finalize()).resolves.toBeUndefined();
    expect(socket.text.at(-2)).toEqual({ type: "finalize" });
    expect(socket.text.at(-1)).toEqual({ type: "close" });
    expect(socket.closed).toBe(true);
    expect(socket.terminated).toBe(false);
  });

  it("rejects no_provider after acknowledged audio and still gracefully closes", async () => {
    const socket = new QueueSocket();
    socket.finalizeStatus = "no_provider";
    const session = await adapter(socket).openSession({
      idempotencyKey: "live-session-no-provider-after-audio",
      meetingId: "meeting-1",
      onTranscript: () => {},
      speakerId: "speaker-a",
    });
    await session.sendPacket({
      durationSamples48Khz: 960,
      opus: Uint8Array.from([0xf8, 0xff, 0xfe]),
      packetId: "packet-1",
      relativeTimeMs: 0,
    });

    await expect(session.finalize()).rejects.toThrow(
      "Voicetext did not create a provider session for acknowledged audio",
    );
    expect(socket.text.at(-2)).toEqual({ type: "finalize" });
    expect(socket.text.at(-1)).toEqual({ type: "close" });
    expect(socket.closed).toBe(true);
    expect(socket.terminated).toBe(false);
  });

  it("gracefully closes after a provider finalize timeout before surfacing the error", async () => {
    const socket = new QueueSocket();
    socket.finalizeStatus = "timeout";
    const session = await adapter(socket).openSession({
      idempotencyKey: "live-session-timeout",
      meetingId: "meeting-1",
      onTranscript: () => {},
      speakerId: "speaker-a",
    });

    await expect(session.finalize()).rejects.toThrow("Voicetext live finalize completed with timeout");
    expect(socket.text.at(-2)).toEqual({ type: "finalize" });
    expect(socket.text.at(-1)).toEqual({ type: "close" });
    expect(socket.closed).toBe(true);
    expect(socket.terminated).toBe(false);
  });

  it("pipelines packets without a network round trip and fences finalize on all ACKs", async () => {
    const socket = new DelayedAckSocket();
    const session = await adapter(socket).openSession({
      idempotencyKey: "live-session-pipelined",
      meetingId: "meeting-1",
      onTranscript: () => {},
      speakerId: "speaker-a",
    });

    for (let sequence = 1; sequence <= 3; sequence += 1) {
      await expect(session.sendPacket({
        durationSamples48Khz: 960,
        opus: Uint8Array.from([0xf8, 0xff, 0xfe]),
        packetId: `packet-${sequence}`,
        relativeTimeMs: sequence * 20,
      })).resolves.toBe("accepted");
    }
    expect(socket.binary).toHaveLength(3);

    const finalize = session.finalize();
    await Promise.resolve();
    expect(socket.text.some(({ type }) => type === "finalize")).toBe(false);
    socket.acknowledge(1);
    socket.acknowledge(2);
    socket.acknowledge(3);
    await finalize;
    expect(socket.text.some(({ type }) => type === "finalize")).toBe(true);
  });

});

describe("VoicetextLiveTranscriptionAdapter finalization", () => {
  it("shares one finalization across concurrent callers", async () => {
    const socket = new DelayedAckSocket();
    const session = await adapter(socket).openSession({
      idempotencyKey: "live-session-single-finalize",
      meetingId: "meeting-1",
      onTranscript: () => {},
      speakerId: "speaker-a",
    });
    await session.sendPacket({
      durationSamples48Khz: 960,
      opus: Uint8Array.from([0xf8, 0xff, 0xfe]),
      packetId: "packet-1",
      relativeTimeMs: 0,
    });

    const first = session.finalize();
    const second = session.finalize();
    expect(second).toBe(first);
    socket.acknowledge(1);
    await Promise.all([first, second]);
    expect(session.finalize()).toBe(first);
    expect(socket.text.filter(({ type }) => type === "finalize")).toHaveLength(1);
    expect(socket.text.filter(({ type }) => type === "close")).toHaveLength(1);
  });

  it("surfaces a transport failure that rejected an outstanding ACK before finalize", async () => {
    const socket = new DelayedAckSocket();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const session = await adapter(socket).openSession({
      idempotencyKey: "live-session-disconnect-before-finalize",
      meetingId: "meeting-1",
      onTranscript: () => {},
      speakerId: "speaker-a",
    });
    await session.sendPacket({
      durationSamples48Khz: 960,
      opus: Uint8Array.from([0xf8, 0xff, 0xfe]),
      packetId: "packet-1",
      relativeTimeMs: 0,
    });
    socket.enqueueFrame({ code: 1_011, reason: "provider unavailable", type: "close" });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    try {
      expect(unhandled).toEqual([]);
      await expect(session.finalize()).rejects.toThrow(
        "Voicetext closed live session with code 1011",
      );
      expect(socket.terminated).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("force-terminates when graceful socket close fails", async () => {
    const socket = new QueueSocket();
    socket.closeError = new Error("close failed");
    const session = await adapter(socket).openSession({
      idempotencyKey: "live-session-close-failure",
      meetingId: "meeting-1",
      onTranscript: () => {},
      speakerId: "speaker-a",
    });

    await expect(session.finalize()).rejects.toThrow("close failed");
    expect(socket.terminated).toBe(true);
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
    await session.sendPacket({
      durationSamples48Khz: 960,
      opus: Uint8Array.from([0xf8, 0xff, 0xfe]),
      packetId: "packet-1",
      relativeTimeMs: 350_000,
    });
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
    const session = await adapter(socket).openSession({
      idempotencyKey: "live-session-concurrent-send",
      meetingId: "meeting-1",
      onTranscript: () => {},
      speakerId: "speaker-a",
    });
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

  it("gracefully closes after a client-side finalize timeout", async () => {
    vi.useFakeTimers();
    try {
      const socket = new NoFinalizeResponseSocket();
      const session = await adapter(socket).openSession({
        idempotencyKey: "live-session-local-timeout",
        meetingId: "meeting-1",
        onTranscript: () => {},
        speakerId: "speaker-a",
      });
      const finalization = session.finalize();
      const rejected = expect(finalization).rejects.toThrow(
        "Voicetext live finalize timed out",
      );
      await vi.advanceTimersByTimeAsync(1_001);

      await rejected;
      expect(socket.text.filter(({ type }) => type === "close")).toHaveLength(1);
      expect(socket.closed).toBe(true);
      expect(socket.terminated).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a client-side finalize timeout when socket close also fails", async () => {
    vi.useFakeTimers();
    try {
      const socket = new NoFinalizeResponseSocket();
      socket.closeError = new Error("close failed");
      const session = await adapter(socket).openSession({
        idempotencyKey: "live-session-local-timeout-close-failure",
        meetingId: "meeting-1",
        onTranscript: () => {},
        speakerId: "speaker-a",
      });
      const finalization = session.finalize();
      const rejected = expect(finalization).rejects.toThrow(
        "Voicetext live finalize timed out",
      );
      await vi.advanceTimersByTimeAsync(1_001);

      await rejected;
      expect(socket.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels one in-flight finalization and force-closes transport on terminate", async () => {
    const socket = new DelayedAckSocket();
    const session = await adapter(socket).openSession({
      idempotencyKey: "live-session-terminate-finalize-race",
      meetingId: "meeting-1",
      onTranscript: () => {},
      speakerId: "speaker-a",
    });
    await session.sendPacket({
      durationSamples48Khz: 960,
      opus: Uint8Array.from([0xf8, 0xff, 0xfe]),
      packetId: "packet-1",
      relativeTimeMs: 0,
    });
    const finalization = session.finalize();

    session.terminate();

    await expect(finalization).rejects.toThrow("terminated");
    expect(socket.terminated).toBe(true);
    expect(socket.text.filter(({ type }) => type === "finalize")).toHaveLength(0);
  });
});
