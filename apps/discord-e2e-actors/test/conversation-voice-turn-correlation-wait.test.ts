import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { ConversationVoiceCaptureController } from
  "../src/conversation-voice-capture-controller.js";
import { captureConversationVoiceFromOpenStream } from
  "../src/conversation-voice-stream-capture.js";
import { waitForConversationVoiceTurnIdWhileGuardingAudio } from
  "../src/conversation-voice-turn-correlation-wait.js";

describe("conversation voice runtime turn correlation wait", () => {
  it("discards silence while flowing, then pauses and cleans up before resolving", async () => {
    const stream = new PassThrough();
    const deferred = turnIdDeferred();
    const waiting = waitForConversationVoiceTurnIdWhileGuardingAudio({
      isPacketAudible: (packet) => packet[0] !== 0,
      resolveTurnId: deferred.resolveTurnId,
      stream,
    });

    stream.write(Uint8Array.of(0));
    deferred.resolve("human-question-17");

    await expect(waiting).resolves.toBe("human-question-17");
    expect(stream.isPaused()).toBe(true);
    expectCorrelationWaitListenersRemoved(stream);
    stream.destroy();
  });

  it("aborts correlation and cleans up on audible pre-correlation audio", async () => {
    const stream = new PassThrough();
    const deferred = turnIdDeferred();
    const waiting = waitForConversationVoiceTurnIdWhileGuardingAudio({
      isPacketAudible: (packet) => packet[0] !== 0,
      resolveTurnId: deferred.resolveTurnId,
      stream,
    });

    stream.write(Uint8Array.of(1));

    await expect(waiting).rejects.toThrow("before runtime turn correlation was confirmed");
    expect(deferred.signal?.aborted).toBe(true);
    expect(stream.isPaused()).toBe(true);
    expectCorrelationWaitListenersRemoved(stream);
    stream.destroy();
  });

  it("hands a paused clean stream to capture and accepts only post-correlation audio", async () => {
    const stream = new PassThrough();
    const deferred = turnIdDeferred();
    const waiting = waitForConversationVoiceTurnIdWhileGuardingAudio({
      isPacketAudible: (packet) => packet[0] !== 0,
      resolveTurnId: deferred.resolveTurnId,
      stream,
    });
    stream.write(Uint8Array.of(0));
    deferred.resolve("human-question-19");
    await expect(waiting).resolves.toBe("human-question-19");

    let nowMilliseconds = 1_000;
    const capture = captureConversationVoiceFromOpenStream({
      captureTimeoutMilliseconds: 1_000,
      clock: {
        now: () => {
          nowMilliseconds += 20;
          return timestamp(nowMilliseconds);
        },
      },
      controller: new ConversationVoiceCaptureController({
        captureTimeoutMilliseconds: 1_000,
        expectedDuration: { maximumMilliseconds: 20, minimumMilliseconds: 20 },
        maxPcmBytes: 3_840,
      }, {
        decode: () => new Uint8Array(3_840).fill(1),
      }),
      firstPacketTimeoutMilliseconds: 1_000,
      stream,
    });
    stream.write(Uint8Array.of(7));

    await expect(capture).resolves.toMatchObject({
      acceptedPacketCount: 1,
      firstPacketAt: { epochMilliseconds: 1_020 },
    });
    expect(stream.isPaused()).toBe(true);
    expectCorrelationWaitListenersRemoved(stream);
    stream.destroy();
  });

  it("cleans up when the correlation resolver throws synchronously", async () => {
    const stream = new PassThrough();
    const waiting = waitForConversationVoiceTurnIdWhileGuardingAudio({
      isPacketAudible: () => false,
      resolveTurnId: () => {
        throw new Error("synthetic resolver failure");
      },
      stream,
    });

    await expect(waiting).rejects.toThrow("synthetic resolver failure");
    expect(stream.isPaused()).toBe(true);
    expectCorrelationWaitListenersRemoved(stream);
    stream.destroy();
  });

  it("rejects a stream that is already closed before correlation starts", async () => {
    const stream = new PassThrough();
    stream.destroy();

    await expect(waitForConversationVoiceTurnIdWhileGuardingAudio({
      isPacketAudible: () => false,
      resolveTurnId: async () => "human-question-closed",
      stream,
    })).rejects.toThrow("closed before runtime turn correlation");
    expectCorrelationWaitListenersRemoved(stream);
  });

  it("fails closed and cleans up for end, error, and non-binary stream events", async () => {
    await expectGuardFailure((stream) => stream.end(), "ended before runtime turn correlation");
    await expectGuardFailure(
      (stream) => stream.emit("error", new Error("synthetic receiver error")),
      "failed before runtime turn correlation",
    );
    await expectGuardFailure(
      (stream) => stream.emit("data", "not-binary"),
      "non-binary packet",
    );
  });
});

function turnIdDeferred(): {
  readonly resolve: (turnId: string) => void;
  readonly resolveTurnId: (signal: AbortSignal) => Promise<string>;
  readonly signal: AbortSignal | undefined;
} {
  let complete: ((turnId: string) => void) | undefined;
  let observedSignal: AbortSignal | undefined;
  const promise = new Promise<string>((resolve) => {
    complete = resolve;
  });
  return {
    resolve: (turnId) => complete?.(turnId),
    resolveTurnId: (signal) => {
      observedSignal = signal;
      return promise;
    },
    get signal() {
      return observedSignal;
    },
  };
}

async function expectGuardFailure(
  emitFailure: (stream: PassThrough) => unknown,
  message: string,
): Promise<void> {
  const stream = new PassThrough();
  const deferred = turnIdDeferred();
  const waiting = waitForConversationVoiceTurnIdWhileGuardingAudio({
    isPacketAudible: () => false,
    resolveTurnId: deferred.resolveTurnId,
    stream,
  });
  emitFailure(stream);
  await expect(waiting).rejects.toThrow(message);
  expect(deferred.signal?.aborted).toBe(true);
  expect(stream.isPaused()).toBe(true);
  expectCorrelationWaitListenersRemoved(stream);
  stream.destroy();
}

function expectCorrelationWaitListenersRemoved(stream: PassThrough): void {
  expect(stream.listenerCount("data")).toBe(0);
  expect(stream.listenerCount("end")).toBe(0);
  expect(stream.listenerCount("error")).toBe(0);
}

function timestamp(epochMilliseconds: number): {
  readonly epochMilliseconds: number;
  readonly monotonicMilliseconds: number;
} {
  return { epochMilliseconds, monotonicMilliseconds: epochMilliseconds };
}
