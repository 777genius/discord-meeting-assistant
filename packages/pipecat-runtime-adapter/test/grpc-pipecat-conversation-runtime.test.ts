import { EventEmitter } from "node:events";

import type { Metadata } from "@grpc/grpc-js";
import { describe, expect, it, vi } from "vitest";

import {
  GrpcPipecatConversationRuntime,
  type ConversationDuplexCall,
  type ConversationDuplexCallFactory,
} from "../src/index.js";

class FakeCall extends EventEmitter implements ConversationDuplexCall {
  public readonly writes: Record<string, unknown>[] = [];
  public cancelled = false;
  public deferNextWriteCompletion = false;
  public ended = false;
  public nextWriteError: Error | undefined;
  public paused = false;
  private readonly deferredWriteCallbacks: Array<
    (error?: Error | null) => void
  > = [];

  public write(
    frame: Record<string, unknown>,
    callback: (error?: Error | null) => void,
  ): boolean {
    this.writes.push(frame);
    const error = this.nextWriteError;
    this.nextWriteError = undefined;
    if (this.deferNextWriteCompletion) {
      this.deferNextWriteCompletion = false;
      this.deferredWriteCallbacks.push(callback);
    } else {
      callback(error);
    }
    return true;
  }

  public completeNextWrite(error?: Error): void {
    const callback = this.deferredWriteCallbacks.shift();
    if (callback === undefined) {
      throw new Error("no deferred gRPC write is pending");
    }
    callback(error);
  }

  public cancel(): void {
    this.cancelled = true;
  }

  public end(): void {
    this.ended = true;
  }

  public pause(): this {
    this.paused = true;
    return this;
  }

  public resume(): this {
    this.paused = false;
    return this;
  }

  public data(frame: Record<string, unknown>): void {
    this.emit("data", frame);
  }
}

class FakeCallFactory implements ConversationDuplexCallFactory {
  public readonly calls: FakeCall[] = [];
  public authorization: string | undefined;
  public nextCallWriteError: Error | undefined;
  public deferNextCallWriteCompletion = false;

  public checkHealth(metadata: Metadata): Promise<Record<string, unknown>> {
    this.authorization = metadata.get("authorization")[0]?.toString();
    return Promise.resolve({
      status: "STATUS_SERVING",
      runtimeName: "pipecat-runtime",
      runtimeVersion: "1.0.0",
      warningCodes: [],
    });
  }

  public create(metadata: Metadata): FakeCall {
    this.authorization = metadata.get("authorization")[0]?.toString();
    const call = new FakeCall();
    call.deferNextWriteCompletion = this.deferNextCallWriteCompletion;
    this.deferNextCallWriteCompletion = false;
    call.nextWriteError = this.nextCallWriteError;
    this.nextCallWriteError = undefined;
    this.calls.push(call);
    return call;
  }

  public close(): void {}
}

const request = {
  idempotencyKey: "conversation:meeting-1:turn-1",
  locale: "ru",
  meetingId: "meeting-1",
  prompt: "Расскажи короткий факт.",
  recordingId: "recording-1",
  speakerId: "speaker-1",
  systemPrompt: "Answer briefly in the participant's language.",
  turnId: "turn-1",
  voiceProfileId: "deterministic-e2e-ru",
} as const;

function serverMessage(
  payload: string,
  eventSequence: number,
  value: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    turnId: "turn-1",
    attemptId: "attempt-1",
    eventSequence: String(eventSequence),
    payload,
    [payload]: value,
  };
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const value of values) {
    collected.push(value);
  }
  return collected;
}

describe("GrpcPipecatConversationRuntime", () => {
  it("loads the generated local gRPC service without opening a provider call", () => {
    const runtime = new GrpcPipecatConversationRuntime({
      address: "127.0.0.1:50052",
      serviceToken: "test-service-token-1234",
    });

    runtime.close();
  });

  it("aborts a pending start write", async () => {
    const factory = new FakeCallFactory();
    factory.deferNextCallWriteCompletion = true;
    const runtime = new GrpcPipecatConversationRuntime({
      address: "127.0.0.1:50052",
      serviceToken: "test-service-token-1234",
      callFactory: factory,
    });
    const controller = new AbortController();

    const starting = runtime.startTurn(request, { signal: controller.signal });
    await vi.waitFor(() => {
      expect(factory.calls[0]?.writes).toHaveLength(1);
    });
    controller.abort("meeting-ended");

    await expect(starting).resolves.toMatchObject({
      failure: { code: "CONVERSATION_RUNTIME_START_CANCELLED" },
      ok: false,
    });
    expect(factory.calls[0]?.cancelled).toBe(true);
  });

  it("authenticates and parses provider-neutral readiness", async () => {
    const factory = new FakeCallFactory();
    const runtime = new GrpcPipecatConversationRuntime({
      address: "127.0.0.1:50052",
      serviceToken: "test-service-token-1234",
      callFactory: factory,
    });

    await expect(runtime.checkHealth()).resolves.toEqual({
      status: "serving",
      runtimeName: "pipecat-runtime",
      runtimeVersion: "1.0.0",
      warningCodes: [],
    });
    expect(factory.authorization).toBe("Bearer test-service-token-1234");
  });
  it("streams provider-neutral text and bounded PCM events", async () => {
    const factory = new FakeCallFactory();
    const runtime = new GrpcPipecatConversationRuntime({
      address: "127.0.0.1:50052",
      serviceToken: "test-service-token-1234",
      callFactory: factory,
    });
    const result = await runtime.startTurn(request);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const call = factory.calls[0]!;
    const events = collect(result.value.events);

    call.data(serverMessage("accepted", 0));
    call.data(serverMessage("textDelta", 1, { text: "Факт" }));
    call.data(serverMessage("audioStart", 2, {
      format: "CONVERSATION_AUDIO_FORMAT_PCM_S16LE",
      sampleRateHz: 48_000,
      channels: 1,
    }));
    call.data(serverMessage("audioChunk", 3, {
      audioSequence: "0",
      format: "CONVERSATION_AUDIO_FORMAT_PCM_S16LE",
      sampleRateHz: 48_000,
      channels: 1,
      pcm: Uint8Array.of(1, 0, 2, 0),
    }));
    call.data(serverMessage("completed", 4));

    await expect(events).resolves.toMatchObject([
      { type: "accepted", attemptId: "attempt-1" },
      { type: "text-delta", text: "Факт" },
      { type: "audio-start", sampleRateHz: 48_000 },
      { type: "audio-chunk", sequence: 0, bytes: Uint8Array.of(1, 0, 2, 0) },
      { type: "completed" },
    ]);
    expect(factory.authorization).toBe("Bearer test-service-token-1234");
    expect(call.ended).toBe(true);
  });

  it("aborts the transport when cancellation arrives before attempt acceptance", async () => {
    const factory = new FakeCallFactory();
    const runtime = new GrpcPipecatConversationRuntime({
      address: "127.0.0.1:50052",
      serviceToken: "test-service-token-1234",
      callFactory: factory,
    });
    const result = await runtime.startTurn(request);
    if (!result.ok) {
      throw new Error("turn did not start");
    }
    const call = factory.calls[0]!;
    await result.value.cancel("barge-in");
    expect(call.writes).toHaveLength(1);
    expect(call.cancelled).toBe(true);
    expect(call.ended).toBe(true);
    await expect(collect(result.value.events)).resolves.toEqual([]);
  });

  it("releases an accepted cancellation while its protocol write is pending", async () => {
    const factory = new FakeCallFactory();
    const runtime = new GrpcPipecatConversationRuntime({
      address: "127.0.0.1:50052",
      serviceToken: "test-service-token-1234",
      callFactory: factory,
    });
    const result = await runtime.startTurn(request);
    if (!result.ok) {
      throw new Error("turn did not start");
    }
    const call = factory.calls[0]!;
    call.data(serverMessage("accepted", 0));
    call.deferNextWriteCompletion = true;
    const cancellation = result.value.cancel("barge-in");

    expect(call.writes[1]).toMatchObject({
      schemaVersion: 1,
      cancelTurn: {
        turnId: "turn-1",
        attemptId: "attempt-1",
        reason: "CONVERSATION_CANCELLATION_REASON_BARGE_IN",
      },
    });
    await expect(cancellation).resolves.toBeUndefined();
    expect(call.cancelled).toBe(true);
    expect(call.ended).toBe(true);
    call.completeNextWrite();
    await collect(result.value.events);
  });

  it("fails closed on sequence gaps and malformed provider audio", async () => {
    const factory = new FakeCallFactory();
    const runtime = new GrpcPipecatConversationRuntime({
      address: "127.0.0.1:50052",
      serviceToken: "test-service-token-1234",
      callFactory: factory,
    });
    const result = await runtime.startTurn(request);
    if (!result.ok) {
      throw new Error("turn did not start");
    }
    const call = factory.calls[0]!;
    const events = collect(result.value.events);
    call.data(serverMessage("accepted", 1));

    await expect(events).resolves.toMatchObject([
      {
        type: "failed",
        failure: { code: "CONVERSATION_RUNTIME_PROTOCOL_ERROR", retryable: false },
      },
    ]);
    expect(call.cancelled).toBe(true);
  });

  it("pauses and resumes gRPC reads around one second of queued PCM", async () => {
    const factory = new FakeCallFactory();
    const runtime = new GrpcPipecatConversationRuntime({
      address: "127.0.0.1:50052",
      serviceToken: "test-service-token-1234",
      callFactory: factory,
    });
    const result = await runtime.startTurn(request);
    if (!result.ok) {
      throw new Error("turn did not start");
    }
    const call = factory.calls[0]!;
    call.data(serverMessage("accepted", 0));
    call.data(serverMessage("audioStart", 1, {
      format: "CONVERSATION_AUDIO_FORMAT_PCM_S16LE",
      sampleRateHz: 48_000,
      channels: 1,
    }));
    for (let sequence = 0; sequence < 5; sequence += 1) {
      call.data(serverMessage("audioChunk", sequence + 2, {
        audioSequence: String(sequence),
        format: "CONVERSATION_AUDIO_FORMAT_PCM_S16LE",
        sampleRateHz: 48_000,
        channels: 1,
        pcm: new Uint8Array(19_200),
      }));
    }
    expect(call.paused).toBe(true);

    const events = collect(result.value.events);
    await vi.waitFor(() => {
      expect(call.paused).toBe(false);
    });
    call.data(serverMessage("completed", 7));
    await expect(events).resolves.toHaveLength(8);
  });

  it("fails closed above two seconds of unconsumed PCM", async () => {
    const factory = new FakeCallFactory();
    const runtime = new GrpcPipecatConversationRuntime({
      address: "127.0.0.1:50052",
      serviceToken: "test-service-token-1234",
      callFactory: factory,
    });
    const result = await runtime.startTurn(request);
    if (!result.ok) {
      throw new Error("turn did not start");
    }
    const call = factory.calls[0]!;
    call.data(serverMessage("accepted", 0));
    for (let sequence = 0; sequence < 11; sequence += 1) {
      call.data(serverMessage("audioChunk", sequence + 1, {
        audioSequence: String(sequence),
        format: "CONVERSATION_AUDIO_FORMAT_PCM_S16LE",
        sampleRateHz: 48_000,
        channels: 1,
        pcm: new Uint8Array(19_200),
      }));
    }

    const events = await collect(result.value.events);
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      failure: { code: "CONVERSATION_RUNTIME_PROTOCOL_ERROR" },
    });
    expect(call.cancelled).toBe(true);
  });

  it("rejects invalid requests before opening a transport", async () => {
    const factory = new FakeCallFactory();
    const runtime = new GrpcPipecatConversationRuntime({
      address: "127.0.0.1:50052",
      serviceToken: "test-service-token-1234",
      callFactory: factory,
    });
    const result = await runtime.startTurn({ ...request, prompt: "" });
    expect(result).toMatchObject({
      ok: false,
      failure: { code: "CONVERSATION_RUNTIME_INVALID_INPUT", retryable: false },
    });
    expect(factory.calls).toHaveLength(0);
  });

  it("reports a start write failure before exposing a half-open turn", async () => {
    const factory = new FakeCallFactory();
    factory.nextCallWriteError = new Error("injected write failure");
    const runtime = new GrpcPipecatConversationRuntime({
      address: "127.0.0.1:50052",
      serviceToken: "test-service-token-1234",
      callFactory: factory,
    });

    await expect(runtime.startTurn(request)).resolves.toMatchObject({
      ok: false,
      failure: { code: "CONVERSATION_RUNTIME_TRANSPORT_ERROR", retryable: true },
    });
    expect(factory.calls[0]?.cancelled).toBe(true);
  });
});
