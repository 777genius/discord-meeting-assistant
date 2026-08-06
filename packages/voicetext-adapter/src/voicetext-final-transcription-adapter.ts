import {
  type FinalTranscriptionPort,
  type GeneratedTranscript,
  type TranscriptTurnSnapshot,
  type FinalTranscriptionResult,
} from "@discord-meeting/meeting-core/transcription";
import {
  type SpeakerAudioReferenceSnapshot,
} from "@discord-meeting/meeting-core/recording";

import {
  systemVoicetextPacingScheduler,
  type VoicetextPacingScheduler,
} from "./audio-pacing.js";
import {
  validateVoicetextFinalTranscriptionOptions,
  type CancellableVoicetextTranscriptionRequest,
  type ValidatedVoicetextFinalTranscriptionOptions,
  type VoicetextFinalTranscriptionOptions,
} from "./voicetext-final-transcription-configuration.js";
import {
  addVoicetextFinalBoundedBytes,
  validateVoicetextFinalArtifact,
  validateVoicetextFinalPcm,
  validateVoicetextFinalTranscriptionRequest,
} from "./voicetext-final-transcription-input-validation.js";
import {
  toVoicetextPortFailure,
  VoicetextAdapterError,
} from "./errors.js";
import type {
  CompleteOggArtifactReader,
  CompleteOggAudioArtifact,
} from "./ogg-artifact-reader.js";
import type {
  CompleteOggToPcmTranscoder,
  MonoPcmS16Le16KhzAudio,
} from "./pcm-transcoder.js";
import { VoicetextFinalSpeakerTranscriber } from "./voicetext-final-speaker-transcriber.js";
import {
  awaitVoicetextFinalSignal,
  classifyVoicetextFinalOperationError,
  compareVoicetextFinalTurns,
  createVoicetextFinalOperationSignal,
  stableVoicetextFinalId,
  type VoicetextFinalProviderTurn,
} from "./voicetext-final-transcription-support.js";
import type { VoicetextWebSocketConnector } from "./websocket-connector.js";
import { WsVoicetextWebSocketConnector } from "./ws-websocket-connector.js";

export type {
  CancellableVoicetextTranscriptionRequest,
  VoicetextFinalTranscriptionOptions,
} from "./voicetext-final-transcription-configuration.js";

export class VoicetextFinalTranscriptionAdapter implements FinalTranscriptionPort {
  private readonly options: ValidatedVoicetextFinalTranscriptionOptions;
  private readonly speakerTranscriber: VoicetextFinalSpeakerTranscriber;

  public constructor(
    private readonly artifactReader: CompleteOggArtifactReader,
    private readonly transcoder: CompleteOggToPcmTranscoder,
    options: VoicetextFinalTranscriptionOptions,
    connector: VoicetextWebSocketConnector = new WsVoicetextWebSocketConnector(),
    pacingScheduler: VoicetextPacingScheduler = systemVoicetextPacingScheduler,
  ) {
    this.options = validateVoicetextFinalTranscriptionOptions(options);
    this.speakerTranscriber = new VoicetextFinalSpeakerTranscriber(
      connector,
      this.options,
      pacingScheduler,
    );
  }

  public async transcribe(
    request: CancellableVoicetextTranscriptionRequest,
  ): Promise<FinalTranscriptionResult<GeneratedTranscript>> {
    try {
      return { ok: true, value: await this.transcribeOrThrow(request) };
    } catch (error: unknown) {
      if (request.signal?.aborted === true && !(error instanceof VoicetextAdapterError)) {
        return {
          ok: false,
          failure: toVoicetextPortFailure(new VoicetextAdapterError(
            "cancelled",
            "Voicetext transcription was cancelled",
            true,
            { cause: error },
          )),
        };
      }
      return { ok: false, failure: toVoicetextPortFailure(error) };
    }
  }

  private async transcribeOrThrow(
    request: CancellableVoicetextTranscriptionRequest,
  ): Promise<GeneratedTranscript> {
    validateVoicetextFinalTranscriptionRequest(request, this.options.maxSpeakerTracks);
    request.signal?.throwIfAborted();

    let totalArtifactBytes = 0;
    let totalPcmBytes = 0;
    const turns: VoicetextFinalProviderTurn[] = [];
    for (const [speakerIndex, reference] of request.recording.speakerAudio.entries()) {
      const artifact = await this.readArtifact(reference, request.signal);
      totalArtifactBytes = addVoicetextFinalBoundedBytes(
        totalArtifactBytes,
        artifact.bytes.byteLength,
        this.options.maxTotalArtifactBytes,
        "Authoritative Ogg audio",
      );
      const pcm = await this.transcode(artifact, request.signal);
      totalPcmBytes = addVoicetextFinalBoundedBytes(
        totalPcmBytes,
        pcm.bytes.byteLength,
        this.options.maxTotalPcmBytes,
        "Transcoded PCM audio",
      );
      turns.push(...await this.speakerTranscriber.transcribe({
        externalSignal: request.signal,
        idempotencyKey: request.idempotencyKey,
        pcm,
        reference,
        speakerIndex,
      }));
    }
    return this.toGeneratedTranscript(turns, request.idempotencyKey);
  }

  private toGeneratedTranscript(
    turns: readonly VoicetextFinalProviderTurn[],
    idempotencyKey: string,
  ): GeneratedTranscript {
    const orderedTurns = turns.toSorted(compareVoicetextFinalTurns);
    if (new Set(orderedTurns.map(({ stableTurnId }) => stableTurnId)).size !== orderedTurns.length) {
      throw new VoicetextAdapterError(
        "invalid_provider_response",
        "Voicetext produced duplicate turn identities",
        false,
      );
    }
    return {
      transcriptId: stableVoicetextFinalId("transcript", idempotencyKey),
      turns: orderedTurns.map((turn): TranscriptTurnSnapshot => ({
        endMs: turn.endMs,
        speakerId: turn.speakerId,
        startMs: turn.startMs,
        text: turn.text,
        turnId: turn.stableTurnId,
      })),
      version: 1,
    };
  }

  private async readArtifact(
    reference: SpeakerAudioReferenceSnapshot,
    externalSignal: AbortSignal | undefined,
  ): Promise<CompleteOggAudioArtifact> {
    const operation = createVoicetextFinalOperationSignal(
      externalSignal,
      this.options.artifactReadTimeoutMs,
    );
    try {
      const artifact = await awaitVoicetextFinalSignal(this.artifactReader.read(
        reference.audioLocator,
        {
          maxBytes: this.options.maxArtifactBytesPerSpeaker,
          signal: operation.signal,
        },
      ), operation.signal);
      validateVoicetextFinalArtifact(artifact, this.options.maxArtifactBytesPerSpeaker);
      return artifact;
    } catch (error: unknown) {
      throw classifyVoicetextFinalOperationError(
        error,
        externalSignal,
        operation.timeoutSignal,
        "artifact_read_failed",
      );
    }
  }

  private async transcode(
    artifact: CompleteOggAudioArtifact,
    externalSignal: AbortSignal | undefined,
  ): Promise<MonoPcmS16Le16KhzAudio> {
    const operation = createVoicetextFinalOperationSignal(
      externalSignal,
      this.options.transcodeTimeoutMs,
    );
    try {
      const pcm = await awaitVoicetextFinalSignal(this.transcoder.transcode(
        artifact.bytes,
        {
          maxOutputBytes: this.options.maxPcmBytesPerSpeaker,
          signal: operation.signal,
        },
      ), operation.signal);
      validateVoicetextFinalPcm(pcm, this.options.maxPcmBytesPerSpeaker);
      return pcm;
    } catch (error: unknown) {
      throw classifyVoicetextFinalOperationError(
        error,
        externalSignal,
        operation.timeoutSignal,
        "transcode_failed",
      );
    }
  }
}
