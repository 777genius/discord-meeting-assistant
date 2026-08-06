import {
  type SpeakerAudioReferenceSnapshot,
} from "@discord-meeting/meeting-core/recording";

import type { VoicetextPacingScheduler } from "./audio-pacing.js";
import { VoicetextAdapterError } from "./errors.js";
import type { MonoPcmS16Le16KhzAudio } from "./pcm-transcoder.js";
import { VoicetextFinalTranscriptCollector } from "./voicetext-final-transcript-collector.js";
import {
  type ValidatedVoicetextFinalTranscriptionOptions,
} from "./voicetext-final-transcription-configuration.js";
import {
  awaitVoicetextFinalSignal,
  classifyVoicetextFinalOperationError,
  createVoicetextFinalOperationSignal,
  type VoicetextFinalProviderTurn,
} from "./voicetext-final-transcription-support.js";
import { VoicetextFinalSpeakerSession } from "./voicetext-final-speaker-session.js";
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
    const session = new VoicetextFinalSpeakerSession(socket, this.options);
    await session.configure(input);
    const collector = new VoicetextFinalTranscriptCollector(this.options);
    await session.waitForReady(input.externalSignal);
    await this.sendAudioFrames(session, input.pcm, collector, input.externalSignal);
    await session.finalize(collector, input.externalSignal);
    await session.close(input.externalSignal);
    return collector.toTurns(
      input.pcm.bytes.byteLength,
      input.reference,
      input.speakerIndex,
      input.idempotencyKey,
    );
  }

  private async sendAudioFrames(
    session: VoicetextFinalSpeakerSession,
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
      await session.sendAudioFrame(frame, expectedSequence, collector, externalSignal);
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

}
