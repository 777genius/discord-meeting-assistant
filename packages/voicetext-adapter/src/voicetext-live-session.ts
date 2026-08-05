import { VoicetextAdapterError } from "./errors.js";
import {
  asLiveSessionError,
  createLiveSessionDeferred,
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
  type VoicetextFinalSegment,
  type VoicetextPartialSegment,
} from "./protocol.js";
import type { VoicetextWebSocketConnection } from "./websocket-connector.js";

const maximumOutstandingPacketAcks = 256;
const maximumRememberedPacketIds = 4_096;

interface TimelineAnchor {
  readonly providerStartSamples: number;
  readonly sourceStartSamples: number;
}

export class LiveSession implements VoicetextLiveSession {
  private readonly ackWaiters = new Map<number, LiveSessionDeferred<void>>();
  private readonly abortController = new AbortController();
  private readonly finalFingerprints = new Set<string>();
  private readonly packetIds = new Set<string>();
  private readonly packetIdOrder: string[] = [];
  private finalizeWaiter: LiveSessionDeferred<"flushed" | "no_provider" | "timeout"> | undefined;
  private finalizePromise: Promise<void> | undefined;
  private nextSequence = 0;
  private providerCursorSamples = 0;
  private pump: Promise<void> | undefined;
  private sending = false;
  private sourceCursorSamples: number | undefined;
  private state: "active" | "closed" | "finalizing" | "opening" = "opening";
  private terminalError: unknown;
  private readonly timelineAnchors: TimelineAnchor[] = [];
  private transportClosed = false;

  public constructor(
    private readonly socket: VoicetextWebSocketConnection,
    private readonly request: OpenVoicetextLiveSessionRequest,
    private readonly options: ValidatedVoicetextLiveTranscriptionOptions,
  ) {
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
      protocol_v: 2,
      provider: "deepgram",
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
    this.requireActive();
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
      this.requireActive();
      const sequence = this.nextSequence + 1;
      const waiter = createLiveSessionDeferred<void>();
      this.ackWaiters.set(sequence, waiter);
      const priorProviderCursorSamples = this.providerCursorSamples;
      const priorSourceCursorSamples = this.sourceCursorSamples;
      const priorAnchorCount = this.timelineAnchors.length;
      try {
        this.reserveTimeline(packet.relativeTimeMs, packet.durationSamples48Khz);
        await this.socket.sendBinary(packet.opus, this.abortController.signal);
        this.nextSequence = sequence;
        this.rememberPacketId(packet.packetId);
        return "accepted";
      } catch (error) {
        this.ackWaiters.delete(sequence);
        this.providerCursorSamples = priorProviderCursorSamples;
        this.sourceCursorSamples = priorSourceCursorSamples;
        this.timelineAnchors.length = priorAnchorCount;
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
    this.requireActive();
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
    const finalizeError = await this.finalizeProvider();
    const closeError = await this.closeTransport();
    if (finalizeError !== undefined) {
      throw asLiveSessionError(finalizeError, "Voicetext live session finalization failed");
    }
    if (closeError !== undefined) {
      throw asLiveSessionError(closeError, "Voicetext live session close failed");
    }
  }

  private async finalizeProvider(): Promise<unknown> {
    try {
      await this.waitForOutstandingAcks();
      if (this.state !== "finalizing") {
        throw new VoicetextAdapterError(
          "cancelled",
          "Voicetext live session finalization was cancelled",
          true,
        );
      }
      this.finalizeWaiter = createLiveSessionDeferred();
      await this.socket.sendText(JSON.stringify({ type: "finalize" }), this.abortController.signal);
      const status = await withLiveSessionTimeout(
        this.finalizeWaiter.promise,
        this.options.finalizeTimeoutMs,
        "Voicetext live finalize timed out",
      );
      validateLiveSessionFinalizeStatus(status, this.nextSequence);
    } catch (error) {
      return error;
    }
    return undefined;
  }

  private async closeTransport(): Promise<unknown> {
    let closeError: unknown;
    try {
      await this.socket.sendText(JSON.stringify({ type: "close" }), this.abortController.signal);
    } catch (error) {
      closeError = error;
    }
    this.state = "closed";
    try {
      await this.socket.close(1_000, "finalized");
      this.transportClosed = true;
    } catch (error) {
      closeError ??= error;
    } finally {
      this.abortController.abort();
      await this.pump?.catch(() => {});
      if (closeError !== undefined || !this.transportClosed) {
        this.socket.terminate();
        this.transportClosed = true;
      }
    }
    return closeError;
  }

  private async receiveLoop(): Promise<void> {
    try {
      while (this.state === "active" || this.state === "finalizing") {
        const frame = await this.socket.receive(this.abortController.signal);
        if (frame.type === "close") {
          this.transportClosed = true;
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
      this.emitSegment(message.segment, false);
      return;
    }
    if (message.type === "final" || message.type === "segment_final") {
      this.emitSegment(message, true);
      return;
    }
    if (message.type === "finalize_complete") {
      this.finalizeWaiter?.resolve(message.status);
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

  private emitSegment(
    segment: VoicetextFinalSegment | VoicetextPartialSegment,
    isFinal: boolean,
  ): void {
    const text = segment.text.trim();
    if (text.length === 0 || this.timelineAnchors.length === 0) {
      return;
    }
    if (isFinal && !this.rememberFinalSegment(segment, text)) {
      return;
    }
    try {
      this.request.onTranscript({
        ...(segment.confidence === undefined ? {} : { confidence: segment.confidence }),
        endMs: this.mapProviderTimeToSource(segment.startMs + segment.durationMs, "end"),
        isFinal,
        meetingId: this.request.meetingId,
        speakerId: this.request.speakerId,
        startMs: this.mapProviderTimeToSource(segment.startMs, "start"),
        text,
      });
    } catch {
      // Observer failures must not corrupt the provider receive loop.
    }
  }

  private rememberFinalSegment(
    segment: VoicetextFinalSegment | VoicetextPartialSegment,
    text: string,
  ): boolean {
    const fingerprint = segment.startMs + "\0" + segment.durationMs + "\0" + text;
    if (this.finalFingerprints.has(fingerprint)) {
      return false;
    }
    this.finalFingerprints.add(fingerprint);
    return true;
  }

  private reserveTimeline(relativeTimeMs: number, durationSamples48Khz: number): void {
    const sourceStartSamples = relativeTimeMs * 48;
    if (
      this.sourceCursorSamples === undefined ||
      sourceStartSamples !== this.sourceCursorSamples
    ) {
      this.timelineAnchors.push({
        providerStartSamples: this.providerCursorSamples,
        sourceStartSamples,
      });
    }
    const nextProviderCursorSamples = this.providerCursorSamples + durationSamples48Khz;
    if (!Number.isSafeInteger(nextProviderCursorSamples)) {
      throw new VoicetextAdapterError(
        "limit_exceeded",
        "Live provider timeline exceeds the safe integer range",
        false,
      );
    }
    this.providerCursorSamples = nextProviderCursorSamples;
    this.sourceCursorSamples = sourceStartSamples + durationSamples48Khz;
  }

  private mapProviderTimeToSource(providerTimeMs: number, boundary: "end" | "start"): number {
    const providerTimeSamples = providerTimeMs * 48;
    if (!Number.isSafeInteger(providerTimeSamples)) {
      throw new VoicetextAdapterError(
        "protocol_error",
        "Live provider timeline exceeds the safe integer range",
        false,
      );
    }
    let lower = 0;
    let upper = this.timelineAnchors.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      const anchor = this.timelineAnchors[middle];
      if (anchor === undefined) {
        throw new VoicetextAdapterError("protocol_error", "Live timeline anchor is missing", false);
      }
      const belongsToAnchor = boundary === "start"
        ? anchor.providerStartSamples <= providerTimeSamples
        : anchor.providerStartSamples < providerTimeSamples;
      if (belongsToAnchor) {
        lower = middle + 1;
      } else {
        upper = middle;
      }
    }
    const anchor = this.timelineAnchors[Math.max(0, lower - 1)];
    if (anchor === undefined) {
      throw new VoicetextAdapterError("protocol_error", "Live timeline anchor is missing", false);
    }
    return Math.round(
      (anchor.sourceStartSamples + providerTimeSamples - anchor.providerStartSamples) / 48,
    );
  }

  private rememberPacketId(packetId: string): void {
    this.packetIds.add(packetId);
    this.packetIdOrder.push(packetId);
    if (this.packetIdOrder.length > maximumRememberedPacketIds) {
      const evicted = this.packetIdOrder.shift();
      if (evicted !== undefined) {
        this.packetIds.delete(evicted);
      }
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

  private requireActive(): void {
    if (this.state !== "active") {
      throw new VoicetextAdapterError("protocol_error", "Live session is not active", false);
    }
  }
}
