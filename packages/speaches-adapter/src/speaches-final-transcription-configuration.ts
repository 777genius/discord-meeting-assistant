import { SpeachesAdapterError } from "./errors.js";
import type {
  SpeachesFinalTranscriptionOptions,
  ValidatedSpeachesFinalTranscriptionOptions,
} from "./speaches-final-transcription-types.js";

const mebibyte = 1_024 * 1_024;

export function validateSpeachesFinalTranscriptionOptions(
  options: SpeachesFinalTranscriptionOptions,
): ValidatedSpeachesFinalTranscriptionOptions {
  const model = requireNonEmptySpeachesValue(options.model, "model");
  const language = optionalNonEmptySpeachesValue(options.language, "language");
  const maxConcurrency = boundedIntegerOption(options.maxConcurrency, 2, 1, 16, "maxConcurrency");
  const maxSpeakerTracks = boundedIntegerOption(
    options.maxSpeakerTracks,
    64,
    1,
    256,
    "maxSpeakerTracks",
  );
  const maxChunksPerSpeaker = boundedIntegerOption(
    options.maxChunksPerSpeaker,
    128,
    1,
    1_024,
    "maxChunksPerSpeaker",
  );
  const maxBytesPerChunk = boundedIntegerOption(
    options.maxBytesPerChunk,
    64 * mebibyte,
    1,
    512 * mebibyte,
    "maxBytesPerChunk",
  );
  const maxBytesPerSpeaker = boundedIntegerOption(
    options.maxBytesPerSpeaker,
    512 * mebibyte,
    maxBytesPerChunk,
    4_096 * mebibyte,
    "maxBytesPerSpeaker",
  );
  const maxTotalAudioBytes = boundedIntegerOption(
    options.maxTotalAudioBytes,
    2_048 * mebibyte,
    maxBytesPerSpeaker,
    8_192 * mebibyte,
    "maxTotalAudioBytes",
  );
  const artifactReadTimeoutMs = boundedIntegerOption(
    options.artifactReadTimeoutMs,
    60_000,
    100,
    3_600_000,
    "artifactReadTimeoutMs",
  );
  const providerRequestTimeoutMs = boundedIntegerOption(
    options.providerRequestTimeoutMs,
    900_000,
    100,
    3_600_000,
    "providerRequestTimeoutMs",
  );
  const vocabulary = normalizeSpeachesVocabulary(options.vocabulary);

  return {
    artifactReadTimeoutMs,
    hotwords: vocabulary.length === 0 ? undefined : vocabulary.join(", "),
    language,
    maxBytesPerChunk,
    maxBytesPerSpeaker,
    maxChunksPerSpeaker,
    maxConcurrency,
    maxSpeakerTracks,
    maxTotalAudioBytes,
    model,
    prompt: undefined,
    providerRequestTimeoutMs,
  };
}

export function requireNonEmptySpeachesValue(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw invalidInput(`${field} must not be empty`);
  }
  return normalized;
}

export function requireNonNegativeSpeachesInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidInput(`${field} must be a non-negative safe integer`);
  }
}

function optionalNonEmptySpeachesValue(value: string | undefined, field: string): string | undefined {
  return value === undefined ? undefined : requireNonEmptySpeachesValue(value, field);
}

function normalizeSpeachesVocabulary(vocabulary: readonly string[] | undefined): readonly string[] {
  if (vocabulary === undefined) {
    return [];
  }
  if (vocabulary.length > 256) {
    throw invalidInput("vocabulary cannot contain more than 256 terms");
  }
  const normalized = [...new Set(vocabulary.map((term) => term.trim()))];
  if (normalized.some((term) => term.length === 0 || term.length > 128)) {
    throw invalidInput("vocabulary terms must contain between 1 and 128 characters");
  }
  if (normalized.join(", ").length > 4_096) {
    throw invalidInput("vocabulary hotwords cannot exceed 4096 characters");
  }
  return normalized;
}

function boundedIntegerOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw invalidInput(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return candidate;
}

function invalidInput(message: string): SpeachesAdapterError {
  return new SpeachesAdapterError("invalid_input", message, false);
}
