import { describe, expect, it } from "vitest";

import {
  VoicetextLiveTranscriptionAdapter,
  type VoicetextInboundFrame,
  type VoicetextLiveTranscriptEvent,
  type VoicetextWebSocketConnection,
  type VoicetextWebSocketConnector,
  type VoicetextWebSocketConnectRequest,
} from "../src/index.js";

class QueueSocket implements VoicetextWebSocketConnection {
  public readonly binary: Uint8Array[] = [];
  public readonly text: Array<Readonly<Record<string, unknown>>> = [];
  public closed = false;
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
      this.enqueue({ session_id: "00000000-0000-4000-8000-000000000001", type: "ready" });
    } else if (message.type === "finalize") {
      this.enqueue({ saw_result: true, status: "flushed", type: "finalize_complete" });
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
    return Promise.resolve();
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

function adapter(socket: QueueSocket): VoicetextLiveTranscriptionAdapter {
  return new VoicetextLiveTranscriptionAdapter(
    {
      audioAckTimeoutMs: 1_000,
      endpoint: "wss://voicetext.test/api/v1/transcribe/stream",
      finalizeTimeoutMs: 1_000,
      keyterms: ["Craig", "Craig", "Discord"],
      readyTimeoutMs: 1_000,
      token: "service-token-that-is-long-enough",
    },
    new SingleSocketConnector(socket),
  );
}

describe("VoicetextLiveTranscriptionAdapter", () => {
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
      protocol_v: 2,
      provider: "deepgram",
      sample_rate: 48_000,
      type: "config",
    });
    expect(await session.sendPacket({
      opus: Uint8Array.from([0xf8, 0xff, 0xfe]),
      packetId: "packet-1",
      relativeTimeMs: 10_000,
    })).toBe("accepted");
    expect(await session.sendPacket({
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
      opus: new Uint8Array(65_537),
      packetId: "packet-too-large",
      relativeTimeMs: 0,
    })).rejects.toThrow("Live Opus packet is invalid");
    expect(socket.binary).toEqual([]);
    session.terminate();
    expect(socket.terminated).toBe(true);
  });
});
