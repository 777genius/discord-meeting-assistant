import type { SpeakerAudioReferenceSnapshot } from "@discord-meeting/meeting-core";

import type { VoicetextPacingScheduler } from "./audio-pacing.js";
import {
  VoicetextAdapterError,
  VoicetextTransportError,
} from "./errors.js";
import type { MonoPcmS16Le16KhzAudio } from "./pcm-transcoder.js";
import { VoicetextFinalTranscriptCollector } from "./voicetext-final-transcript-collector.js";
import {
  type ValidatedVoicetextFinalTranscriptionOptions,
} from "./voicetext-final-transcription-configuration.js";
import {
  awaitVoicetextFinalSignal,
  classifyVoicetextFinalOperationError,
  createVoicetextFinalOperationSignal,
  stableVoicetextFinalSessionUuid,
  type VoicetextFinalProviderTurn,
} from "./voicetext-final-transcription-support.js";
import {
  parseServerMessage,
  type VoicetextConfigMessage,
  type VoicetextServerMessage,
} from "./protocol.js";
import type {
  VoicetextWebSocketConnection,
  VoicetextWebSocketConnector,
} from "./websocket-connector.js";

const neverAbortedSignal = new AbortController().signal;

export interface VoicetextFinalSpeakerTranscriptionInput {
  readonly externalSignal: AbortSignal | undefined;
  readonly idempotencyKey: string;
  readonly pcm: MonoPcmS16Le16KhzAudio;
  readonly reference: SpeakerAudioReferenceSnapshot;
  readonly speakerIndex: number;
}

export class VoicetextFinalSpeakerTranscriber {
  public constructor(
    private readonly connector: VoicetextWebSocketConnector,
    private readonly options: ValidatedVoicetextFinalTranscriptionOptions,
    private readonly pacingScheduler: VoicetextPacingScheduler,
  ) {}

  public async transcribe(
    input: VoicetextFinalSpeakerTranscriptionInput,
  ): Promise<readonly VoicetextFinalProviderTurn[]> {
    const socket = await this.connect(input.externalSignal);
    let completed = false;
    try {
      const turns = await this.transcribeConnectedSpeaker(socket, input);
      completed = true;
      return turns;
    } finally {
      if (!completed) {
        socket.terminate();
      }
    }
  }

  private async connect(
    externalSignal: AbortSignal | undefined,
  ): Promise<VoicetextWebSocketConnection> {
    const connect = createVoicetextFinalOperationSignal(
      externalSignal,
      this.options.handshakeTimeoutMs,
    );
    try {
      return await awaitVoicetextFinalSignal(this.connector.connect({
        authorization: this.options.authorization,
        endpoint: new URL(this.options.endpoint),
        handshakeTimeoutMs: this.options.handshakeTimeoutMs,
        maxInboundFrameBytes: this.options.maxInboundFrameBytes,
        signal: connect.signal,
      }), connect.signal);
    } catch (error: unknown) {
      throw classifyVoicetextFinalOperationError(
        error,
        externalSignal,
        connect.timeoutSignal,
        "transport_error",
      );
    }
  }

  private async transcribeConnectedSpeaker(
    socket: VoicetextWebSocketConnection,
    input: VoicetextFinalSpeakerTranscriptionInput,
  ): Promise<readonly VoicetextFinalProviderTurn[]> {
    await this.sendConfiguration(socket, input);
    const collector = new VoicetextFinalTranscriptCollector(this.options);
    await this.waitForReady(socket, input.externalSignal);
    await this.sendAudioFrames(socket, input.pcm, collector, input.externalSignal);
    await this.sendText(
      socket,
      { type: "finalize" },
      input.externalSignal,
      this.options.finalizeTimeoutMs,
    );
    await this.waitForFinalizeComplete(socket, collector, input.externalSignal);
    await this.sendText(
      socket,
      { type: "close" },
      input.externalSignal,
      this.options.finalizeTimeoutMs,
    );
    await socket.close(1_000, "finalized");
    return collector.toTurns(
      input.pcm.bytes.byteLength,
      input.reference,
      input.speakerIndex,
      input.idempotencyKey,
    );
  }

  private async sendConfiguration(
    socket: VoicetextWebSocketConnection,
    input: VoicetextFinalSpeakerTranscriptionInput,
  ): Promise<void> {
    const config: VoicetextConfigMessage = {
      capabilities: ["finalize_ack"],
      channels: 1,
      client_session_id: stableVoicetextFinalSessionUuid(
        input.idempotencyKey,
        String(input.speakerIndex + 1),
      ),
      encoding: "pcm_s16le",
      ...(this.options.keyterms.length === 0 ? {} : { keyterms: this.options.keyterms }),
      language: this.options.language,
      protocol_v: 2,
      provider: "deepgram",
      sample_rate: 16_000,
      type: "config",
    };
    await this.sendText(socket, config, input.externalSignal, this.options.readyTimeoutMs);
  }

  private async sendAudioFrames(
    socket: VoicetextWebSocketConnection,
    pcm: MonoPcmS16Le16KhzAudio,
    collector: VoicetextFinalTranscriptCollector,
    externalSignal: AbortSignal | undefined,
  ): Promise<void> {
    const pacingStartedAtMs = this.readPacingTime();
    let expectedSequence = 0;
    for (let offset = 0; offset < pcm.bytes.byteLength; offset += this.options.audioFrameBytes) {
      const end = Math.min(offset + this.options.audioFrameBytes, pcm.bytes.byteLength);
      const frame = pcm.bytes.subarray(offset, end);
      await this.paceAudio(offset, pacingStartedAtMs, externalSignal);
      expectedSequence += 1;
      await this.sendBinary(socket, frame, externalSignal);
      await this.waitForAck(socket, expectedSequence, collector, externalSignal);
    }
  }

  private async paceAudio(
    sentBytes: number,
    startedAtMs: number,
    externalSignal: AbortSignal | undefined,
  ): Promise<void> {
    const signal = externalSignal ?? neverAbortedSignal;
    const targetElapsedMs = sentBytes * 1_000 / this.options.maxAudioBytesPerSecond;
    let previousTimeMs = startedAtMs;
    try {
      for (;;) {
        signal.throwIfAborted();
        const nowMs = this.readPacingTime();
        if (nowMs < previousTimeMs) {
          throw new VoicetextAdapterError(
            "protocol_error",
            "Voicetext pacing clock moved backwards",
            false,
          );
        }
        const remainingMs = targetElapsedMs - (nowMs - startedAtMs);
        if (remainingMs <= 0) {
          return;
        }
        previousTimeMs = nowMs;
        await awaitVoicetextFinalSignal(
          this.pacingScheduler.sleep(Math.ceil(remainingMs), signal),
          signal,
        );
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        throw new VoicetextAdapterError(
          "cancelled",
          "Voicetext transcription was cancelled",
          true,
          { cause: error },
        );
      }
      if (error instanceof VoicetextAdapterError) {
        throw error;
      }
      throw new VoicetextAdapterError(
        "transport_error",
        "Voicetext audio pacing failed",
        true,
        { cause: error },
      );
    }
  }

  private readPacingTime(): number {
    const nowMs = this.pacingScheduler.nowMs();
    if (!Number.isFinite(nowMs) || nowMs < 0) {
      throw new VoicetextAdapterError(
        "protocol_error",
        "Voicetext pacing clock returned an invalid time",
        false,
      );
    }
    return nowMs;
  }

  private async waitForReady(
    socket: VoicetextWebSocketConnection,
    externalSignal: AbortSignal | undefined,
  ): Promise<void> {
    const operation = createVoicetextFinalOperationSignal(
      externalSignal,
      this.options.readyTimeoutMs,
    );
    try {
      for (;;) {
        const message = await this.receive(socket, operation.signal);
        if (message.type === "ready") {
          return;
        }
        if (message.type === "error") {
          throw voicetextFinalServerError(message);
        }
        if (message.type !== "usage_update" && message.type !== "partial") {
          throw new VoicetextAdapterError(
            "protocol_error",
            "Voicetext sent " + message.type + " before ready",
            false,
          );
        }
      }
    } catch (error: unknown) {
      throw classifyVoicetextFinalOperationError(
        error,
        externalSignal,
        operation.timeoutSignal,
        "transport_error",
      );
    }
  }

  private async waitForAck(
    socket: VoicetextWebSocketConnection,
    expectedSequence: number,
    collector: VoicetextFinalTranscriptCollector,
    externalSignal: AbortSignal | undefined,
  ): Promise<void> {
    const operation = createVoicetextFinalOperationSignal(
      externalSignal,
      this.options.audioAckTimeoutMs,
    );
    try {
      for (;;) {
        const message = await this.receive(socket, operation.signal);
        if (message.type === "ack") {
          if (message.seq !== expectedSequence) {
            throw new VoicetextAdapterError(
              "protocol_error",
              "Voicetext acknowledged audio out of order",
              false,
            );
          }
          return;
        }
        this.collectInterleaved(message, collector, "audio acknowledgement");
      }
    } catch (error: unknown) {
      throw classifyVoicetextFinalOperationError(
        error,
        externalSignal,
        operation.timeoutSignal,
        "transport_error",
      );
    }
  }

  private async waitForFinalizeComplete(
    socket: VoicetextWebSocketConnection,
    collector: VoicetextFinalTranscriptCollector,
    externalSignal: AbortSignal | undefined,
  ): Promise<void> {
    const operation = createVoicetextFinalOperationSignal(
      externalSignal,
      this.options.finalizeTimeoutMs,
    );
    try {
      for (;;) {
        const message = await this.receive(socket, operation.signal);
        if (message.type === "finalize_complete") {
          if (message.status === "timeout") {
            throw new VoicetextAdapterError(
              "timeout",
              "Voicetext finalize did not flush provider results",
              true,
            );
          }
          if (message.status === "no_provider" || !message.sawResult) {
            throw new VoicetextAdapterError(
              "provider_error",
              "Voicetext provider did not confirm finalization",
              true,
            );
          }
          return;
        }
        this.collectInterleaved(message, collector, "finalize_complete");
      }
    } catch (error: unknown) {
      throw classifyVoicetextFinalOperationError(
        error,
        externalSignal,
        operation.timeoutSignal,
        "transport_error",
      );
    }
  }

  private collectInterleaved(
    message: VoicetextServerMessage,
    collector: VoicetextFinalTranscriptCollector,
    expected: string,
  ): void {
    if (message.type === "partial" || message.type === "usage_update") {
      return;
    }
    if (message.type === "final" || message.type === "segment_final") {
      collector.collect(message);
      return;
    }
    if (message.type === "error") {
      throw voicetextFinalServerError(message);
    }
    throw new VoicetextAdapterError(
      "protocol_error",
      "Voicetext sent " + message.type + " while waiting for " + expected,
      false,
    );
  }

  private async receive(
    socket: VoicetextWebSocketConnection,
    signal: AbortSignal,
  ): Promise<VoicetextServerMessage> {
    const frame = await socket.receive(signal);
    if (frame.type === "close") {
      throw new VoicetextTransportError(
        "closed",
        "Voicetext closed before finalization completed",
        { closeCode: frame.code },
      );
    }
    if (frame.type === "binary") {
      throw new VoicetextAdapterError(
        "protocol_error",
        "Voicetext returned an unexpected binary frame",
        false,
      );
    }
    return parseServerMessage(frame.data, this.options.maxTranscriptCharsPerSegment);
  }

  private async sendText(
    socket: VoicetextWebSocketConnection,
    message: object,
    externalSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<void> {
    const operation = createVoicetextFinalOperationSignal(externalSignal, timeoutMs);
    try {
      await awaitVoicetextFinalSignal(
        socket.sendText(JSON.stringify(message), operation.signal),
        operation.signal,
      );
    } catch (error: unknown) {
      throw classifyVoicetextFinalOperationError(
        error,
        externalSignal,
        operation.timeoutSignal,
        "transport_error",
      );
    }
  }

  private async sendBinary(
    socket: VoicetextWebSocketConnection,
    frame: Uint8Array,
    externalSignal: AbortSignal | undefined,
  ): Promise<void> {
    const operation = createVoicetextFinalOperationSignal(
      externalSignal,
      this.options.audioAckTimeoutMs,
    );
    try {
      await awaitVoicetextFinalSignal(
        socket.sendBinary(frame, operation.signal),
        operation.signal,
      );
    } catch (error: unknown) {
      throw classifyVoicetextFinalOperationError(
        error,
        externalSignal,
        operation.timeoutSignal,
        "transport_error",
      );
    }
  }

}

function voicetextFinalServerError(
  message: Extract<VoicetextServerMessage, { readonly type: "error" }>,
): VoicetextAdapterError {
  switch (message.code) {
    case "RATE_LIMIT_EXCEEDED":
    case "TOO_MANY_SESSIONS":
      return new VoicetextAdapterError(
        "rate_limited",
        "Voicetext rate limit was exceeded",
        true,
      );
    case "LIMIT_EXCEEDED":
    case "PROVIDER_QUOTA_EXCEEDED":
      return new VoicetextAdapterError(
        "quota_exceeded",
        "Voicetext transcription quota was exceeded",
        false,
      );
    case "PROVIDER_ERROR":
    case "PROVIDER_UNAVAILABLE":
    case "INTERNAL_ERROR":
      return new VoicetextAdapterError(
        "provider_error",
        "Voicetext provider is unavailable",
        true,
      );
    case "BAD_REQUEST":
      return new VoicetextAdapterError(
        "protocol_error",
        "Voicetext rejected the protocol request",
        false,
      );
    default:
      return new VoicetextAdapterError(
        "protocol_error",
        "Voicetext returned an unknown error code",
        false,
      );
  }
}
