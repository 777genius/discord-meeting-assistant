import type { FinalTranscriptionRequest } from "@discord-meeting/meeting-core";

import { VoicetextAdapterError } from "./errors.js";
import type { CompleteOggAudioArtifact } from "./ogg-artifact-reader.js";

const mebibyte = 1_024 * 1_024;
const maximumSegmentOverlapMilliseconds = 10_000;
const maximumVoicetextBatchConcurrency = 10;
const maximumVoicetextBatchSpeakerTracks = 11;

export interface VoicetextBatchFinalTranscriptionOptions {
  readonly artifactReadTimeoutMs?: number;
  readonly keyterms?: readonly string[];
  readonly maxArtifactBytesPerSpeaker?: number;
  readonly maxConcurrency?: number;
  readonly maxPollAttempts?: number;
  readonly maxPollBackoffMs?: number;
  readonly maxSegmentOverlapMs?: number;
  readonly maxSegmentOverrunMs?: number;
  readonly maxSegmentsPerSpeaker?: number;
  readonly maxSpeakerTracks?: number;
  readonly maxTotalArtifactBytes?: number;
  readonly maxTranscriptCharsPerSegment?: number;
  readonly maxTranscriptCharsPerSpeaker?: number;
  readonly pollInitialBackoffMs?: number;
  readonly pollTimeoutMs?: number;
}

export type CancellableVoicetextBatchTranscriptionRequest = FinalTranscriptionRequest & {
  readonly signal?: AbortSignal;
};

export interface ValidatedVoicetextBatchFinalTranscriptionOptions {
  readonly artifactReadTimeoutMs: number;
  readonly keyterms: readonly string[];
  readonly maxArtifactBytesPerSpeaker: number;
  readonly maxConcurrency: number;
  readonly maxPollAttempts: number;
  readonly maxPollBackoffMs: number;
  readonly maxSegmentOverlapMs: number;
  readonly maxSegmentOverrunMs: number;
  readonly maxSegmentsPerSpeaker: number;
  readonly maxSpeakerTracks: number;
  readonly maxTotalArtifactBytes: number;
  readonly maxTranscriptCharsPerSegment: number;
  readonly maxTranscriptCharsPerSpeaker: number;
  readonly pollInitialBackoffMs: number;
  readonly pollTimeoutMs: number;
}

export function validateVoicetextBatchFinalTranscriptionOptions(
  options: VoicetextBatchFinalTranscriptionOptions,
): ValidatedVoicetextBatchFinalTranscriptionOptions {
  const maxArtifactBytesPerSpeaker = boundedVoicetextBatchInteger(
    options.maxArtifactBytesPerSpeaker,
    64 * mebibyte,
    27,
    64 * mebibyte,
    "maxArtifactBytesPerSpeaker",
  );
  const maxSpeakerTracks = boundedVoicetextBatchInteger(
    options.maxSpeakerTracks,
    maximumVoicetextBatchSpeakerTracks,
    1,
    maximumVoicetextBatchSpeakerTracks,
    "maxSpeakerTracks",
  );
  return {
    artifactReadTimeoutMs: boundedVoicetextBatchTimeout(
      options.artifactReadTimeoutMs,
      60_000,
      "artifactReadTimeoutMs",
    ),
    keyterms: normalizeVoicetextBatchKeyterms(options.keyterms),
    maxArtifactBytesPerSpeaker,
    // Composition selects the bounded read-and-provider worker pool per meeting.
    maxConcurrency: boundedVoicetextBatchInteger(
      options.maxConcurrency,
      2,
      1,
      maximumVoicetextBatchConcurrency,
      "maxConcurrency",
    ),
    maxPollAttempts: boundedVoicetextBatchInteger(
      options.maxPollAttempts,
      128,
      1,
      1_024,
      "maxPollAttempts",
    ),
    maxPollBackoffMs: boundedVoicetextBatchInteger(
      options.maxPollBackoffMs,
      10_000,
      100,
      60_000,
      "maxPollBackoffMs",
    ),
    maxSegmentOverlapMs: boundedVoicetextBatchInteger(
      options.maxSegmentOverlapMs,
      2_000,
      0,
      maximumSegmentOverlapMilliseconds,
      "maxSegmentOverlapMs",
    ),
    maxSegmentOverrunMs: boundedVoicetextBatchInteger(
      options.maxSegmentOverrunMs,
      2_000,
      0,
      60_000,
      "maxSegmentOverrunMs",
    ),
    maxSegmentsPerSpeaker: boundedVoicetextBatchInteger(
      options.maxSegmentsPerSpeaker,
      10_000,
      1,
      100_000,
      "maxSegmentsPerSpeaker",
    ),
    maxSpeakerTracks,
    maxTotalArtifactBytes: boundedVoicetextBatchInteger(
      options.maxTotalArtifactBytes,
      maxArtifactBytesPerSpeaker * maxSpeakerTracks,
      maxArtifactBytesPerSpeaker,
      8_192 * mebibyte,
      "maxTotalArtifactBytes",
    ),
    maxTranscriptCharsPerSegment: boundedVoicetextBatchInteger(
      options.maxTranscriptCharsPerSegment,
      16_384,
      1,
      1_000_000,
      "maxTranscriptCharsPerSegment",
    ),
    maxTranscriptCharsPerSpeaker: boundedVoicetextBatchInteger(
      options.maxTranscriptCharsPerSpeaker,
      1_000_000,
      1,
      10_000_000,
      "maxTranscriptCharsPerSpeaker",
    ),
    pollInitialBackoffMs: boundedVoicetextBatchInteger(
      options.pollInitialBackoffMs,
      1_000,
      100,
      60_000,
      "pollInitialBackoffMs",
    ),
    pollTimeoutMs: boundedVoicetextBatchTimeout(
      options.pollTimeoutMs,
      900_000,
      "pollTimeoutMs",
    ),
  };
}

export function validateVoicetextBatchFinalTranscriptionRequest(
  request: FinalTranscriptionRequest,
  options: Pick<
    ValidatedVoicetextBatchFinalTranscriptionOptions,
    "maxArtifactBytesPerSpeaker" | "maxSpeakerTracks" | "maxTotalArtifactBytes"
  >,
): void {
  requireVoicetextBatchNonEmpty(request.idempotencyKey, "idempotencyKey");
  requireVoicetextBatchNonEmpty(request.meetingId, "meetingId");
  requireVoicetextBatchNonEmpty(request.recording.recordingId, "recording.recordingId");
  requireVoicetextBatchNonEmpty(request.recording.manifestLocator, "recording.manifestLocator");
  if (
    request.recording.speakerAudio.length < 1 ||
    request.recording.speakerAudio.length > options.maxSpeakerTracks
  ) {
    throw new VoicetextAdapterError(
      "invalid_input",
      "recording must contain between 1 and " + options.maxSpeakerTracks + " speaker tracks",
      false,
    );
  }
  const maximumArtifactBytes =
    request.recording.speakerAudio.length * options.maxArtifactBytesPerSpeaker;
  if (maximumArtifactBytes > options.maxTotalArtifactBytes) {
    throw new VoicetextAdapterError(
      "limit_exceeded",
      "recording exceeds the configured aggregate authoritative Ogg capacity",
      false,
    );
  }
  const locators = new Set<string>();
  const speakers = new Set<string>();
  for (const reference of request.recording.speakerAudio) {
    requireVoicetextBatchNonEmpty(reference.audioLocator, "speakerAudio.audioLocator");
    requireVoicetextBatchNonEmpty(reference.speakerId, "speakerAudio.speakerId");
    requireVoicetextBatchNonNegativeInteger(
      reference.timelineOffsetMs,
      "speakerAudio.timelineOffsetMs",
    );
    if (locators.has(reference.audioLocator) || speakers.has(reference.speakerId)) {
      throw new VoicetextAdapterError(
        "invalid_input",
        "speaker audio locators and speaker IDs must be unique",
        false,
      );
    }
    locators.add(reference.audioLocator);
    speakers.add(reference.speakerId);
  }
}

export function validateVoicetextBatchArtifact(
  artifact: unknown,
  maxBytes: number,
): asserts artifact is CompleteOggAudioArtifact {
  if (
    typeof artifact !== "object" ||
    artifact === null ||
    !("complete" in artifact) ||
    artifact.complete !== true ||
    !("container" in artifact) ||
    artifact.container !== "ogg" ||
    !("bytes" in artifact) ||
    !(artifact.bytes instanceof Uint8Array)
  ) {
    throw new VoicetextAdapterError(
      "invalid_input",
      "artifact reader must return one complete Ogg track",
      false,
    );
  }
  const bytes = artifact.bytes;
  if (
    bytes.byteLength < 27 ||
    bytes.byteLength > maxBytes ||
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") !== "OggS" ||
    bytes[4] !== 0 ||
    bytes.byteLength < 27 + (bytes[26] ?? 0)
  ) {
    throw new VoicetextAdapterError(
      "invalid_input",
      "authoritative speaker artifact is not a bounded Ogg stream",
      false,
    );
  }
}

function normalizeVoicetextBatchKeyterms(values: readonly string[] | undefined): readonly string[] {
  if (values === undefined) {
    return [];
  }
  if (values.length > 100) {
    throw new VoicetextAdapterError(
      "invalid_input",
      "Voicetext batch keyterms exceed 100 values",
      false,
    );
  }
  if (values.some((value) => typeof value !== "string")) {
    throw new VoicetextAdapterError(
      "invalid_input",
      "Voicetext batch keyterms are invalid",
      false,
    );
  }
  const normalized = [...new Set(values.map((value) => value.trim()))].toSorted();
  if (
    normalized.some((value) => value.length === 0 || Buffer.byteLength(value, "utf8") > 200)
  ) {
    throw new VoicetextAdapterError(
      "invalid_input",
      "Voicetext batch keyterms are invalid",
      false,
    );
  }
  return Object.freeze(normalized);
}

function boundedVoicetextBatchTimeout(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  return boundedVoicetextBatchInteger(value, fallback, 100, 3_600_000, field);
}

function boundedVoicetextBatchInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new VoicetextAdapterError(
      "invalid_input",
      field + " must be an integer between " + minimum + " and " + maximum,
      false,
    );
  }
  return candidate;
}

function requireVoicetextBatchNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new VoicetextAdapterError("invalid_input", field + " must not be empty", false);
  }
  return normalized;
}

function requireVoicetextBatchNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new VoicetextAdapterError(
      "invalid_input",
      field + " must be a non-negative safe integer",
      false,
    );
  }
}
