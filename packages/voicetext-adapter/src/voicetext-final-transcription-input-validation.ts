import type { FinalTranscriptionRequest } from "@discord-meeting/meeting-core";

import { VoicetextAdapterError } from "./errors.js";
import type { CompleteOggAudioArtifact } from "./ogg-artifact-reader.js";
import type { MonoPcmS16Le16KhzAudio } from "./pcm-transcoder.js";

export function validateVoicetextFinalTranscriptionRequest(
  request: FinalTranscriptionRequest,
  maxSpeakerTracks: number,
): void {
  requireVoicetextFinalNonEmpty(request.idempotencyKey, "idempotencyKey");
  requireVoicetextFinalNonEmpty(request.meetingId, "meetingId");
  requireVoicetextFinalNonEmpty(request.recording.recordingId, "recording.recordingId");
  requireVoicetextFinalNonEmpty(request.recording.manifestLocator, "recording.manifestLocator");
  if (request.recording.speakerAudio.length < 1 || request.recording.speakerAudio.length > maxSpeakerTracks) {
    throw new VoicetextAdapterError(
      "invalid_input",
      "recording must contain between 1 and " + maxSpeakerTracks + " speaker tracks",
      false,
    );
  }
  const locators = new Set<string>();
  const speakers = new Set<string>();
  for (const reference of request.recording.speakerAudio) {
    requireVoicetextFinalNonEmpty(reference.audioLocator, "speakerAudio.audioLocator");
    requireVoicetextFinalNonEmpty(reference.speakerId, "speakerAudio.speakerId");
    requireVoicetextFinalNonNegativeInteger(
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

export function validateVoicetextFinalArtifact(
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
  if (
    artifact.bytes.byteLength < 4 ||
    artifact.bytes.byteLength > maxBytes ||
    Buffer.from(artifact.bytes.subarray(0, 4)).toString("ascii") !== "OggS"
  ) {
    throw new VoicetextAdapterError(
      "invalid_input",
      "authoritative speaker artifact is not a bounded Ogg stream",
      false,
    );
  }
}

export function validateVoicetextFinalPcm(
  pcm: unknown,
  maxBytes: number,
): asserts pcm is MonoPcmS16Le16KhzAudio {
  if (
    typeof pcm !== "object" ||
    pcm === null ||
    !("channels" in pcm) ||
    pcm.channels !== 1 ||
    !("sampleRate" in pcm) ||
    pcm.sampleRate !== 16_000 ||
    !("encoding" in pcm) ||
    pcm.encoding !== "pcm_s16le" ||
    !("bytes" in pcm) ||
    !(pcm.bytes instanceof Uint8Array)
  ) {
    throw new VoicetextAdapterError(
      "transcode_failed",
      "transcoder returned the wrong PCM format",
      false,
    );
  }
  if (pcm.bytes.byteLength < 2 || pcm.bytes.byteLength > maxBytes || pcm.bytes.byteLength % 2 !== 0) {
    throw new VoicetextAdapterError(
      "transcode_failed",
      "transcoder returned invalid or oversized pcm_s16le audio",
      false,
    );
  }
}

export function addVoicetextFinalBoundedBytes(
  total: number,
  added: number,
  maximum: number,
  subject: string,
): number {
  const next = total + added;
  if (!Number.isSafeInteger(next) || next > maximum) {
    throw new VoicetextAdapterError(
      "limit_exceeded",
      subject + " exceeded its configured total byte limit",
      false,
    );
  }
  return next;
}

function requireVoicetextFinalNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new VoicetextAdapterError("invalid_input", field + " must not be empty", false);
  }
  return normalized;
}

function requireVoicetextFinalNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new VoicetextAdapterError(
      "invalid_input",
      field + " must be a non-negative safe integer",
      false,
    );
  }
}
