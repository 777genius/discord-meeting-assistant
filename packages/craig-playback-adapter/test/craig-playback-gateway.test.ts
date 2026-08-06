import { describe, expect, it, vi } from "vitest";

import type {
  CraigPlaybackCommand,
  CraigPlaybackEvent,
} from "@discord-meeting/craig-gateway-contracts";
import type { ConversationAudioChunk } from "@discord-meeting/meeting-core";

import {
  CraigPlaybackGateway,
  type CraigPlaybackTransport,
} from "../src/index.js";

class FakeTransport implements CraigPlaybackTransport {
  public bufferedBytes = 0;
  public readonly commands: CraigPlaybackCommand[] = [];
  public readonly closes: { code: number; reason: string }[] = [];
  public readonly identity = {
    channelId: "1533228823045214398",
    gatewaySessionId: "gateway-session-1",
    guildId: "1533228590643155034",
    recordingId: "recording-1",
  };
  private closeListener: (reason: string) => void = () => {};
  private eventListener: (event: CraigPlaybackEvent) => void = () => {};

  public close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }

  public onClose(listener: (reason: string) => void): void {
    this.closeListener = listener;
  }

  public onEvent(listener: (event: CraigPlaybackEvent) => void): void {
    this.eventListener = listener;
  }

  public async send(command: CraigPlaybackCommand): Promise<void> {
    this.commands.push(command);
  }

  public emit(event: CraigPlaybackEvent): void {
    this.eventListener(event);
  }

  public disconnect(reason = "test disconnect"): void {
    this.closeListener(reason);
  }
}

class PendingFirstStartTransport extends FakeTransport {
  private startCount = 0;

  public override send(command: CraigPlaybackCommand): Promise<void> {
    this.commands.push(command);
    if (command.type === "playback-start" && this.startCount === 0) {
      this.startCount += 1;
      return new Promise(() => {});
    }
    return Promise.resolve();
  }
}

class PendingCancelTransport extends FakeTransport {
  public override send(command: CraigPlaybackCommand): Promise<void> {
    this.commands.push(command);
    return command.type === "playback-cancel"
      ? new Promise(() => {})
      : Promise.resolve();
  }
}

const request = {
  attemptId: "attempt-1",
  meetingId: "meeting-1",
  recordingId: "recording-1",
  turnId: "turn-1",
} as const;

function chunk(sequence: number, bytes = Uint8Array.of(1, 0, 2, 0)): ConversationAudioChunk {
  return {
    attemptId: request.attemptId,
    bytes,
    channels: 1,
    format: "pcm_s16le",
    sampleRateHz: 48_000,
    sequence,
    turnId: request.turnId,
  };
}

async function collect<Value>(values: AsyncIterable<Value>): Promise<Value[]> {
  const result: Value[] = [];
  for await (const value of values) {
    result.push(value);
  }
  return result;
}

describe("CraigPlaybackGateway", () => {
  it("holds an aborted pending open until its terminal receipt", async () => {
    const gateway = new CraigPlaybackGateway();
    const transport = new PendingFirstStartTransport();
    gateway.register(transport);
    const controller = new AbortController();

    const opening = gateway.open(request, { signal: controller.signal });
    await vi.waitFor(() => {
      expect(transport.commands).toHaveLength(1);
    });
    controller.abort("meeting-ended");

    await expect(
      gateway.open({ ...request, attemptId: "attempt-2", turnId: "turn-2" }),
    ).resolves.toMatchObject({ failure: { code: "CRAIG_PLAYBACK_BUSY" }, ok: false });

    transport.emit({
      schemaVersion: 1,
      type: "playback-finished",
      recordingId: request.recordingId,
      turnId: request.turnId,
      attemptId: request.attemptId,
      finishedAtMs: 5_000,
    });
    await expect(opening).resolves.toMatchObject({
      failure: { code: "CRAIG_PLAYBACK_OPEN_CANCELLED" },
      ok: false,
    });
    await expect(
      gateway.open({ ...request, attemptId: "attempt-2", turnId: "turn-2" }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("holds the playback slot until a terminal receipt when cancellation delivery is pending", async () => {
    const gateway = new CraigPlaybackGateway();
    const transport = new PendingCancelTransport();
    gateway.register(transport);
    const opened = await gateway.open(request);
    if (!opened.ok) {
      throw new Error("playback did not open");
    }

    void opened.value.cancel("barge-in");
    await vi.waitFor(() => {
      expect(transport.commands.at(-1)?.type).toBe("playback-cancel");
    });
    await expect(
      gateway.open({ ...request, attemptId: "attempt-2", turnId: "turn-2" }),
    ).resolves.toMatchObject({ failure: { code: "CRAIG_PLAYBACK_BUSY" }, ok: false });

    transport.emit({
      schemaVersion: 1,
      type: "playback-finished",
      recordingId: request.recordingId,
      turnId: request.turnId,
      attemptId: request.attemptId,
      finishedAtMs: 5_000,
    });
    await expect(
      gateway.open({ ...request, attemptId: "attempt-2", turnId: "turn-2" }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("streams strict start and idempotent sequential PCM commands", async () => {
    const gateway = new CraigPlaybackGateway();
    const transport = new FakeTransport();
    gateway.register(transport);

    const opened = await gateway.open(request);
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      return;
    }
    expect(transport.commands[0]).toEqual({
      schemaVersion: 1,
      type: "playback-start",
      recordingId: "recording-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      format: "pcm_s16le",
      sampleRateHz: 48_000,
      channels: 1,
    });
    await expect(opened.value.write(chunk(0))).resolves.toEqual({
      ok: true,
      value: "accepted",
    });
    await expect(opened.value.write(chunk(0))).resolves.toEqual({
      ok: true,
      value: "reused",
    });
    await expect(opened.value.write(chunk(0, Uint8Array.of(9, 0)))).resolves.toMatchObject({
      ok: false,
      failure: { code: "CRAIG_PLAYBACK_CONFLICTING_CHUNK" },
    });
    expect(transport.commands).toHaveLength(2);
    expect(transport.commands[1]).toMatchObject({
      type: "audio-chunk",
      sequence: 0,
      pcmBase64: "AQACAA==",
    });
  });

  it("paces accepted PCM at playback speed before admitting the next chunk", async () => {
    vi.useFakeTimers();
    try {
      const gateway = new CraigPlaybackGateway();
      const transport = new FakeTransport();
      gateway.register(transport);
      const opened = await gateway.open(request);
      if (!opened.ok) {
        throw new Error("playback did not open");
      }

      let settled = false;
      const writing = opened.value.write(chunk(0, new Uint8Array(19_200))).then(
        (result) => {
          settled = true;
          return result;
        },
      );
      await vi.advanceTimersByTimeAsync(199);
      expect(settled).toBe(false);
      expect(transport.commands.filter(({ type }) => type === "audio-chunk")).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      await expect(writing).resolves.toEqual({ ok: true, value: "accepted" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses local receipt timing for Craig events and waits for finish acknowledgement", async () => {
    let nowMs = 4_000;
    const gateway = new CraigPlaybackGateway(() => nowMs);
    const transport = new FakeTransport();
    gateway.register(transport);
    const opened = await gateway.open(request);
    if (!opened.ok) {
      throw new Error("playback did not open");
    }
    const events = collect(opened.value.events);
    transport.emit({
      schemaVersion: 1,
      type: "playback-started",
      recordingId: request.recordingId,
      turnId: request.turnId,
      attemptId: request.attemptId,
      startedAtMs: 4_000,
    });
    const finish = opened.value.finish();
    await vi.waitFor(() => {
      expect(transport.commands.at(-1)?.type).toBe("playback-finish");
    });
    nowMs = 5_000;
    transport.emit({
      schemaVersion: 1,
      type: "playback-finished",
      recordingId: request.recordingId,
      turnId: request.turnId,
      attemptId: request.attemptId,
      finishedAtMs: 5_000,
    });

    await expect(finish).resolves.toEqual({ ok: true, value: "finished" });
    await expect(events).resolves.toEqual([
      { type: "started", attemptId: "attempt-1", startedAtMs: 4_000 },
      { type: "finished", attemptId: "attempt-1", finishedAtMs: 5_000 },
    ]);
    await expect(opened.value.finish()).resolves.toEqual({ ok: true, value: "reused" });
  });

});

describe("CraigPlaybackGateway terminal deadline", () => {
  it("fails and detaches playback when Craig never sends a terminal receipt", async () => {
    vi.useFakeTimers();
    try {
      const gateway = new CraigPlaybackGateway(() => 1_000, 100);
      const transport = new FakeTransport();
      gateway.register(transport);
      const opened = await gateway.open(request);
      if (!opened.ok) {
        throw new Error("playback did not open");
      }
      const events = collect(opened.value.events);
      const finish = opened.value.finish();
      await vi.advanceTimersByTimeAsync(100);

      await expect(finish).resolves.toMatchObject({
        failure: { code: "CRAIG_PLAYBACK_TERMINAL_TIMEOUT", retryable: true },
        ok: false,
      });
      await expect(events).resolves.toMatchObject([
        { type: "failed", failure: { code: "CRAIG_PLAYBACK_TERMINAL_TIMEOUT" } },
      ]);
      expect(transport.closes).toEqual([{
        code: 1011,
        reason: "playback terminal receipt timed out",
      }]);
      expect(gateway.hasSession(request.recordingId)).toBe(false);

      const replacement = new FakeTransport();
      gateway.register(replacement);
      await expect(gateway.open({
        ...request,
        attemptId: "attempt-2",
        turnId: "turn-2",
      })).resolves.toMatchObject({ ok: true });
      gateway.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CraigPlaybackGateway validation and cancellation", () => {

  it("bounds transport buffering and holds the slot until a terminal cancellation receipt", async () => {
    const gateway = new CraigPlaybackGateway();
    const transport = new FakeTransport();
    transport.bufferedBytes = 191_999;
    gateway.register(transport);
    const opened = await gateway.open(request);
    if (!opened.ok) {
      throw new Error("playback did not open");
    }
    const events = collect(opened.value.events);

    await expect(opened.value.write(chunk(0))).resolves.toMatchObject({
      ok: false,
      failure: { code: "CRAIG_PLAYBACK_BACKPRESSURE", retryable: true },
    });
    expect(transport.commands.at(-1)).toMatchObject({
      type: "playback-cancel",
      reason: "playback-failed",
    });
    transport.emit({
      schemaVersion: 1,
      type: "playback-finished",
      recordingId: request.recordingId,
      turnId: request.turnId,
      attemptId: request.attemptId,
      finishedAtMs: 5_000,
    });
    await expect(events).resolves.toMatchObject([
      { type: "finished", attemptId: request.attemptId },
    ]);
  });

  it("cancels idempotently and ignores late chunks and stale events", async () => {
    const gateway = new CraigPlaybackGateway();
    const transport = new FakeTransport();
    gateway.register(transport);
    const opened = await gateway.open(request);
    if (!opened.ok) {
      throw new Error("playback did not open");
    }

    await expect(opened.value.cancel("barge-in")).resolves.toEqual({
      ok: true,
      value: "cancelled",
    });
    await expect(opened.value.cancel("barge-in")).resolves.toEqual({
      ok: true,
      value: "reused",
    });
    await expect(opened.value.write(chunk(0))).resolves.toMatchObject({
      failure: { code: "CRAIG_PLAYBACK_NOT_WRITABLE" },
      ok: false,
    });
    const events = collect(opened.value.events);
    transport.emit({
      schemaVersion: 1,
      type: "playback-started",
      recordingId: request.recordingId,
      turnId: request.turnId,
      attemptId: request.attemptId,
      startedAtMs: 4_000,
    });
    transport.emit({
      schemaVersion: 1,
      type: "playback-finished",
      recordingId: request.recordingId,
      turnId: request.turnId,
      attemptId: request.attemptId,
      finishedAtMs: 5_000,
    });
    await expect(events).resolves.toMatchObject([
      { type: "finished", attemptId: "attempt-1" },
    ]);
  });

  it("fails an active turn on disconnect and permits a new registered session", async () => {
    const gateway = new CraigPlaybackGateway();
    const original = new FakeTransport();
    gateway.register(original);
    const opened = await gateway.open(request);
    if (!opened.ok) {
      throw new Error("playback did not open");
    }
    const events = collect(opened.value.events);
    original.disconnect("network reset");
    await expect(events).resolves.toMatchObject([
      { type: "failed", failure: { code: "CRAIG_PLAYBACK_DISCONNECTED" } },
    ]);
    await expect(gateway.open(request)).resolves.toMatchObject({
      ok: false,
      failure: { code: "CRAIG_PLAYBACK_UNAVAILABLE" },
    });

    const replacement = new FakeTransport();
    gateway.register(replacement);
    await expect(gateway.open(request)).resolves.toMatchObject({ ok: true });
  });

  it("rejects busy and sequence-gap turns without growing the active slot", async () => {
    const gateway = new CraigPlaybackGateway();
    const transport = new FakeTransport();
    gateway.register(transport);
    const opened = await gateway.open(request);
    if (!opened.ok) {
      throw new Error("playback did not open");
    }
    await expect(gateway.open({ ...request, turnId: "turn-2" })).resolves.toMatchObject({
      ok: false,
      failure: { code: "CRAIG_PLAYBACK_BUSY" },
    });
    await expect(opened.value.write(chunk(1))).resolves.toMatchObject({
      ok: false,
      failure: { code: "CRAIG_PLAYBACK_SEQUENCE_GAP" },
    });
  });
});
