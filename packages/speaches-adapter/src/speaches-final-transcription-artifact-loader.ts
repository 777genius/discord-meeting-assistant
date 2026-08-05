import type { SpeakerAudioReferenceSnapshot } from "@discord-meeting/meeting-core";

import type { BinaryAudioArtifactReader } from "./binary-audio-artifact-reader.js";
import {
  classifySpeachesOperationError,
  combineSpeachesSignals,
} from "./speaches-final-transcription-operation.js";
import type {
  ResolvedSpeakerAudio,
  ValidatedSpeachesFinalTranscriptionOptions,
} from "./speaches-final-transcription-types.js";
import { validateSpeachesArtifact } from "./speaches-final-transcription-validation.js";

export class SpeachesSpeakerAudioLoader {
  public constructor(
    private readonly artifactReader: BinaryAudioArtifactReader,
    private readonly options: ValidatedSpeachesFinalTranscriptionOptions,
  ) {}

  public async read(
    reference: SpeakerAudioReferenceSnapshot,
    sourceAudioIndex: number,
    externalSignal: AbortSignal | undefined,
  ): Promise<ResolvedSpeakerAudio> {
    const timeoutSignal = AbortSignal.timeout(this.options.artifactReadTimeoutMs);
    const signal = combineSpeachesSignals(externalSignal, timeoutSignal);

    try {
      const artifact = await this.artifactReader.read(reference.audioLocator, {
        maxChunkBytes: this.options.maxBytesPerChunk,
        maxChunks: this.options.maxChunksPerSpeaker,
        signal,
      });
      validateSpeachesArtifact(artifact, this.options);
      return { artifact, reference, sourceAudioIndex };
    } catch (error: unknown) {
      throw classifySpeachesOperationError(
        error,
        externalSignal,
        timeoutSignal,
        "artifact_read_failed",
      );
    }
  }
}
