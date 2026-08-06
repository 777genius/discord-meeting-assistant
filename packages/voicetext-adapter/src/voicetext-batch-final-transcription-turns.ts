import { createHash } from "node:crypto";

import {
  type SpeakerAudioReferenceSnapshot,
} from "@discord-meeting/meeting-core/recording";

import type { ValidatedVoicetextBatchFinalTranscriptionOptions } from "./voicetext-batch-final-transcription-configuration.js";
import { VoicetextAdapterError } from "./errors.js";
import type { VoicetextBatchTranscriptionResult } from "./voicetext-batch-client.js";

export interface VoicetextBatchProviderTurn {
  readonly endMs: number;
  readonly speakerId: string;
  readonly stableTurnId: string;
  readonly startMs: number;
  readonly text: string;
}

export interface VoicetextBatchTurnMappingInput {
  readonly idempotencyKey: string;
  readonly options: ValidatedVoicetextBatchFinalTranscriptionOptions;
  readonly reference: SpeakerAudioReferenceSnapshot;
  readonly result: VoicetextBatchTranscriptionResult;
  readonly speakerIndex: number;
}

export function mapVoicetextBatchProviderTurns(
  input: VoicetextBatchTurnMappingInput,
): readonly VoicetextBatchProviderTurn[] {
  const audioDurationMs = ceilingVoicetextBatchMilliseconds(input.result.durationSeconds);
  let previousEndMs = -1;
  let previousEndSeconds = -1;
  let totalCharacters = 0;
  const turns: VoicetextBatchProviderTurn[] = [];
  for (const [utteranceIndex, utterance] of input.result.utterances.entries()) {
    if (utteranceIndex >= input.options.maxSegmentsPerSpeaker) {
      throw new VoicetextAdapterError(
        "limit_exceeded",
        "Voicetext batch returned too many final segments",
        false,
      );
    }
    const rawStartSeconds = utterance.startSeconds;
    const rawEndSeconds = utterance.endSeconds;
    const roundedStartMs = floorVoicetextBatchMilliseconds(rawStartSeconds);
    const relativeStartMs = Math.max(roundedStartMs, previousEndMs);
    const relativeEndMs = ceilingVoicetextBatchMilliseconds(rawEndSeconds);
    if (
      rawEndSeconds <= rawStartSeconds ||
      exceedsVoicetextBatchSegmentOverlapLimit(
        previousEndSeconds,
        rawStartSeconds,
        input.options.maxSegmentOverlapMs,
      ) ||
      relativeEndMs <= relativeStartMs
    ) {
      throw new VoicetextAdapterError(
        "invalid_provider_response",
        "Voicetext batch final segments are overlapping or zero-length",
        false,
      );
    }
    if (
      relativeEndMs >
      addVoicetextBatchSafeIntegers(audioDurationMs, input.options.maxSegmentOverrunMs)
    ) {
      throw new VoicetextAdapterError(
        "invalid_provider_response",
        "Voicetext batch final segment exceeds the speaker audio duration",
        false,
      );
    }
    previousEndMs = relativeEndMs;
    previousEndSeconds = rawEndSeconds;
    const text = utterance.transcript.trim();
    if (text.length === 0) {
      continue;
    }
    if (text.length > input.options.maxTranscriptCharsPerSegment) {
      throw new VoicetextAdapterError(
        "limit_exceeded",
        "Voicetext batch final segment exceeded its configured character limit",
        false,
      );
    }
    totalCharacters = addVoicetextBatchSafeIntegers(totalCharacters, text.length);
    if (totalCharacters > input.options.maxTranscriptCharsPerSpeaker) {
      throw new VoicetextAdapterError(
        "limit_exceeded",
        "Voicetext batch transcript exceeded its configured character limit",
        false,
      );
    }
    turns.push({
      endMs: addVoicetextBatchSafeIntegers(
        input.reference.timelineOffsetMs,
        relativeEndMs,
      ),
      speakerId: input.reference.speakerId,
      stableTurnId: stableVoicetextBatchId(
        "turn",
        input.idempotencyKey,
        String(input.speakerIndex + 1),
        String(utteranceIndex + 1),
      ),
      startMs: addVoicetextBatchSafeIntegers(
        input.reference.timelineOffsetMs,
        relativeStartMs,
      ),
      text,
    });
  }
  return turns;
}

export function stableVoicetextBatchIdempotencyKey(
  requestIdempotencyKey: string,
  recordingId: string,
  speakerId: string,
): string {
  return createHash("sha256")
    .update([
      "voicetext-batch-v2",
      encodeVoicetextBatchIdentityPart(requestIdempotencyKey),
      encodeVoicetextBatchIdentityPart(recordingId),
      encodeVoicetextBatchIdentityPart(speakerId),
    ].join("|"), "utf8")
    .digest("hex");
}

export function stableVoicetextBatchId(
  kind: string,
  idempotencyKey: string,
  ...parts: readonly string[]
): string {
  return [
    kind,
    "v2",
    encodeVoicetextBatchIdentityPart(idempotencyKey),
    ...parts.map(encodeVoicetextBatchIdentityPart),
  ].join(":");
}

export function compareVoicetextBatchTurns(
  left: VoicetextBatchProviderTurn,
  right: VoicetextBatchProviderTurn,
): number {
  return left.startMs - right.startMs ||
    left.endMs - right.endMs ||
    left.speakerId.localeCompare(right.speakerId) ||
    left.stableTurnId.localeCompare(right.stableTurnId);
}

export function addVoicetextBatchSafeIntegers(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new VoicetextAdapterError(
      "invalid_provider_response",
      "Voicetext batch returned a timestamp outside the supported range",
      false,
    );
  }
  return result;
}

function floorVoicetextBatchMilliseconds(value: number): number {
  const milliseconds = Math.floor(value * 1_000);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new VoicetextAdapterError(
      "invalid_provider_response",
      "Voicetext batch returned a timestamp outside the supported range",
      false,
    );
  }
  return milliseconds;
}

function ceilingVoicetextBatchMilliseconds(value: number): number {
  const milliseconds = Math.ceil(value * 1_000);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new VoicetextAdapterError(
      "invalid_provider_response",
      "Voicetext batch returned a timestamp outside the supported range",
      false,
    );
  }
  return milliseconds;
}

function exceedsVoicetextBatchSegmentOverlapLimit(
  previousEndSeconds: number,
  nextStartSeconds: number,
  maximumOverlapMilliseconds: number,
): boolean {
  const overlapSeconds = previousEndSeconds - nextStartSeconds;
  const maximumOverlapSeconds = maximumOverlapMilliseconds / 1_000;
  // JSON numbers can make a decimal boundary (for example 292.6 - 291.245)
  // infinitesimally larger than its intended provider value. The tolerance is
  // bounded to IEEE-754 representation error, not a semantic grace period.
  const representationTolerance = Number.EPSILON * Math.max(
    1,
    Math.abs(previousEndSeconds),
    Math.abs(nextStartSeconds),
  );
  return overlapSeconds > maximumOverlapSeconds + representationTolerance;
}

function encodeVoicetextBatchIdentityPart(value: string): string {
  return value.length + ":" + value;
}
