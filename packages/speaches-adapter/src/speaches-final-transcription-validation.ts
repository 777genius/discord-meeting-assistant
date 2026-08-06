import {
  type FinalTranscriptionRequest,
} from "@discord-meeting/meeting-core/transcription";

import type { BinaryAudioArtifact } from "./binary-audio-artifact-reader.js";
import {
  requireNonEmptySpeachesValue,
  requireNonNegativeSpeachesInteger,
} from "./speaches-final-transcription-configuration.js";
import { SpeachesAdapterError } from "./errors.js";
import type {
  ResolvedSpeakerAudio,
  ValidatedSpeachesFinalTranscriptionOptions,
} from "./speaches-final-transcription-types.js";

const supportedAudioExtension = /\.(?:flac|m4a|mp3|mp4|mpeg|mpga|ogg|wav|webm)$/iu;

export function validateSpeachesFinalTranscriptionRequest(
  request: FinalTranscriptionRequest,
  maxSpeakerTracks: number,
): void {
  requireNonEmptySpeachesValue(request.idempotencyKey, "idempotencyKey");
  requireNonEmptySpeachesValue(request.meetingId, "meetingId");
  requireNonEmptySpeachesValue(request.recording.recordingId, "recording.recordingId");
  requireNonEmptySpeachesValue(request.recording.manifestLocator, "recording.manifestLocator");
  if (request.recording.speakerAudio.length > maxSpeakerTracks) {
    throw invalidInput(
      `recording exceeds the configured limit of ${maxSpeakerTracks} speaker tracks`,
    );
  }

  const locators = new Set<string>();
  for (const reference of request.recording.speakerAudio) {
    requireNonEmptySpeachesValue(reference.audioLocator, "speakerAudio.audioLocator");
    requireNonEmptySpeachesValue(reference.speakerId, "speakerAudio.speakerId");
    requireNonNegativeSpeachesInteger(reference.timelineOffsetMs, "speakerAudio.timelineOffsetMs");
    if (locators.has(reference.audioLocator)) {
      throw invalidInput("speaker audio locators must be unique");
    }
    locators.add(reference.audioLocator);
  }
}

export function validateSpeachesArtifact(
  artifact: BinaryAudioArtifact,
  options: ValidatedSpeachesFinalTranscriptionOptions,
): void {
  const providerTimestampOrigin: unknown = Reflect.get(artifact, "providerTimestampOrigin");
  if (
    providerTimestampOrigin !== "recording-media-origin" &&
    providerTimestampOrigin !== "speaker-track-origin"
  ) {
    throw invalidInput("speaker audio must declare its provider timestamp origin");
  }
  if (artifact.chunks.length === 0 || artifact.chunks.length > options.maxChunksPerSpeaker) {
    throw invalidInput(
      `speaker audio must contain between 1 and ${options.maxChunksPerSpeaker} chunks`,
    );
  }

  let totalBytes = 0;
  let previousOffset = -1;
  for (const chunk of artifact.chunks) {
    requireNonEmptySpeachesValue(chunk.fileName, "audioChunk.fileName");
    requireNonEmptySpeachesValue(chunk.mediaType, "audioChunk.mediaType");
    requireNonNegativeSpeachesInteger(chunk.timelineOffsetMs, "audioChunk.timelineOffsetMs");
    if (chunk.timelineOffsetMs <= previousOffset) {
      throw invalidInput("audio chunk timeline offsets must be strictly increasing");
    }
    if (chunk.bytes.byteLength === 0 || chunk.bytes.byteLength > options.maxBytesPerChunk) {
      throw invalidInput(
        `audio chunks must contain between 1 and ${options.maxBytesPerChunk} bytes`,
      );
    }
    if (!supportedAudioExtension.test(chunk.fileName)) {
      throw invalidInput("audio chunk file extension is not supported by Speaches");
    }
    totalBytes += chunk.bytes.byteLength;
    previousOffset = chunk.timelineOffsetMs;
  }
  if (!Number.isSafeInteger(totalBytes) || totalBytes > options.maxBytesPerSpeaker) {
    throw invalidInput(
      `speaker audio exceeds the configured limit of ${options.maxBytesPerSpeaker} bytes`,
    );
  }
}

export function validateSpeachesTotalAudioSize(
  resolvedAudio: readonly ResolvedSpeakerAudio[],
  maxTotalAudioBytes: number,
): void {
  const totalBytes = resolvedAudio.reduce(
    (sum, { artifact }) =>
      sum + artifact.chunks.reduce((chunkSum, chunk) => chunkSum + chunk.bytes.byteLength, 0),
    0,
  );
  if (!Number.isSafeInteger(totalBytes) || totalBytes > maxTotalAudioBytes) {
    throw invalidInput(`meeting audio exceeds the configured limit of ${maxTotalAudioBytes} bytes`);
  }
}

function invalidInput(message: string): SpeachesAdapterError {
  return new SpeachesAdapterError("invalid_input", message, false);
}
