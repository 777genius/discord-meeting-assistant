import { VoicetextAdapterError } from "./errors.js";
import {
  asLiveSessionError,
  createLiveSessionDeferred,
  rememberLiveSessionPacketId,
  requireLiveSessionActive,
  stableLiveSessionUuid,
  validateLiveSessionFinalizeStatus,
  validateLiveSessionPacket,
  withLiveSessionTimeout,
  type LiveSessionDeferred,
} from "./voicetext-live-session-primitives.js";
import {
  createVoicetextLiveOperationSignal,
  validateVoicetextLiveIdentity,
  type OpenVoicetextLiveSessionRequest,
  type ValidatedVoicetextLiveTranscriptionOptions,
  type VoicetextLivePacket,
  type VoicetextLiveSession,
} from "./voicetext-live-transcription-configuration.js";
import {
  parseServerMessage,
  type VoicetextConfigMessage,
  type VoicetextFinalizeComplete,
} from "./protocol.js";
import { VoicetextLiveTimeline } from "./voicetext-live-timeline.js";
import { VoicetextLiveTranscriptEmitter } from "./voicetext-live-transcript-emitter.js";
import type { VoicetextWebSocketConnection } from "./websocket-connector.js";

const maximumOutstandingPacketAcks = 256;

export class LiveSession implements VoicetextLiveSession {
  private readonly ackWaiters = new Map<number, LiveSessionDeferred<void>>();
  private readonly abortController = new AbortController();
  private readonly packetIds = new Set<string>();
  private readonly packetIdOrder: string[] = [];
  private finalizeWaiter: LiveSessionDeferred<VoicetextFinalizeComplete> | undefined;
  private finalizePromise: Promise<void> | undefined;
  private finalizeResultReceived = false;
  private closeState: "failed" | "idle" | "initiated" = "idle";
  private readonly closeWaiter = createLiveSessionDeferred<void>();
  private nextSequence = 0;
  private pump: Promise<void> | undefined;
  private sending = false;
  private state: "active" | "closed" | "finalizing" | "opening" = "opening";
  private terminalError: unknown;
  private readonly timeline = new VoicetextLiveTimeline();
  private readonly transcriptEmitter: VoicetextLiveTranscriptEmitter;
  private transportClosed = false;

  public constructor(
    private readonly socket: VoicetextWebSocketConnection,
    private readonly request: OpenVoicetextLiveSessionRequest,
    private readonly options: ValidatedVoicetextLiveTranscriptionOptions,
  ) {
    this.transcriptEmitter = new VoicetextLiveTranscriptEmitter(request, this.timeline);
    request.signal?.addEventListener("abort", () => {
      this.terminate();
    }, { once: true });
  }

  public async start(): Promise<void> {
    const config: VoicetextConfigMessage = {
      capabilities: ["finalize_ack"],
      channels: 1,
      client_session_id: stableLiveSessionUuid(
        this.request.idempotencyKey,
        this.request.meetingId,
        this.request.speakerId,
      ),
      encoding: "opus",
      ...(this.options.keyterms.length === 0 ? {} : { keyterms: this.options.keyterms }),
      language: this.options.language,
      model: this.options.identity.model,
      protocol_v: 2,
      provider: this.options.identity.provider,
      sample_rate: 48_000,
      type: "config",
    };
    await this.socket.sendText(JSON.stringify(config), this.abortController.signal);
    const readySignal = createVoicetextLiveOperationSignal(
      this.request.signal,
      this.options.readyTimeoutMs,
    );
    for (;;) {
      const frame = await this.socket.receive(readySignal);
      if (frame.type === "close") {
        throw new VoicetextAdapterError(
          "transport_error",
          "Voicetext closed before the live session became ready",
          true,
        );
      }
      if (frame.type !== "text") {
        throw new VoicetextAdapterError(
          "protocol_error",
          "Voicetext returned a binary live protocol frame",
          false,
        );
      }
      const message = parseServerMessage(
        frame.data,
        this.options.maxTranscriptCharsPerSegment,
        this.options.identity,
      );
      if (message.type === "ready") {
        break;
      }
      if (message.type === "error") {
        throw new VoicetextAdapterError("provider_error", message.message, true);
      }
      if (message.type !== "usage_update" && message.type !== "partial") {
        throw new VoicetextAdapterError(
          "protocol_error",
          "Voicetext sent " + message.type + " before live ready",
          false,
        );
      }
    }
    this.state = "active";
    this.pump = this.receiveLoop();
  }

  public async sendPacket(packet: VoicetextLivePacket): Promise<"accepted" | "reused"> {
    requireLiveSessionActive(this.state);
    validateVoicetextLiveIdentity(packet.packetId, "packetId");
    if (this.packetIds.has(packet.packetId)) {
      return "reused";
    }
    validateLiveSessionPacket(packet);
    if (this.sending) {
      throw new VoicetextAdapterError(
        "protocol_error",
        "Concurrent live packet sends are not supported",
        false,
      );
    }
    this.sending = true;
    try {
      await this.waitForAckCapacity();
      requireLiveSessionActive(this.state);
      const sequence = this.nextSequence + 1;
      const waiter = createLiveSessionDeferred<void>();
      this.ackWaiters.set(sequence, waiter);
      const timelineCheckpoint = this.timeline.checkpoint();
      try {
        this.timeline.reserve(packet.relativeTimeMs, packet.durationSamples48Khz);
        await this.socket.sendBinary(packet.opus, this.abortController.signal);
        this.nextSequence = sequence;
        rememberLiveSessionPacketId(this.packetIds, this.packetIdOrder, packet.packetId);
        return "accepted";
      } catch (error) {
        this.ackWaiters.delete(sequence);
        this.timeline.restore(timelineCheckpoint);
        throw error;
      }
    } finally {
      this.sending = false;
    }
  }

  public finalize(): Promise<void> {
    if (this.finalizePromise !== undefined) {
      return this.finalizePromise;
    }
    if (this.state === "closed") {
      return this.terminalError === undefined
        ? Promise.resolve()
        : Promise.reject(this.terminalError);
    }
    requireLiveSessionActive(this.state);
    if (this.sending) {
      return Promise.reject(new VoicetextAdapterError(
        "protocol_error",
        "Cannot finalize while a live packet is in flight",
        false,
      ));
    }
    this.state = "finalizing";
    const operation = this.finalizeOnce();
    this.finalizePromise = operation;
    return operation;
  }

  public terminate(): void {
    if (this.state !== "closed") {
      this.state = "closed";
      const error = new VoicetextAdapterError(
        "cancelled",
        "Voicetext live session was terminated",
        true,
      );
      this.rejectOutstanding(error);
      this.abortController.abort(error);
    }
    if (!this.transportClosed) {
      this.socket.terminate();
      this.transportClosed = true;
    }
  }

  private async finalizeOnce(): Promise<void> {
    let failure: unknown;
    try {
      await this.waitForOutstandingAcks();
      await withLiveSessionTimeout(
        this.finalizeProviderAndClose(),
        this.options.finalizeTimeoutMs,
        "Voicetext live finalize timed out before the terminal close boundary",
      );
    } catch (error) {
      failure = error;
    } finally {
      if (this.closeState === "idle") {
        await this.closeAfterFailure();
      }
      if (this.closeState === "failed" || !this.transportClosed) {
        this.socket.terminate();
        this.transportClosed = true;
      }
      this.state = "closed";
      this.abortController.abort(failure);
      await this.pump?.catch(() => {});
    }
    if (failure !== undefined) {
      throw asLiveSessionError(failure, "Voicetext live session finalization failed");
    }
  }

  private async finalizeProviderAndClose(): Promise<void> {
    if (this.state !== "finalizing") {
      throw new VoicetextAdapterError(
        "cancelled",
        "Voicetext live session finalization was cancelled",
        true,
      );
    }
    this.finalizeWaiter = createLiveSessionDeferred();
    await this.socket.sendText(JSON.stringify({ type: "finalize" }), this.abortController.signal);
    const result = await this.finalizeWaiter.promise;
    let terminalFailure: unknown;
    try {
      validateLiveSessionFinalizeStatus(result, this.nextSequence);
    } catch (error) {
      terminalFailure = error;
    }
    await this.closeTransport();
    if (this.terminalError !== undefined) {
      throw this.terminalError;
    }
    if (terminalFailure !== undefined) {
      throw terminalFailure;
    }
  }

  private async closeTransport(): Promise<void> {
    // The ordered transport close proves terminal quiescence.
    this.closeState = "initiated";
    await this.socket.sendText(JSON.stringify({ type: "close" }), this.abortController.signal);
    try {
      await Promise.all([
        this.socket.close(1_000, "finalized"),
        this.closeWaiter.promise,
      ]);
    } catch (error) {
      this.closeState = "failed";
      throw error;
    }
  }

  private async closeAfterFailure(): Promise<void> {
    this.closeState = "initiated";
    try {
      await this.socket.sendText(JSON.stringify({ type: "close" }), this.abortController.signal);
      await this.socket.close(1_000, "finalized");
    } catch {
      this.closeState = "failed";
    }
  }

  private async receiveLoop(): Promise<void> {
    try {
      while (this.state === "active" || this.state === "finalizing") {
        const frame = await this.socket.receive(this.abortController.signal);
        if (frame.type === "close") {
          this.transportClosed = true;
          if (this.closeState !== "idle" && this.finalizeResultReceived) {
            this.state = "closed";
            this.closeWaiter.resolve();
            return;
          }
          throw new VoicetextAdapterError(
            "transport_error",
            "Voicetext closed live session with code " + frame.code,
            true,
          );
        }
        if (frame.type !== "text") {
          throw new VoicetextAdapterError(
            "protocol_error",
            "Voicetext returned a binary live protocol frame",
            false,
          );
        }
        this.handleServerMessage(parseServerMessage(
          frame.data,
          this.options.maxTranscriptCharsPerSegment,
          this.options.identity,
        ));
      }
    } catch (error) {
      this.closeAfterReceiveFailure(error);
    }
  }

  private handleServerMessage(message: ReturnType<typeof parseServerMessage>): void {
    if (message.type === "ack") {
      const waiter = this.ackWaiters.get(message.seq);
      if (waiter === undefined) {
        throw new VoicetextAdapterError(
          "protocol_error",
          "Voicetext acknowledged an unexpected live packet",
          false,
        );
      }
      this.ackWaiters.delete(message.seq);
      waiter.resolve();
      return;
    }
    if (message.type === "partial" && message.segment !== null) {
      this.transcriptEmitter.emit(message.segment, false);
      return;
    }
    if (message.type === "final" || message.type === "segment_final") {
      this.transcriptEmitter.emit(message, true);
      return;
    }
    if (message.type === "finalize_complete") {
      if (this.state !== "finalizing" || this.finalizeWaiter === undefined) {
        throw new VoicetextAdapterError(
          "protocol_error",
          "Voicetext sent finalize_complete outside live finalization",
          false,
        );
      }
      if (this.finalizeResultReceived) {
        throw new VoicetextAdapterError(
          "protocol_error",
          "Voicetext sent duplicate live finalize terminal evidence",
          false,
        );
      }
      this.finalizeResultReceived = true;
      this.finalizeWaiter.resolve(message);
      return;
    }
    if (message.type === "error") {
      throw new VoicetextAdapterError("provider_error", message.message, true);
    }
    if (message.type !== "usage_update" && message.type !== "resumed") {
      throw new VoicetextAdapterError(
        "protocol_error",
        "Voicetext sent unexpected " + message.type + " during live streaming",
        false,
      );
    }
  }

  private closeAfterReceiveFailure(error: unknown): void {
    if (this.state === "closed") {
      return;
    }
    this.terminalError = error;
    this.state = "closed";
    this.rejectOutstanding(error);
    if (!this.transportClosed) {
      this.socket.terminate();
      this.transportClosed = true;
    }
  }

  private rejectOutstanding(error: unknown): void {
    const acknowledgements = [...this.ackWaiters.values()];
    this.ackWaiters.clear();
    const finalizeWaiter = this.finalizeWaiter;
    this.finalizeWaiter = undefined;
    for (const waiter of acknowledgements) {
      waiter.reject(error);
    }
    finalizeWaiter?.reject(error);
    this.closeWaiter.reject(error);
  }

  private async waitForAckCapacity(): Promise<void> {
    if (this.ackWaiters.size < maximumOutstandingPacketAcks) {
      return;
    }
    const oldest = this.ackWaiters.values().next().value;
    if (oldest !== undefined) {
      await withLiveSessionTimeout(
        oldest.promise,
        this.options.audioAckTimeoutMs,
        "Voicetext live packet acknowledgement timed out",
      );
    }
  }

  private async waitForOutstandingAcks(): Promise<void> {
    if (this.ackWaiters.size === 0) {
      return;
    }
    await withLiveSessionTimeout(
      Promise.all([...this.ackWaiters.values()].map(({ promise }) => promise)),
      this.options.audioAckTimeoutMs,
      "Voicetext live packet acknowledgement timed out",
    );
  }

}
