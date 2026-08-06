import {
  craigPlaybackChannels,
  craigPlaybackProtocolVersion,
  craigPlaybackSampleRateHz,
  parseCraigPlaybackCommand,
  type CraigPlaybackCommand,
  type CraigPlaybackEvent,
} from "@discord-meeting/craig-gateway-contracts";
import type {
  ConversationAudioChunk,
  ConversationCancellationReason,
  PortResult,
  StageFailure,
  VoicePlaybackEvent,
  VoicePlaybackRequest,
  VoicePlaybackSession,
} from "@discord-meeting/meeting-core";

import { AsyncEventBuffer } from "./async-event-buffer.js";
import type { CraigPlaybackTransport } from "./craig-playback-gateway.js";
import { PlaybackTerminalDeadline } from "./playback-terminal-deadline.js";
import {
  chunkHash,
  isSignalAborted,
  observedNow,
  playbackFailure as failure,
  playbackOpenCancelled,
  settlePlaybackStart,
  terminalState as isTerminal,
  transportFailure,
} from "./playback-session-results.js";

const maximumBufferedAudioBytes = 192_000;
const maximumRememberedChunkSequences = 100_000;
const pcmBytesPerSecond = craigPlaybackSampleRateHz * craigPlaybackChannels * 2;

export class CraigVoicePlaybackSession implements VoicePlaybackSession {
  public readonly events: AsyncIterable<VoicePlaybackEvent>;
  private readonly eventBuffer = new AsyncEventBuffer<VoicePlaybackEvent>();
  private readonly terminalDeadline: PlaybackTerminalDeadline;
  private readonly chunkHashes = new Map<number, string>();
  private resolveTerminalReceipt!: () => void;
  private readonly terminalReceipt = new Promise<void>((resolve) => {
    this.resolveTerminalReceipt = resolve;
  });
  private cancelPromise: Promise<PortResult<"cancelled" | "reused">> | undefined;
  private expectedSequence = 0;
  private finishPromise: Promise<PortResult<"finished" | "reused">> | undefined;
  private pacingRemainder = 0;
  private resolveFinish:
    | ((result: PortResult<"finished" | "reused">) => void)
    | undefined;
  private state: "starting" | "open" | "finishing" | "cancelling" | "finished" | "failed" =
    "starting";
  private terminalFailure: StageFailure | undefined;

  private readonly nowMilliseconds: () => number;
  private readonly onTerminal: () => void;
  private readonly request: VoicePlaybackRequest;
  private readonly transport: CraigPlaybackTransport;

  public constructor(options: CraigVoicePlaybackSessionOptions) {
    this.request = options.request;
    this.transport = options.transport;
    this.nowMilliseconds = options.nowMilliseconds;
    this.onTerminal = options.onTerminal;
    this.events = this.eventBuffer;
    this.terminalDeadline = new PlaybackTerminalDeadline(
      options.terminalReceiptTimeoutMs,
      () => {
        this.fail({
          code: "CRAIG_PLAYBACK_TERMINAL_TIMEOUT",
          message: "Craig did not confirm playback termination before the deadline",
          retryable: true,
        });
        options.onTerminalTimeout();
      },
    );
  }

  public async start(signal?: AbortSignal): Promise<PortResult<VoicePlaybackSession>> {
    if (isSignalAborted(signal)) {
      this.state = "failed";
      this.complete();
      return playbackOpenCancelled();
    }
    const delivery = await settlePlaybackStart(
      this.send({
        schemaVersion: craigPlaybackProtocolVersion,
        type: "playback-start",
        recordingId: this.request.recordingId,
        turnId: this.request.turnId,
        attemptId: this.request.attemptId,
        format: "pcm_s16le",
        sampleRateHz: craigPlaybackSampleRateHz,
        channels: craigPlaybackChannels,
      }),
      signal,
    );
    if (delivery.status === "aborted" || isSignalAborted(signal)) {
      void this.cancel("superseded");
      await this.terminalReceipt;
      return playbackOpenCancelled();
    }
    if (delivery.status === "failed") {
      const result = transportFailure(delivery.error);
      this.fail(result.failure);
      return result;
    }
    this.state = "open";
    return { ok: true, value: this };
  }

  public async write(
    chunk: ConversationAudioChunk,
  ): Promise<PortResult<"accepted" | "reused">> {
    const identityFailure = this.validateChunkIdentity(chunk);
    if (identityFailure !== undefined) {
      return { ok: false, failure: identityFailure };
    }
    const hash = chunkHash(chunk.bytes);
    if (chunk.sequence < this.expectedSequence) {
      return this.chunkHashes.get(chunk.sequence) === hash
        ? { ok: true, value: "reused" }
        : failure(
            "CRAIG_PLAYBACK_CONFLICTING_CHUNK",
            "A repeated Craig audio sequence contained different PCM",
            false,
          );
    }
    if (this.state !== "open") {
      return isTerminal(this.state)
        ? { ok: true, value: "reused" }
        : failure("CRAIG_PLAYBACK_NOT_WRITABLE", "Craig playback is not writable", false);
    }
    if (chunk.sequence !== this.expectedSequence) {
      return failure(
        "CRAIG_PLAYBACK_SEQUENCE_GAP",
        "Craig playback audio sequence is not contiguous",
        false,
      );
    }
    if (this.chunkHashes.size >= maximumRememberedChunkSequences) {
      const bounded = failure(
        "CRAIG_PLAYBACK_SEQUENCE_LIMIT",
        "Craig playback exceeded its bounded sequence memory",
        false,
      );
      await this.cancelAfterFailure();
      return bounded;
    }
    if (this.transport.bufferedBytes + chunk.bytes.byteLength > maximumBufferedAudioBytes) {
      const backpressure = failure(
        "CRAIG_PLAYBACK_BACKPRESSURE",
        "Craig playback exceeded two seconds of buffered PCM",
        true,
      );
      await this.cancelAfterFailure();
      return backpressure;
    }
    try {
      await this.send({
        schemaVersion: craigPlaybackProtocolVersion,
        type: "audio-chunk",
        recordingId: this.request.recordingId,
        turnId: this.request.turnId,
        attemptId: this.request.attemptId,
        sequence: chunk.sequence,
        pcmBase64: Buffer.from(chunk.bytes).toString("base64"),
      });
      this.chunkHashes.set(chunk.sequence, hash);
      this.expectedSequence += 1;
      await this.pacePcmDelivery(chunk.bytes.byteLength);
      if (!this.isWritable()) {
        return this.terminalFailure === undefined
          ? failure(
              "CRAIG_PLAYBACK_TERMINAL",
              "Craig playback terminated while pacing accepted audio",
              false,
            )
          : { ok: false, failure: this.terminalFailure };
      }
      return { ok: true, value: "accepted" };
    } catch (error) {
      return transportFailure(error);
    }
  }

  public finish(): Promise<PortResult<"finished" | "reused">> {
    if (this.state === "finished") {
      return Promise.resolve({ ok: true, value: "reused" });
    }
    if (this.state === "cancelling" || this.state === "failed") {
      return Promise.resolve(
        failure("CRAIG_PLAYBACK_TERMINAL", "Craig playback is already terminal", false),
      );
    }
    if (this.finishPromise !== undefined) {
      return this.finishPromise;
    }
    this.state = "finishing";
    this.terminalDeadline.arm();
    this.finishPromise = new Promise((resolve) => {
      this.resolveFinish = resolve;
      void this.send({
        schemaVersion: craigPlaybackProtocolVersion,
        type: "playback-finish",
        recordingId: this.request.recordingId,
        turnId: this.request.turnId,
        attemptId: this.request.attemptId,
      }).catch((error: unknown) => {
        this.fail(transportFailure(error).failure);
      });
    });
    return this.finishPromise;
  }

  public cancel(
    reason: ConversationCancellationReason,
  ): Promise<PortResult<"cancelled" | "reused">> {
    if (this.state === "finished" || this.state === "failed") {
      return Promise.resolve({ ok: true, value: "reused" });
    }
    if (this.cancelPromise !== undefined) {
      return Promise.resolve({ ok: true, value: "reused" });
    }

    this.state = "cancelling";
    this.terminalDeadline.arm();
    this.resolveFinish?.(
      failure("CRAIG_PLAYBACK_CANCELLED", "Craig playback was cancelled", false),
    );
    this.cancelPromise = this.send({
      schemaVersion: craigPlaybackProtocolVersion,
      type: "playback-cancel",
      recordingId: this.request.recordingId,
      turnId: this.request.turnId,
      attemptId: this.request.attemptId,
      reason,
    }).then(
      () => ({ ok: true, value: "cancelled" as const }),
      (error: unknown) => {
        const result = transportFailure(error);
        this.fail(result.failure);
        return result;
      },
    );
    return this.cancelPromise;
  }

  public receive(event: Exclude<CraigPlaybackEvent, { type: "session-ready" }>): void {
    if (!this.matches(event) || isTerminal(this.state)) {
      return;
    }
    if (event.type === "playback-started") {
      if (this.state === "cancelling") {
        return;
      }
      this.eventBuffer.push({
        type: "started",
        attemptId: event.attemptId,
        startedAtMs: observedNow(this.nowMilliseconds),
      });
      return;
    }
    if (event.type === "playback-finished") {
      this.state = "finished";
      this.eventBuffer.push({
        type: "finished",
        attemptId: event.attemptId,
        finishedAtMs: observedNow(this.nowMilliseconds),
      });
      this.resolveFinish?.({ ok: true, value: "finished" });
      this.complete();
      return;
    }
    this.fail({
      code: `CRAIG_${event.code.toUpperCase().replaceAll("-", "_")}`,
      message: event.safeMessage,
      retryable: event.retryable,
    });
  }

  public transportDisconnected(reason: string): void {
    this.fail({
      code: "CRAIG_PLAYBACK_DISCONNECTED",
      message: `Craig playback transport disconnected: ${reason}`,
      retryable: true,
    });
  }

  private validateChunkIdentity(chunk: ConversationAudioChunk): StageFailure | undefined {
    if (
      chunk.turnId !== this.request.turnId ||
      chunk.attemptId !== this.request.attemptId
    ) {
      return {
        code: "CRAIG_PLAYBACK_STALE_CHUNK",
        message: "Craig playback rejected audio from a stale turn attempt",
        retryable: false,
      };
    }
    return undefined;
  }

  private matches(event: Exclude<CraigPlaybackEvent, { type: "session-ready" }>): boolean {
    return event.recordingId === this.request.recordingId &&
      event.turnId === this.request.turnId &&
      event.attemptId === this.request.attemptId;
  }

  private cancelAfterFailure(): Promise<void> {
    void this.cancel("playback-failed");
    return Promise.resolve();
  }

  private send(command: CraigPlaybackCommand): Promise<void> {
    return this.transport.send(parseCraigPlaybackCommand(command));
  }

  private fail(stageFailure: StageFailure): void {
    if (isTerminal(this.state)) {
      return;
    }
    this.state = "failed";
    this.terminalFailure = stageFailure;
    this.eventBuffer.push({
      type: "failed",
      attemptId: this.request.attemptId,
      failure: stageFailure,
    });
    this.resolveFinish?.({ ok: false, failure: stageFailure });
    this.complete();
  }

  private complete(): void {
    this.terminalDeadline.clear();
    this.eventBuffer.close();
    this.resolveTerminalReceipt();
    this.onTerminal();
  }

  private async pacePcmDelivery(byteLength: number): Promise<void> {
    const durationNumerator = this.pacingRemainder + byteLength * 1_000;
    const durationMs = Math.floor(durationNumerator / pcmBytesPerSecond);
    this.pacingRemainder = durationNumerator % pcmBytesPerSecond;
    if (durationMs <= 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, durationMs);
    });
  }

  private isWritable(): boolean {
    return this.state === "open";
  }
}

interface CraigVoicePlaybackSessionOptions {
  readonly nowMilliseconds: () => number;
  readonly onTerminal: () => void;
  readonly onTerminalTimeout: () => void;
  readonly request: VoicePlaybackRequest;
  readonly terminalReceiptTimeoutMs: number;
  readonly transport: CraigPlaybackTransport;
}
