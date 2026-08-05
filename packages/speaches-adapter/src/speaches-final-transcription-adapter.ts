import type {
  FinalTranscriptionPort,
  GeneratedTranscript,
  PortResult,
  TranscriptTurnSnapshot,
} from "@discord-meeting/meeting-core";

import type { BinaryAudioArtifactReader } from "./binary-audio-artifact-reader.js";
import { SpeachesAdapterError, toSpeachesPortFailure } from "./errors.js";
import { SpeachesSpeakerAudioLoader } from "./speaches-final-transcription-artifact-loader.js";
import { SpeachesChunkTranscriber } from "./speaches-final-transcription-chunk-transcriber.js";
import { validateSpeachesFinalTranscriptionOptions } from "./speaches-final-transcription-configuration.js";
import { createSpeachesStableId } from "./speaches-final-transcription-identity.js";
import { mapSpeachesWithConcurrency } from "./speaches-final-transcription-operation.js";
import { compareSpeachesProviderTurns } from "./speaches-final-transcription-provider-response.js";
import type {
  CancellableFinalTranscriptionRequest,
  ChunkTask,
  ProviderTranscriptTurn,
  ResolvedSpeakerAudio,
  SpeachesFinalTranscriptionOptions,
  ValidatedSpeachesFinalTranscriptionOptions,
} from "./speaches-final-transcription-types.js";
import { validateSpeachesFinalTranscriptionRequest, validateSpeachesTotalAudioSize } from "./speaches-final-transcription-validation.js";
import type { SpeachesTranscriptionClient } from "./speaches-transcription-client.js";

export type {
  CancellableFinalTranscriptionRequest,
  SpeachesFinalTranscriptionOptions,
} from "./speaches-final-transcription-types.js";

/**
 * Outbound adapter that coordinates bounded reads and provider calls, while
 * feature-specific collaborators own artifact validation and response parsing.
 */
export class SpeachesFinalTranscriptionAdapter implements FinalTranscriptionPort {
  private readonly audioLoader: SpeachesSpeakerAudioLoader;
  private readonly chunkTranscriber: SpeachesChunkTranscriber;
  private readonly options: ValidatedSpeachesFinalTranscriptionOptions;

  public constructor(
    client: SpeachesTranscriptionClient,
    artifactReader: BinaryAudioArtifactReader,
    options: SpeachesFinalTranscriptionOptions,
  ) {
    this.options = validateSpeachesFinalTranscriptionOptions(options);
    this.audioLoader = new SpeachesSpeakerAudioLoader(artifactReader, this.options);
    this.chunkTranscriber = new SpeachesChunkTranscriber(client, this.options);
  }

  public async transcribe(
    request: CancellableFinalTranscriptionRequest,
  ): Promise<PortResult<GeneratedTranscript>> {
    try {
      return { ok: true, value: await this.transcribeOrThrow(request) };
    } catch (error: unknown) {
      if (request.signal?.aborted === true && !(error instanceof SpeachesAdapterError)) {
        return {
          ok: false,
          failure: toSpeachesPortFailure(
            new SpeachesAdapterError(
              "cancelled",
              "Speaches transcription was cancelled",
              true,
              { cause: error },
            ),
          ),
        };
      }
      return { ok: false, failure: toSpeachesPortFailure(error) };
    }
  }

  private async transcribeOrThrow(
    request: CancellableFinalTranscriptionRequest,
  ): Promise<GeneratedTranscript> {
    validateSpeachesFinalTranscriptionRequest(request, this.options.maxSpeakerTracks);
    request.signal?.throwIfAborted();

    const resolvedAudio = await mapSpeachesWithConcurrency(
      request.recording.speakerAudio,
      this.options.maxConcurrency,
      request.signal,
      async (reference, sourceAudioIndex) =>
        await this.audioLoader.read(reference, sourceAudioIndex, request.signal),
    );
    validateSpeachesTotalAudioSize(resolvedAudio, this.options.maxTotalAudioBytes);

    const tasks = createChunkTasks(resolvedAudio);
    const recordingMediaOriginMs = Math.min(
      ...request.recording.speakerAudio.map(({ timelineOffsetMs }) => timelineOffsetMs),
    );
    const providerTurns = (await mapSpeachesWithConcurrency(
      tasks,
      this.options.maxConcurrency,
      request.signal,
      async (task) => await this.chunkTranscriber.transcribe(
        task,
        request.idempotencyKey,
        recordingMediaOriginMs,
        request.signal,
      ),
    )).flat().toSorted(compareSpeachesProviderTurns);

    ensureUniqueTurnIds(providerTurns);
    return toGeneratedTranscript(request.idempotencyKey, providerTurns);
  }
}

function createChunkTasks(
  resolvedAudio: readonly ResolvedSpeakerAudio[],
): readonly ChunkTask[] {
  return resolvedAudio.flatMap(({ artifact, reference, sourceAudioIndex }) =>
    artifact.chunks.map((chunk, chunkIndex): ChunkTask => ({
      artifact,
      chunk,
      chunkIndex,
      reference,
      sourceAudioIndex,
    })),
  );
}

function ensureUniqueTurnIds(turns: readonly ProviderTranscriptTurn[]): void {
  const turnIds = new Set(turns.map(({ stableTurnId }) => stableTurnId));
  if (turnIds.size !== turns.length) {
    throw new SpeachesAdapterError(
      "invalid_provider_response",
      "Speaches returned duplicate segment identities",
      false,
    );
  }
}

function toGeneratedTranscript(
  idempotencyKey: string,
  providerTurns: readonly ProviderTranscriptTurn[],
): GeneratedTranscript {
  return {
    transcriptId: createSpeachesStableId("transcript", idempotencyKey),
    version: 1,
    turns: providerTurns.map(
      (turn): TranscriptTurnSnapshot => ({
        endMs: turn.endMs,
        speakerId: turn.speakerId,
        startMs: turn.startMs,
        text: turn.text,
        turnId: turn.stableTurnId,
      }),
    ),
  };
}
