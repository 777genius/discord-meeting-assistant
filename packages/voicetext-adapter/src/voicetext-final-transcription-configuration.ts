import type { FinalTranscriptionRequest } from "@discord-meeting/meeting-core";

import { VoicetextAdapterError } from "./errors.js";

const mebibyte = 1_024 * 1_024;
const backendMaximumAudioFrameBytes = 65_536;
const defaultMaximumAudioBytesPerSecond = 16_000 * 2;

export const voicetextFinalPcmBytesPerSecond = 16_000 * 2;

export interface VoicetextFinalTranscriptionOptions {
  readonly artifactReadTimeoutMs?: number;
  readonly audioAckTimeoutMs?: number;
  readonly audioFrameBytes?: number;
  readonly endpoint: string;
  readonly finalizeTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly keyterms?: readonly string[];
  readonly language?: string;
  readonly maxArtifactBytesPerSpeaker?: number;
  readonly maxAudioBytesPerSecond?: number;
  readonly maxInboundFrameBytes?: number;
  readonly maxPcmBytesPerSpeaker?: number;
  readonly maxSegmentOverrunMs?: number;
  readonly maxSegmentsPerSpeaker?: number;
  readonly maxSpeakerTracks?: number;
  readonly maxTotalArtifactBytes?: number;
  readonly maxTotalPcmBytes?: number;
  readonly maxTranscriptCharsPerSegment?: number;
  readonly maxTranscriptCharsPerSpeaker?: number;
  readonly readyTimeoutMs?: number;
  readonly token: string;
  readonly transcodeTimeoutMs?: number;
}

export type CancellableVoicetextTranscriptionRequest = FinalTranscriptionRequest & {
  readonly signal?: AbortSignal;
};

export interface ValidatedVoicetextFinalTranscriptionOptions {
  readonly artifactReadTimeoutMs: number;
  readonly audioAckTimeoutMs: number;
  readonly audioFrameBytes: number;
  readonly authorization: string;
  readonly endpoint: URL;
  readonly finalizeTimeoutMs: number;
  readonly handshakeTimeoutMs: number;
  readonly keyterms: readonly string[];
  readonly language: string;
  readonly maxArtifactBytesPerSpeaker: number;
  readonly maxAudioBytesPerSecond: number;
  readonly maxInboundFrameBytes: number;
  readonly maxPcmBytesPerSpeaker: number;
  readonly maxSegmentOverrunMs: number;
  readonly maxSegmentsPerSpeaker: number;
  readonly maxSpeakerTracks: number;
  readonly maxTotalArtifactBytes: number;
  readonly maxTotalPcmBytes: number;
  readonly maxTranscriptCharsPerSegment: number;
  readonly maxTranscriptCharsPerSpeaker: number;
  readonly readyTimeoutMs: number;
  readonly transcodeTimeoutMs: number;
}

export function validateVoicetextFinalTranscriptionOptions(
  options: VoicetextFinalTranscriptionOptions,
): ValidatedVoicetextFinalTranscriptionOptions {
  const endpoint = validateVoicetextFinalEndpoint(options.endpoint);
  const token = requireVoicetextFinalNonEmpty(options.token, "token");
  if (token.length > 8_192 || containsAsciiControlCharacter(token)) {
    throw new VoicetextAdapterError("invalid_input", "token is invalid", false);
  }
  const language = requireVoicetextFinalNonEmpty(options.language ?? "ru", "language");
  if (language.length > 10 || !/^[a-z0-9-]+$/iu.test(language)) {
    throw new VoicetextAdapterError(
      "invalid_input",
      "language must be an ASCII language code up to 10 characters",
      false,
    );
  }
  const maxArtifactBytesPerSpeaker = boundedVoicetextFinalInteger(
    options.maxArtifactBytesPerSpeaker,
    512 * mebibyte,
    1,
    4_096 * mebibyte,
    "maxArtifactBytesPerSpeaker",
  );
  const maxPcmBytesPerSpeaker = boundedVoicetextFinalEvenInteger(
    options.maxPcmBytesPerSpeaker,
    512 * mebibyte,
    2,
    4_096 * mebibyte,
    "maxPcmBytesPerSpeaker",
  );
  const maxAudioBytesPerSecond = boundedVoicetextFinalEvenInteger(
    options.maxAudioBytesPerSecond,
    defaultMaximumAudioBytesPerSecond,
    voicetextFinalPcmBytesPerSecond,
    voicetextFinalPcmBytesPerSecond,
    "maxAudioBytesPerSecond",
  );
  const audioFrameBytes = boundedVoicetextFinalEvenInteger(
    options.audioFrameBytes,
    32_000,
    2,
    Math.min(backendMaximumAudioFrameBytes, maxAudioBytesPerSecond),
    "audioFrameBytes",
  );
  return {
    artifactReadTimeoutMs: boundedVoicetextFinalTimeout(
      options.artifactReadTimeoutMs,
      60_000,
      "artifactReadTimeoutMs",
    ),
    audioAckTimeoutMs: boundedVoicetextFinalTimeout(
      options.audioAckTimeoutMs,
      10_000,
      "audioAckTimeoutMs",
    ),
    audioFrameBytes,
    authorization: "Bearer " + token,
    endpoint,
    finalizeTimeoutMs: boundedVoicetextFinalTimeout(
      options.finalizeTimeoutMs,
      10_000,
      "finalizeTimeoutMs",
    ),
    handshakeTimeoutMs: boundedVoicetextFinalTimeout(
      options.handshakeTimeoutMs,
      10_000,
      "handshakeTimeoutMs",
    ),
    keyterms: normalizeVoicetextFinalKeyterms(options.keyterms),
    language,
    maxArtifactBytesPerSpeaker,
    maxAudioBytesPerSecond,
    maxInboundFrameBytes: boundedVoicetextFinalInteger(
      options.maxInboundFrameBytes,
      256 * 1_024,
      1_024,
      4 * mebibyte,
      "maxInboundFrameBytes",
    ),
    maxPcmBytesPerSpeaker,
    maxSegmentOverrunMs: boundedVoicetextFinalInteger(
      options.maxSegmentOverrunMs,
      2_000,
      0,
      60_000,
      "maxSegmentOverrunMs",
    ),
    maxSegmentsPerSpeaker: boundedVoicetextFinalInteger(
      options.maxSegmentsPerSpeaker,
      10_000,
      1,
      100_000,
      "maxSegmentsPerSpeaker",
    ),
    maxSpeakerTracks: boundedVoicetextFinalInteger(
      options.maxSpeakerTracks,
      64,
      1,
      256,
      "maxSpeakerTracks",
    ),
    maxTotalArtifactBytes: boundedVoicetextFinalInteger(
      options.maxTotalArtifactBytes,
      2_048 * mebibyte,
      maxArtifactBytesPerSpeaker,
      8_192 * mebibyte,
      "maxTotalArtifactBytes",
    ),
    maxTotalPcmBytes: boundedVoicetextFinalEvenInteger(
      options.maxTotalPcmBytes,
      2_048 * mebibyte,
      maxPcmBytesPerSpeaker,
      8_192 * mebibyte,
      "maxTotalPcmBytes",
    ),
    maxTranscriptCharsPerSegment: boundedVoicetextFinalInteger(
      options.maxTranscriptCharsPerSegment,
      16_384,
      1,
      1_000_000,
      "maxTranscriptCharsPerSegment",
    ),
    maxTranscriptCharsPerSpeaker: boundedVoicetextFinalInteger(
      options.maxTranscriptCharsPerSpeaker,
      1_000_000,
      1,
      10_000_000,
      "maxTranscriptCharsPerSpeaker",
    ),
    readyTimeoutMs: boundedVoicetextFinalTimeout(
      options.readyTimeoutMs,
      30_000,
      "readyTimeoutMs",
    ),
    transcodeTimeoutMs: boundedVoicetextFinalTimeout(
      options.transcodeTimeoutMs,
      300_000,
      "transcodeTimeoutMs",
    ),
  };
}

function validateVoicetextFinalEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch (error: unknown) {
    throw new VoicetextAdapterError(
      "invalid_input",
      "endpoint must be an absolute WSS URL",
      false,
      { cause: error },
    );
  }
  if (
    endpoint.protocol !== "wss:" ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.hash.length > 0 ||
    endpoint.search.length > 0
  ) {
    throw new VoicetextAdapterError(
      "invalid_input",
      "endpoint must be a credential-free WSS URL without query or fragment",
      false,
    );
  }
  return endpoint;
}

function containsAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

function normalizeVoicetextFinalKeyterms(values: readonly string[] | undefined): readonly string[] {
  if (values === undefined) {
    return [];
  }
  if (values.length > 256) {
    throw new VoicetextAdapterError(
      "invalid_input",
      "keyterms cannot contain more than 256 terms",
      false,
    );
  }
  const normalized = [...new Set(values.map((value) => value.trim()))];
  if (
    normalized.some((value) => value.length < 1 || value.length > 128) ||
    normalized.join("").length > 8_192
  ) {
    throw new VoicetextAdapterError(
      "invalid_input",
      "keyterms are invalid or exceed their configured bound",
      false,
    );
  }
  return Object.freeze(normalized);
}

function boundedVoicetextFinalTimeout(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  return boundedVoicetextFinalInteger(value, fallback, 100, 3_600_000, field);
}

function boundedVoicetextFinalInteger(
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

function boundedVoicetextFinalEvenInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const candidate = boundedVoicetextFinalInteger(value, fallback, minimum, maximum, field);
  if (candidate % 2 !== 0) {
    throw new VoicetextAdapterError(
      "invalid_input",
      field + " must be aligned to a pcm_s16le sample",
      false,
    );
  }
  return candidate;
}

function requireVoicetextFinalNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new VoicetextAdapterError("invalid_input", field + " must not be empty", false);
  }
  return normalized;
}
