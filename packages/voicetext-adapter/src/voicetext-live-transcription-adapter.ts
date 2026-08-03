import { createHash } from "node:crypto";

import { VoicetextAdapterError } from "./errors.js";
import {
  parseServerMessage,
  type VoicetextConfigMessage,
  type VoicetextFinalSegment,
  type VoicetextPartialSegment,
} from "./protocol.js";
import type {
  VoicetextWebSocketConnection,
  VoicetextWebSocketConnector,
} from "./websocket-connector.js";
import { WsVoicetextWebSocketConnector } from "./ws-websocket-connector.js";

const maximumOpusPacketBytes = 65_536;
const maximumOutstandingPacketAcks = 256;
const maximumRememberedPacketIds = 4_096;

export interface VoicetextLiveTranscriptEvent {
  readonly confidence?: number;
  readonly endMs: number;
  readonly isFinal: boolean;
  readonly meetingId: string;
  readonly speakerId: string;
  readonly startMs: number;
  readonly text: string;
}

export interface VoicetextLivePacket {
  readonly durationSamples48Khz: number;
  readonly opus: Uint8Array;
  readonly packetId: string;
  readonly relativeTimeMs: number;
}

export interface OpenVoicetextLiveSessionRequest {
  readonly idempotencyKey: string;
  readonly meetingId: string;
  readonly onTranscript: (event: VoicetextLiveTranscriptEvent) => void;
  readonly signal?: AbortSignal;
  readonly speakerId: string;
}

export interface VoicetextLiveSession {
  finalize(): Promise<void>;
  sendPacket(packet: VoicetextLivePacket): Promise<"accepted" | "reused">;
  terminate(): void;
}

export interface VoicetextLiveTranscriptionOptions {
  readonly audioAckTimeoutMs?: number;
  readonly endpoint: string;
  readonly finalizeTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly keyterms?: readonly string[];
  readonly language?: string;
  readonly maxInboundFrameBytes?: number;
  readonly maxTranscriptCharsPerSegment?: number;
  readonly readyTimeoutMs?: number;
  readonly token: string;
}

interface ValidatedOptions {
  readonly audioAckTimeoutMs: number;
  readonly authorization: string;
  readonly endpoint: URL;
  readonly finalizeTimeoutMs: number;
  readonly handshakeTimeoutMs: number;
  readonly keyterms: readonly string[];
  readonly language: string;
  readonly maxInboundFrameBytes: number;
  readonly maxTranscriptCharsPerSegment: number;
  readonly readyTimeoutMs: number;
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: Value) => void;
}

interface TimelineAnchor {
  readonly providerStartSamples: number;
  readonly sourceStartSamples: number;
}

function deferred<Value>(): Deferred<Value> {
  let resolveDeferred!: (value: Value) => void;
  let rejectDeferred!: (error: unknown) => void;
  const promise = new Promise<Value>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  // Packet acknowledgements are intentionally consumed later, during
  // backpressure or finalization. Attach a rejection observer immediately so
  // a transport failure cannot surface as an unhandled rejection in between.
  void promise.catch(() => {});
  return { promise, reject: rejectDeferred, resolve: resolveDeferred };
}

export class VoicetextLiveTranscriptionAdapter {
  private readonly options: ValidatedOptions;

  public constructor(
    options: VoicetextLiveTranscriptionOptions,
    private readonly connector: VoicetextWebSocketConnector = new WsVoicetextWebSocketConnector(),
  ) {
    this.options = validateOptions(options);
  }

  public async openSession(
    request: OpenVoicetextLiveSessionRequest,
  ): Promise<VoicetextLiveSession> {
    validateIdentity(request.meetingId, "meetingId");
    validateIdentity(request.speakerId, "speakerId");
    validateIdentity(request.idempotencyKey, "idempotencyKey");
    request.signal?.throwIfAborted();
    const connectSignal = operationSignal(request.signal, this.options.handshakeTimeoutMs);
    const socket = await this.connector.connect({
      authorization: this.options.authorization,
      endpoint: this.options.endpoint,
      handshakeTimeoutMs: this.options.handshakeTimeoutMs,
      maxInboundFrameBytes: this.options.maxInboundFrameBytes,
      signal: connectSignal,
    });
    const session = new LiveSession(socket, request, this.options);
    try {
      await session.start();
      return session;
    } catch (error) {
      socket.terminate();
      throw error;
    }
  }
}

class LiveSession implements VoicetextLiveSession {
  private readonly ackWaiters = new Map<number, Deferred<void>>();
  private readonly abortController = new AbortController();
  private readonly finalFingerprints = new Set<string>();
  private readonly packetIds = new Set<string>();
  private readonly packetIdOrder: string[] = [];
  private finalizeWaiter: Deferred<"flushed" | "no_provider" | "timeout"> | undefined;
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
    private readonly options: ValidatedOptions,
  ) {
    request.signal?.addEventListener("abort", () => {
      this.terminate();
    }, { once: true });
  }

  public async start(): Promise<void> {
    const config: VoicetextConfigMessage = {
      capabilities: ["finalize_ack"],
      channels: 1,
      client_session_id: stableUuid(
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
    const readySignal = operationSignal(this.request.signal, this.options.readyTimeoutMs);
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
          `Voicetext sent ${message.type} before live ready`,
          false,
        );
      }
    }
    this.state = "active";
    this.pump = this.receiveLoop();
  }

  public async sendPacket(packet: VoicetextLivePacket): Promise<"accepted" | "reused"> {
    this.requireActive();
    validateIdentity(packet.packetId, "packetId");
    if (this.packetIds.has(packet.packetId)) {
      return "reused";
    }
    if (
      !Number.isSafeInteger(packet.relativeTimeMs) ||
      packet.relativeTimeMs < 0 ||
      !Number.isSafeInteger(packet.relativeTimeMs * 48) ||
      !Number.isSafeInteger(packet.durationSamples48Khz) ||
      packet.durationSamples48Khz < 120 ||
      packet.durationSamples48Khz > 5_760 ||
      packet.durationSamples48Khz % 120 !== 0 ||
      packet.opus.byteLength === 0 ||
      packet.opus.byteLength > maximumOpusPacketBytes
    ) {
      throw new VoicetextAdapterError("invalid_input", "Live Opus packet is invalid", false);
    }
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
      const waiter = deferred<void>();
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

  private async finalizeOnce(): Promise<void> {
    let finalizeError: unknown;
    try {
      await this.waitForOutstandingAcks();
      if (this.state !== "finalizing") {
        throw new VoicetextAdapterError(
          "cancelled",
          "Voicetext live session finalization was cancelled",
          true,
        );
      }
      this.finalizeWaiter = deferred();
      await this.socket.sendText(JSON.stringify({ type: "finalize" }), this.abortController.signal);
      const status = await withTimeout(
        this.finalizeWaiter.promise,
        this.options.finalizeTimeoutMs,
        "Voicetext live finalize timed out",
      );
      if (status === "timeout") {
        throw new VoicetextAdapterError(
          "provider_error",
          "Voicetext live finalize completed with timeout",
          true,
        );
      }
      if (status === "no_provider" && this.nextSequence > 0) {
        throw new VoicetextAdapterError(
          "provider_error",
          "Voicetext did not create a provider session for acknowledged audio",
          true,
        );
      }
      // `no_provider` is successful only for a genuinely empty session.
    } catch (error) {
      finalizeError = error;
    }

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
    if (finalizeError !== undefined) {
      throw asThrownError(finalizeError, "Voicetext live session finalization failed");
    }
    if (closeError !== undefined) {
      throw asThrownError(closeError, "Voicetext live session close failed");
    }
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

  private async receiveLoop(): Promise<void> {
    try {
      while (this.state === "active" || this.state === "finalizing") {
        const frame = await this.socket.receive(this.abortController.signal);
        if (frame.type === "close") {
          this.transportClosed = true;
          throw new VoicetextAdapterError(
            "transport_error",
            `Voicetext closed live session with code ${frame.code}`,
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
        } else if (message.type === "partial" && message.segment !== null) {
          this.emitSegment(message.segment, false);
        } else if (message.type === "final" || message.type === "segment_final") {
          this.emitSegment(message, true);
        } else if (message.type === "finalize_complete") {
          this.finalizeWaiter?.resolve(message.status);
        } else if (message.type === "error") {
          throw new VoicetextAdapterError("provider_error", message.message, true);
        } else if (
          message.type !== "usage_update" &&
          message.type !== "resumed"
        ) {
          throw new VoicetextAdapterError(
            "protocol_error",
            `Voicetext sent unexpected ${message.type} during live streaming`,
            false,
          );
        }
      }
    } catch (error) {
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
  }

  private emitSegment(
    segment: VoicetextFinalSegment | VoicetextPartialSegment,
    isFinal: boolean,
  ): void {
    const text = segment.text.trim();
    if (text.length === 0 || this.timelineAnchors.length === 0) {
      return;
    }
    if (isFinal) {
      const fingerprint = `${segment.startMs}\0${segment.durationMs}\0${text}`;
      if (this.finalFingerprints.has(fingerprint)) {
        return;
      }
      this.finalFingerprints.add(fingerprint);
    }
    try {
      this.request.onTranscript({
        ...(segment.confidence === undefined ? {} : { confidence: segment.confidence }),
        endMs: this.mapProviderTimeToSource(
          segment.startMs + segment.durationMs,
          "end",
        ),
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
      await withTimeout(
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
    await withTimeout(
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

function asThrownError(error: unknown, fallbackMessage: string): Error {
  return error instanceof Error ? error : new Error(fallbackMessage, { cause: error });
}

function validateOptions(options: VoicetextLiveTranscriptionOptions): ValidatedOptions {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== "wss:" && endpoint.protocol !== "ws:") {
    throw new VoicetextAdapterError("invalid_input", "Voicetext endpoint must use WebSocket", false);
  }
  const token = options.token.trim();
  if (token.length < 16 || /\s/u.test(token)) {
    throw new VoicetextAdapterError("invalid_input", "Voicetext token is malformed", false);
  }
  const language = options.language?.trim();
  return {
    audioAckTimeoutMs: integerOption(options.audioAckTimeoutMs, 10_000, 100, 120_000),
    authorization: `Bearer ${token}`,
    endpoint,
    finalizeTimeoutMs: integerOption(options.finalizeTimeoutMs, 30_000, 100, 300_000),
    handshakeTimeoutMs: integerOption(options.handshakeTimeoutMs, 10_000, 100, 120_000),
    keyterms: [...new Set((options.keyterms ?? []).map((value) => value.trim()).filter(Boolean))],
    language: language === undefined || language.length === 0 ? "ru" : language,
    maxInboundFrameBytes: integerOption(
      options.maxInboundFrameBytes,
      256 * 1_024,
      1_024,
      4 * 1_024 * 1_024,
    ),
    maxTranscriptCharsPerSegment: integerOption(
      options.maxTranscriptCharsPerSegment,
      8_192,
      64,
      65_536,
    ),
    readyTimeoutMs: integerOption(options.readyTimeoutMs, 15_000, 100, 120_000),
  };
}

function integerOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new VoicetextAdapterError("invalid_input", "Live option is outside its bound", false);
  }
  return candidate;
}

function validateIdentity(value: string, field: string): void {
  if (value.trim().length === 0 || value.length > 1_024 || value.includes("\0")) {
    throw new VoicetextAdapterError("invalid_input", `${field} is invalid`, false);
  }
}

function operationSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent === undefined ? timeout : AbortSignal.any([parent, timeout]);
}

async function withTimeout<Value>(
  promise: Promise<Value>,
  timeoutMs: number,
  message: string,
): Promise<Value> {
  const timeout = deferred<Value>();
  const handle = setTimeout(() => {
    timeout.reject(new VoicetextAdapterError("timeout", message, true));
  }, timeoutMs);
  try {
    return await Promise.race([promise, timeout.promise]);
  } finally {
    clearTimeout(handle);
  }
}

function stableUuid(...parts: readonly string[]): string {
  const hex = createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}
