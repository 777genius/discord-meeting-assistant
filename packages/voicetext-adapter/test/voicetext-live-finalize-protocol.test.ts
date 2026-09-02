import { setImmediate as nextTask } from "node:timers/promises";

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

const terminal = {
  saw_result: true,
  status: "flushed",
  type: "finalize_complete",
} as const;

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
  ] as const)("rejects inconsistent terminal evidence %j", (evidence) => {
    expect(() => validateLiveSessionFinalizeStatus(evidence, 0)).toThrow(
      VoicetextAdapterError,
    );
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
    expect(() => validateLiveSessionFinalizeStatus(evidence, 0)).not.toThrow();
    expect(() => validateLiveSessionFinalizeStatus(evidence, 1)).toThrow(
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
    expect(socket.closeCalls).toBe(1);
    expect(socket.terminated).toBe(false);
  });

  it.each(["synchronous", "later-task", "after-close", "contradictory-after-close"] as const)(
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
  | "after-close"
  | "close-before-terminal"
  | "compliant"
  | "contradictory-after-close"
  | "gated-close"
  | "later-task"
  | "never-close"
  | "synchronous";

class FinalizeSocket implements VoicetextWebSocketConnection {
  public closeCalls = 0;
  public readonly closeStarted: Promise<void>;
  public terminated = false;
  private readonly closeRelease: Promise<void>;
  private releaseClose!: () => void;
  private resolveCloseStarted!: () => void;
  private readonly frames: VoicetextInboundFrame[] = [];
  private waiter: ((frame: VoicetextInboundFrame) => void) | undefined;

  public constructor(private readonly behavior: FinalizeBehavior) {
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
      if (this.behavior === "close-before-terminal") {
        this.enqueueClose();
        return;
      }
      this.enqueue(terminal);
      if (this.behavior === "synchronous") {
        this.enqueue(terminal);
      } else if (this.behavior === "later-task") {
        void nextTask().then(() => {
          return this.enqueue(terminal);
        });
      }
      return;
    }
    if (message.type === "close" &&
        ["after-close", "contradictory-after-close"].includes(this.behavior)) {
      this.enqueue(this.behavior === "contradictory-after-close"
        ? { saw_result: false, status: "timeout", type: "finalize_complete" }
        : terminal);
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

  public async close(): Promise<void> {
    this.closeCalls += 1;
    this.resolveCloseStarted();
    if (this.behavior !== "never-close") {
      if (this.behavior === "gated-close") {
        await this.closeRelease;
      } else {
        await nextTask();
      }
      this.enqueueClose();
    } else {
      await new Promise<void>(() => {});
    }
  }

  public terminate(): void {
    this.terminated = true;
  }

  private enqueue(message: Readonly<Record<string, unknown>>): void {
    this.push({ data: JSON.stringify(message), type: "text" });
  }

  private enqueueClose(): void {
    this.push({ code: 1_000, reason: "finalized", type: "close" });
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

async function finalize(socket: FinalizeSocket, timeoutMs = 1_000): Promise<void> {
  const session = new LiveSession(socket, {
    idempotencyKey: "terminal-evidence",
    meetingId: "meeting-1",
    onTranscript: () => {},
    speakerId: "speaker-1",
  }, validateVoicetextLiveTranscriptionOptions({
    endpoint: "wss://voice.example.test/api/v1/transcribe/stream",
    finalizeTimeoutMs: timeoutMs,
    token: "test-machine-token",
  }));
  await session.start();
  await session.finalize();
}
