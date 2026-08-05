import { SpeachesClientError } from "./errors.js";
import { createSpeachesStableId } from "./speaches-final-transcription-identity.js";
import {
  classifySpeachesOperationError,
  combineSpeachesSignals,
} from "./speaches-final-transcription-operation.js";
import { parseSpeachesProviderTurns } from "./speaches-final-transcription-provider-response.js";
import type {
  ChunkTask,
  ProviderTranscriptTurn,
  ValidatedSpeachesFinalTranscriptionOptions,
} from "./speaches-final-transcription-types.js";
import type {
  SpeachesTranscriptionClient,
  SpeachesTranscriptionRequest,
} from "./speaches-transcription-client.js";

export class SpeachesChunkTranscriber {
  public constructor(
    private readonly client: SpeachesTranscriptionClient,
    private readonly options: ValidatedSpeachesFinalTranscriptionOptions,
  ) {}

  public async transcribe(
    task: ChunkTask,
    idempotencyKey: string,
    recordingMediaOriginMs: number,
    externalSignal: AbortSignal | undefined,
  ): Promise<readonly ProviderTranscriptTurn[]> {
    const timeoutSignal = AbortSignal.timeout(this.options.providerRequestTimeoutMs);
    const providerRequest = createProviderRequest(
      task,
      idempotencyKey,
      combineSpeachesSignals(externalSignal, timeoutSignal),
      this.options,
    );

    let response: unknown;
    try {
      response = await this.client.createTranscription(providerRequest);
    } catch (error: unknown) {
      const classified = classifySpeachesOperationError(
        error,
        externalSignal,
        timeoutSignal,
        "request_failed",
      );
      if (classified === error && error instanceof SpeachesClientError) {
        throw error;
      }
      throw classified;
    }

    return parseSpeachesProviderTurns(response, task, idempotencyKey, recordingMediaOriginMs);
  }
}

function createProviderRequest(
  task: ChunkTask,
  idempotencyKey: string,
  signal: AbortSignal,
  options: ValidatedSpeachesFinalTranscriptionOptions,
): SpeachesTranscriptionRequest {
  return {
    audio: task.chunk.bytes,
    fileName: task.chunk.fileName,
    idempotencyKey: createSpeachesStableId(
      "transcription-request",
      idempotencyKey,
      String(task.sourceAudioIndex + 1),
      String(task.chunkIndex + 1),
    ),
    mediaType: task.chunk.mediaType,
    model: options.model,
    signal,
    ...(options.hotwords === undefined ? {} : { hotwords: options.hotwords }),
    ...(options.language === undefined ? {} : { language: options.language }),
    ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
  };
}
