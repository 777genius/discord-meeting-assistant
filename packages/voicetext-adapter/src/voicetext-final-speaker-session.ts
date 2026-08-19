import {
  VoicetextAdapterError,
  VoicetextTransportError,
} from "./errors.js";
import { VoicetextFinalTranscriptCollector } from "./voicetext-final-transcript-collector.js";
import type {
  ValidatedVoicetextFinalTranscriptionOptions,
} from "./voicetext-final-transcription-configuration.js";
import {
  awaitVoicetextFinalSignal,
  classifyVoicetextFinalOperationError,
  createVoicetextFinalOperationSignal,
  stableVoicetextFinalSessionUuid,
} from "./voicetext-final-transcription-support.js";
import {
  parseServerMessage,
  type VoicetextConfigMessage,
  type VoicetextServerMessage,
} from "./protocol.js";
import type { VoicetextWebSocketConnection } from "./websocket-connector.js";

export interface VoicetextFinalSpeakerSessionConfiguration {
  readonly externalSignal: AbortSignal | undefined;
  readonly idempotencyKey: string;
  readonly speakerIndex: number;
}

export class VoicetextFinalSpeakerSession {
  public constructor(
    private readonly socket: VoicetextWebSocketConnection,
    private readonly options: ValidatedVoicetextFinalTranscriptionOptions,
  ) {}

  public async configure(input: VoicetextFinalSpeakerSessionConfiguration): Promise<void> {
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
      model: "nova-3",
      protocol_v: 2,
      provider: "deepgram",
      sample_rate: 16_000,
      type: "config",
    };
    await this.sendText(config, input.externalSignal, this.options.readyTimeoutMs);
  }

  public async waitForReady(externalSignal: AbortSignal | undefined): Promise<void> {
    const operation = createVoicetextFinalOperationSignal(
      externalSignal,
      this.options.readyTimeoutMs,
    );
    try {
      for (;;) {
        const message = await this.receive(operation.signal);
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

  public async sendAudioFrame(
    frame: Uint8Array,
    expectedSequence: number,
    collector: VoicetextFinalTranscriptCollector,
    externalSignal: AbortSignal | undefined,
  ): Promise<void> {
    await this.sendBinary(frame, externalSignal);
    await this.waitForAck(expectedSequence, collector, externalSignal);
  }

  public async finalize(
    collector: VoicetextFinalTranscriptCollector,
    externalSignal: AbortSignal | undefined,
  ): Promise<void> {
    await this.sendText(
      { type: "finalize" },
      externalSignal,
      this.options.finalizeTimeoutMs,
    );
    await this.waitForFinalizeComplete(collector, externalSignal);
  }

  public async close(externalSignal: AbortSignal | undefined): Promise<void> {
    await this.sendText(
      { type: "close" },
      externalSignal,
      this.options.finalizeTimeoutMs,
    );
    await this.socket.close(1_000, "finalized");
  }

  private async waitForAck(
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
        const message = await this.receive(operation.signal);
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
    collector: VoicetextFinalTranscriptCollector,
    externalSignal: AbortSignal | undefined,
  ): Promise<void> {
    const operation = createVoicetextFinalOperationSignal(
      externalSignal,
      this.options.finalizeTimeoutMs,
    );
    try {
      for (;;) {
        const message = await this.receive(operation.signal);
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

  private async receive(signal: AbortSignal): Promise<VoicetextServerMessage> {
    const frame = await this.socket.receive(signal);
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
    message: object,
    externalSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<void> {
    const operation = createVoicetextFinalOperationSignal(externalSignal, timeoutMs);
    try {
      await awaitVoicetextFinalSignal(
        this.socket.sendText(JSON.stringify(message), operation.signal),
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
    frame: Uint8Array,
    externalSignal: AbortSignal | undefined,
  ): Promise<void> {
    const operation = createVoicetextFinalOperationSignal(
      externalSignal,
      this.options.audioAckTimeoutMs,
    );
    try {
      await awaitVoicetextFinalSignal(
        this.socket.sendBinary(frame, operation.signal),
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
