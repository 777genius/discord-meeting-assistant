import { describe, expect, it } from "vitest";

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

describe("VoiceText live finalize terminal evidence", () => {
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
  ] as const)("rejects inconsistent terminal evidence %j", (terminal) => {
    expect(() => validateLiveSessionFinalizeStatus(terminal, 0)).toThrow(
      VoicetextAdapterError,
    );
    try {
      validateLiveSessionFinalizeStatus(terminal, 0);
    } catch (error) {
      expect(error).toMatchObject({ code: "protocol_error", retryable: false });
    }
  });

  it("accepts empty no-provider evidence only when no audio was acknowledged", () => {
    const terminal = {
      sawResult: false,
      status: "no_provider",
      type: "finalize_complete",
    } as const;
    expect(() => validateLiveSessionFinalizeStatus(terminal, 0)).not.toThrow();
    expect(() => validateLiveSessionFinalizeStatus(terminal, 1)).toThrow(
      "Voicetext did not create a provider session for acknowledged audio",
    );
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

  it("rejects duplicate terminal sequences observed before close", async () => {
    const socket = new DuplicateTerminalSocket();
    const session = new LiveSession(socket, {
      idempotencyKey: "duplicate-terminal",
      meetingId: "meeting-1",
      onTranscript: () => {},
      speakerId: "speaker-1",
    }, validateVoicetextLiveTranscriptionOptions({
      endpoint: "wss://voice.example.test/api/v1/transcribe/stream",
      finalizeTimeoutMs: 1_000,
      token: "test-machine-token",
    }));
    await session.start();

    await expect(session.finalize()).rejects.toThrow(
      "duplicate live finalize terminal evidence",
    );
    expect(socket.terminated).toBe(true);
  });
});

class DuplicateTerminalSocket implements VoicetextWebSocketConnection {
  public terminated = false;
  private readonly frames: VoicetextInboundFrame[] = [];
  private waiter: ((frame: VoicetextInboundFrame) => void) | undefined;

  public async sendText(data: string): Promise<void> {
    const message = JSON.parse(data) as { readonly type?: unknown };
    if (message.type === "config") {
      this.enqueue({
        model: "nova-3",
        provider: "deepgram",
        session_id: "00000000-0000-4000-8000-000000000001",
        type: "ready",
      });
    }
    if (message.type === "finalize") {
      const terminal = { saw_result: true, status: "flushed", type: "finalize_complete" };
      this.enqueue(terminal);
      this.enqueue(terminal);
    }
  }

  public async sendBinary(): Promise<void> {}

  public async receive(signal: AbortSignal): Promise<VoicetextInboundFrame> {
    signal.throwIfAborted();
    const frame = this.frames.shift();
    if (frame !== undefined) {
      return frame;
    }
    return await new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      this.waiter = (next) => {
        signal.removeEventListener("abort", abort);
        resolve(next);
      };
    });
  }

  public async close(): Promise<void> {}

  public terminate(): void {
    this.terminated = true;
  }

  private enqueue(message: Readonly<Record<string, unknown>>): void {
    const frame = { data: JSON.stringify(message), type: "text" } as const;
    if (this.waiter === undefined) {
      this.frames.push(frame);
      return;
    }
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter(frame);
  }
}
