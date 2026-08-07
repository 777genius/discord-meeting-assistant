import { describe, expect, it } from "vitest";

import type { VoicetextPacingScheduler } from "../src/audio-pacing.js";
import type {
  CompleteOggArtifactReader,
  OggArtifactReadOptions,
} from "../src/ogg-artifact-reader.js";
import type {
  CompleteOggToPcmTranscoder,
  PcmTranscodeOptions,
} from "../src/pcm-transcoder.js";
import { VoicetextFinalTranscriptionAdapter } from "../src/voicetext-final-transcription-adapter.js";
import type {
  VoicetextInboundFrame,
  VoicetextWebSocketConnection,
  VoicetextWebSocketConnector,
  VoicetextWebSocketConnectRequest,
} from "../src/websocket-connector.js";

class MemoryOggReader implements CompleteOggArtifactReader {
  public readonly reads: Array<{ locator: string; options: OggArtifactReadOptions }> = [];

  public constructor(
    private readonly artifacts: Readonly<Record<string, Uint8Array>>,
  ) {}

  public async read(audioLocator: string, options: OggArtifactReadOptions) {
    this.reads.push({ locator: audioLocator, options });
    const bytes = this.artifacts[audioLocator];
    if (bytes === undefined) {
      throw new Error("missing artifact fixture");
    }
    return { bytes, complete: true, container: "ogg" } as const;
  }
}

class FakeTranscoder implements CompleteOggToPcmTranscoder {
  public readonly calls: Array<{ bytes: Uint8Array; options: PcmTranscodeOptions }> = [];

  public constructor(private readonly pcmBytes = 64_000) {}

  public async transcode(bytes: Uint8Array, options: PcmTranscodeOptions) {
    this.calls.push({ bytes, options });
    return {
      bytes: new Uint8Array(this.pcmBytes),
      channels: 1,
      encoding: "pcm_s16le",
      sampleRate: 16_000,
    } as const;
  }
}

class FakePacingScheduler implements VoicetextPacingScheduler {
  public readonly delaysMs: number[] = [];
  private currentTimeMs = 0;

  public nowMs(): number {
    return this.currentTimeMs;
  }

  public async sleep(delayMs: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.delaysMs.push(delayMs);
    this.currentTimeMs += delayMs;
  }
}

class ScriptedConnector implements VoicetextWebSocketConnector {
  public readonly connections: FakeSocket[] = [];
  public readonly requests: VoicetextWebSocketConnectRequest[] = [];

  public constructor(
    private readonly script: (socket: FakeSocket, connectionIndex: number) => void,
  ) {}

  public async connect(request: VoicetextWebSocketConnectRequest) {
    this.requests.push(request);
    const socket = new FakeSocket();
    this.script(socket, this.connections.length);
    this.connections.push(socket);
    return socket;
  }
}

class FakeSocket implements VoicetextWebSocketConnection {
  public readonly binaryFrames: Uint8Array[] = [];
  public readonly textMessages: Array<Readonly<Record<string, unknown>>> = [];
  public closed = false;
  public terminated = false;
  public onBinary: ((frame: Uint8Array, sequence: number) => void) | undefined;
  public onText: ((message: Readonly<Record<string, unknown>>) => void) | undefined;
  private readonly inbound: VoicetextInboundFrame[] = [];

  public enqueue(message: Readonly<Record<string, unknown>>): void {
    this.inbound.push({ data: JSON.stringify(message), type: "text" });
  }

  public enqueueFrame(frame: VoicetextInboundFrame): void {
    this.inbound.push(frame);
  }

  public async sendText(data: string): Promise<void> {
    const message = JSON.parse(data) as Readonly<Record<string, unknown>>;
    this.textMessages.push(message);
    this.onText?.(message);
  }

  public async sendBinary(data: Uint8Array): Promise<void> {
    const copy = Uint8Array.from(data);
    this.binaryFrames.push(copy);
    this.onBinary?.(copy, this.binaryFrames.length);
  }

  public async receive(): Promise<VoicetextInboundFrame> {
    const frame = this.inbound.shift();
    if (frame === undefined) {
      throw new Error("script did not provide an inbound frame");
    }
    return frame;
  }

  public async close(): Promise<void> {
    this.closed = true;
  }

  public terminate(): void {
    this.terminated = true;
  }
}

describe("VoicetextFinalTranscriptionAdapter", () => {
  it("streams protocol-v2 sequentially and returns stable globally-timed final evidence", async () => {
    const reader = readerFixture();
    const transcoder = new FakeTranscoder();
    const connector = new ScriptedConnector((socket, connectionIndex) => {
      socket.onText = (message) => {
        if (message.type === "config") {
          socket.enqueue({
            session_id: `00000000-0000-4000-8000-00000000000${connectionIndex + 1}`,
            type: "ready",
          });
        }
        if (message.type === "finalize") {
          const text = connectionIndex % 2 === 0 ? " stable A " : "stable B";
          socket.enqueue({ duration_ms: 1_000, start_ms: 0, text, type: "final" });
          socket.enqueue({ saw_result: true, status: "flushed", type: "finalize_complete" });
        }
      };
      socket.onBinary = (_frame, sequence) => {
        if (sequence === 1) {
          socket.enqueue({ text: { malformed: true }, type: "partial" });
          socket.enqueue({
            duration_ms: 1_000,
            is_segment_final: true,
            start_ms: 0,
            text: connectionIndex % 2 === 0 ? " stable A " : "stable B",
            type: "partial",
          });
        }
        socket.enqueue({ seq: sequence, type: "ack" });
      };
    });
    const adapter = adapterFixture(reader, transcoder, connector, {
      audioFrameBytes: 32_000,
      keyterms: ["Craig", "Deepgram", "Craig"],
    });

    const first = await adapter.transcribe(requestFixture());
    const second = await adapter.transcribe(requestFixture());

    expect(first).toEqual(second);
    expect(first).toEqual({
      ok: true,
      value: {
        readableSegments: [],
        transcriptId: "transcript:v1:7:job-key",
        turns: [
          {
            endMs: 2_000,
            speakerId: "discord-user-a",
            startMs: 1_000,
            text: "stable A",
            turnId: "turn:v1:7:job-key:1:1:1:1",
          },
          {
            endMs: 2_500,
            speakerId: "discord-user-b",
            startMs: 1_500,
            text: "stable B",
            turnId: "turn:v1:7:job-key:1:2:1:1",
          },
        ],
        version: 1,
      },
    });
    expect(connector.connections).toHaveLength(4);
    expect(connector.connections.every(({ closed, terminated }) => closed && !terminated)).toBe(true);
    expect(connector.connections.every(({ binaryFrames }) => binaryFrames.length === 2)).toBe(true);
    expect(connector.requests.every(({ authorization }) => authorization === "Bearer service-secret")).toBe(true);
    expect(connector.requests.every(({ endpoint }) => endpoint.href === "wss://voicetext.test/api/v1/transcribe/stream")).toBe(true);
    const configs = connector.connections.map(({ textMessages }) => textMessages[0]);
    expect(configs[0]).toMatchObject({
      capabilities: ["finalize_ack"],
      channels: 1,
      encoding: "pcm_s16le",
      keyterms: ["Craig", "Deepgram"],
      language: "ru",
      protocol_v: 2,
      provider: "deepgram",
      sample_rate: 16_000,
      type: "config",
    });
    expect(configs[0]?.client_session_id).toBe(configs[2]?.client_session_id);
    expect(configs[0]?.client_session_id).not.toBe(configs[1]?.client_session_id);
    expect(reader.reads).toHaveLength(4);
    expect(transcoder.calls).toHaveLength(4);
  });

  it("does not delay a short single-frame track", async () => {
    const pacing = new FakePacingScheduler();
    const connector = new ScriptedConnector((socket) => {
      standardSuccessfulSession(socket);
    });

    const result = await adapterFixture(
      readerFixture(true),
      new FakeTranscoder(32_000),
      connector,
      {},
      pacing,
    ).transcribe(requestFixture(true));

    expect(result.ok).toBe(true);
    expect(connector.connections[0]?.binaryFrames).toHaveLength(1);
    expect(pacing.delaysMs).toEqual([]);
  });

  it("paces long PCM deterministically below the safe default byte rate", async () => {
    const pacing = new FakePacingScheduler();
    const binarySendTimesMs: number[] = [];
    const connector = new ScriptedConnector((socket) => {
      standardSuccessfulSession(socket);
      socket.onBinary = chainBinaryHandler(socket.onBinary, () => {
        binarySendTimesMs.push(pacing.nowMs());
      });
    });

    const result = await adapterFixture(
      readerFixture(true),
      new FakeTranscoder(800_000),
      connector,
      {},
      pacing,
    ).transcribe(requestFixture(true));

    expect(result.ok).toBe(true);
    expect(binarySendTimesMs).toHaveLength(25);
    expect(binarySendTimesMs[0]).toBe(0);
    for (const [frameIndex, sentAtMs] of binarySendTimesMs.entries()) {
      expect(sentAtMs).toBeGreaterThanOrEqual(frameIndex * 32_000 * 1_000 / 32_000);
    }
    expect(binarySendTimesMs.at(-1)).toBe(24_000);
  });

  it("cancels while waiting for the next paced audio frame", async () => {
    const controller = new AbortController();
    const pacing: VoicetextPacingScheduler = {
      nowMs: () => 0,
      sleep: async (_delayMs, signal) => {
        controller.abort(new Error("cancel test"));
        signal.throwIfAborted();
      },
    };
    const connector = new ScriptedConnector((socket) => {
      standardSuccessfulSession(socket);
    });

    const result = await adapterFixture(
      readerFixture(true),
      new FakeTranscoder(64_000),
      connector,
      {},
      pacing,
    ).transcribe({ ...requestFixture(true), signal: controller.signal });

    expect(result).toMatchObject({
      failure: {
        code: "VOICETEXT_TRANSCRIPTION_CANCELLED",
        retryable: true,
      },
      ok: false,
    });
    expect(connector.connections[0]?.binaryFrames).toHaveLength(1);
    expect(connector.connections[0]?.terminated).toBe(true);
  });

  it.each([
    [{ maxAudioBytesPerSecond: 64_000 }, "maxAudioBytesPerSecond"],
    [{ audioFrameBytes: 65_538 }, "audioFrameBytes"],
    [{ audioFrameBytes: 64_000, maxAudioBytesPerSecond: 32_000 }, "audioFrameBytes"],
  ])("rejects unsafe pacing options %#", (overrides, field) => {
    expect(() => adapterFixture(
      readerFixture(true),
      new FakeTranscoder(),
      new ScriptedConnector(() => {}),
      overrides,
    )).toThrow(field);
  });

});

describe("VoicetextFinalTranscriptionAdapter failure handling", () => {
  it("fails closed on an out-of-order ACK", async () => {
    const connector = new ScriptedConnector((socket) => {
      socket.onText = (message) => {
        if (message.type === "config") {
          socket.enqueue({ session_id: "00000000-0000-4000-8000-000000000001", type: "ready" });
        }
      };
      socket.onBinary = () => {
        socket.enqueue({ seq: 2, type: "ack" });
      };
    });

    await expect(adapterFixture(readerFixture(true), new FakeTranscoder(32_000), connector).transcribe(requestFixture(true))).resolves.toEqual({
      failure: {
        code: "VOICETEXT_TRANSCRIPTION_PROTOCOL_ERROR",
        message: "Voicetext acknowledged audio out of order",
        retryable: false,
      },
      ok: false,
    });
    expect(connector.connections[0]?.terminated).toBe(true);
  });

  it("treats finalize timeout acknowledgement as retryable and discards partial attempt output", async () => {
    const connector = new ScriptedConnector((socket) => {
      standardReadyAndAck(socket);
      socket.onText = chainTextHandler(socket.onText, (message) => {
        if (message.type === "finalize") {
          socket.enqueue({ duration_ms: 500, start_ms: 0, text: "not committed", type: "final" });
          socket.enqueue({ saw_result: true, status: "timeout", type: "finalize_complete" });
        }
      });
    });

    await expect(adapterFixture(readerFixture(true), new FakeTranscoder(32_000), connector).transcribe(requestFixture(true))).resolves.toEqual({
      failure: {
        code: "VOICETEXT_TRANSCRIPTION_TIMEOUT",
        message: "Voicetext finalize did not flush provider results",
        retryable: true,
      },
      ok: false,
    });
  });

  it.each([
    ["RATE_LIMIT_EXCEEDED", "RATE_LIMITED", true],
    ["TOO_MANY_SESSIONS", "RATE_LIMITED", true],
    ["PROVIDER_UNAVAILABLE", "PROVIDER_ERROR", true],
    ["PROVIDER_QUOTA_EXCEEDED", "QUOTA_EXCEEDED", false],
    ["BAD_REQUEST", "PROTOCOL_ERROR", false],
  ])("maps server error %s retryability", async (serverCode, portCode, retryable) => {
    const connector = new ScriptedConnector((socket) => {
      socket.onText = (message) => {
        if (message.type === "config") {
          socket.enqueue({ code: serverCode, message: "must not cross boundary", type: "error" });
        }
      };
    });
    const result = await adapterFixture(readerFixture(true), new FakeTranscoder(), connector).transcribe(requestFixture(true));

    expect(result).toMatchObject({
      failure: { code: `VOICETEXT_TRANSCRIPTION_${portCode}`, retryable },
      ok: false,
    });
    if (!result.ok) {
      expect(result.failure.message).not.toContain("must not cross boundary");
    }
  });

  it("cancels an in-flight artifact read without contacting Voicetext", async () => {
    const connector = new ScriptedConnector(() => {});
    const reader: CompleteOggArtifactReader = {
      read: async (_locator, { signal }) => await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(signal.reason);
        }, { once: true });
      }),
    };
    const controller = new AbortController();
    const pending = adapterFixture(reader, new FakeTranscoder(), connector).transcribe({
      ...requestFixture(true),
      signal: controller.signal,
    });
    controller.abort(new Error("cancel test"));

    await expect(pending).resolves.toEqual({
      failure: {
        code: "VOICETEXT_TRANSCRIPTION_CANCELLED",
        message: "Voicetext transcription was cancelled",
        retryable: true,
      },
      ok: false,
    });
    expect(connector.requests).toEqual([]);
  });

  it("rejects a non-Ogg artifact before transcoding or provider I/O", async () => {
    const reader = new MemoryOggReader({ "recording://speaker-a": Uint8Array.from([1, 2, 3, 4]) });
    const transcoder = new FakeTranscoder();
    const connector = new ScriptedConnector(() => {});

    await expect(adapterFixture(reader, transcoder, connector).transcribe(requestFixture(true))).resolves.toMatchObject({
      failure: { code: "VOICETEXT_TRANSCRIPTION_INVALID_INPUT", retryable: false },
      ok: false,
    });
    expect(transcoder.calls).toEqual([]);
    expect(connector.requests).toEqual([]);
  });

  it("does not expose the service token when connection setup fails", async () => {
    const connector: VoicetextWebSocketConnector = {
      connect: async ({ authorization }) => {
        throw new Error(`transport rejected ${authorization}`);
      },
    };
    const result = await adapterFixture(readerFixture(true), new FakeTranscoder(), connector).transcribe(requestFixture(true));

    expect(result).toEqual({
      failure: {
        code: "VOICETEXT_TRANSCRIPTION_TRANSPORT_ERROR",
        message: "Voicetext transport error",
        retryable: true,
      },
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain("service-secret");
  });
});

function standardReadyAndAck(socket: FakeSocket): void {
  socket.onText = (message) => {
    if (message.type === "config") {
      socket.enqueue({ session_id: "00000000-0000-4000-8000-000000000001", type: "ready" });
    }
  };
  socket.onBinary = (_frame, sequence) => {
    socket.enqueue({ seq: sequence, type: "ack" });
  };
}

function standardSuccessfulSession(socket: FakeSocket): void {
  standardReadyAndAck(socket);
  socket.onText = chainTextHandler(socket.onText, (message) => {
    if (message.type === "finalize") {
      socket.enqueue({ saw_result: true, status: "flushed", type: "finalize_complete" });
    }
  });
}

function chainBinaryHandler(
  first: ((frame: Uint8Array, sequence: number) => void) | undefined,
  second: (frame: Uint8Array, sequence: number) => void,
): (frame: Uint8Array, sequence: number) => void {
  return (frame, sequence) => {
    first?.(frame, sequence);
    second(frame, sequence);
  };
}

function chainTextHandler(
  first: ((message: Readonly<Record<string, unknown>>) => void) | undefined,
  second: (message: Readonly<Record<string, unknown>>) => void,
): (message: Readonly<Record<string, unknown>>) => void {
  return (message) => {
    first?.(message);
    second(message);
  };
}

function adapterFixture(
  reader: CompleteOggArtifactReader,
  transcoder: CompleteOggToPcmTranscoder,
  connector: VoicetextWebSocketConnector,
  overrides: Partial<ConstructorParameters<typeof VoicetextFinalTranscriptionAdapter>[2]> = {},
  pacingScheduler: VoicetextPacingScheduler = new FakePacingScheduler(),
): VoicetextFinalTranscriptionAdapter {
  return new VoicetextFinalTranscriptionAdapter(reader, transcoder, {
    endpoint: "wss://voicetext.test/api/v1/transcribe/stream",
    token: "service-secret",
    ...overrides,
  }, connector, pacingScheduler);
}

function readerFixture(singleSpeaker = false): MemoryOggReader {
  return new MemoryOggReader({
    "recording://speaker-a": oggBytes(1),
    ...(singleSpeaker ? {} : { "recording://speaker-b": oggBytes(2) }),
  });
}

function oggBytes(marker: number): Uint8Array {
  return Uint8Array.from([0x4f, 0x67, 0x67, 0x53, marker]);
}

function requestFixture(singleSpeaker = false) {
  return {
    idempotencyKey: "job-key",
    meetingId: "meeting-1",
    recording: {
      manifestLocator: "recording://manifest",
      recordingId: "recording-1",
      speakerAudio: [
        speakerReference("a", 1_000),
        ...(singleSpeaker ? [] : [speakerReference("b", 1_500)]),
      ],
    },
  } as const;
}

function speakerReference(speaker: string, timelineOffsetMs: number) {
  return {
    audioLocator: `recording://speaker-${speaker}`,
    speakerId: `discord-user-${speaker}`,
    timelineOffsetMs,
  } as const;
}
