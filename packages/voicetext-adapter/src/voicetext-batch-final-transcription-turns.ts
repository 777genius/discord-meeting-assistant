import { createHash } from "node:crypto";

import type { TranscriptReadableSegmentSnapshot } from "@discord-meeting/meeting-core/transcription";
import type { SpeakerAudioReferenceSnapshot } from "@discord-meeting/meeting-core/recording";

import type { ValidatedVoicetextBatchFinalTranscriptionOptions } from "./voicetext-batch-final-transcription-configuration.js";
import { VoicetextAdapterError } from "./errors.js";
import type { VoicetextBatchTranscriptionResult } from "./voicetext-batch-client.js";

const voicetextBatchIdentityVersion = "v2";

export interface VoicetextBatchProviderTurn {
  readonly endMs: number;
  readonly speakerId: string;
  readonly sourceUtteranceIndex: number;
  readonly stableTurnId: string;
  readonly startMs: number;
  readonly text: string;
}

export interface VoicetextBatchProviderSpeakerTranscript {
  readonly readableSegments: readonly TranscriptReadableSegmentSnapshot[];
  readonly turns: readonly VoicetextBatchProviderTurn[];
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
      sourceUtteranceIndex: utteranceIndex,
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

export function mapVoicetextBatchProviderReadableSegments(
  input: VoicetextBatchTurnMappingInput,
  turns: readonly VoicetextBatchProviderTurn[],
): readonly TranscriptReadableSegmentSnapshot[] {
  try {
    return mapVoicetextBatchProviderReadableSegmentsOrThrow(input, turns);
  } catch (error: unknown) {
    if (error instanceof VoicetextAdapterError) {
      return [];
    }
    throw error;
  }
}

function mapVoicetextBatchProviderReadableSegmentsOrThrow(
  input: VoicetextBatchTurnMappingInput,
  turns: readonly VoicetextBatchProviderTurn[],
): readonly TranscriptReadableSegmentSnapshot[] {
  const audioDurationMs = ceilingVoicetextBatchMilliseconds(input.result.durationSeconds);
  const turnsByUtteranceIndex = new Map(
    turns.map((turn) => [turn.sourceUtteranceIndex, turn]),
  );
  let previousEndSeconds = -1;
  let totalCharacters = 0;
  return input.result.readableSegments.map((segment, segmentIndex) => {
    if (segmentIndex >= input.options.maxSegmentsPerSpeaker) {
      throw invalidReadableSegments("Voicetext batch returned too many readable segments");
    }
    const startMs = floorVoicetextBatchMilliseconds(segment.startSeconds);
    const endMs = ceilingVoicetextBatchMilliseconds(segment.endSeconds);
    if (
      segment.endSeconds <= segment.startSeconds ||
      endMs <= startMs ||
      exceedsVoicetextBatchSegmentOverlapLimit(
        previousEndSeconds,
        segment.startSeconds,
        input.options.maxSegmentOverlapMs,
      ) ||
      endMs > addVoicetextBatchSafeIntegers(
        audioDurationMs,
        input.options.maxSegmentOverrunMs,
      )
    ) {
      throw invalidReadableSegments("Voicetext batch readable segment timing is invalid");
    }
    previousEndSeconds = segment.endSeconds;
    const text = segment.transcript.trim();
    if (text.length === 0 || text.length > input.options.maxTranscriptCharsPerSegment) {
      throw invalidReadableSegments("Voicetext batch readable segment text is invalid");
    }
    totalCharacters = addVoicetextBatchSafeIntegers(totalCharacters, text.length);
    if (totalCharacters > input.options.maxTranscriptCharsPerSpeaker) {
      throw invalidReadableSegments("Voicetext batch readable segments exceeded their character limit");
    }
    if (segment.sourceUtteranceIndices.length === 0) {
      throw invalidReadableSegments("Voicetext batch readable segment has no source utterances");
    }
    let previousSourceIndex = -1;
    const sourceTurns = segment.sourceUtteranceIndices.map((sourceIndex) => {
      if (!Number.isSafeInteger(sourceIndex) || sourceIndex <= previousSourceIndex) {
        throw invalidReadableSegments("Voicetext batch readable segment source indices are invalid");
      }
      previousSourceIndex = sourceIndex;
      const sourceTurn = turnsByUtteranceIndex.get(sourceIndex);
      if (sourceTurn === undefined) {
        throw invalidReadableSegments("Voicetext batch readable segment references no raw turn");
      }
      return sourceTurn;
    });
    const sourceUtterances = segment.sourceUtteranceIndices.map((sourceIndex) => {
      const sourceUtterance = input.result.utterances[sourceIndex];
      if (sourceUtterance === undefined) {
        throw invalidReadableSegments("Voicetext batch readable segment references no utterance");
      }
      return sourceUtterance;
    });
    const providerEnvelopeStartMs = Math.min(...sourceUtterances.map((utterance) =>
      floorVoicetextBatchMilliseconds(utterance.startSeconds)
    ));
    const providerEnvelopeEndMs = Math.max(...sourceUtterances.map((utterance) =>
      ceilingVoicetextBatchMilliseconds(utterance.endSeconds)
    ));
    if (startMs < providerEnvelopeStartMs || endMs > providerEnvelopeEndMs) {
      throw invalidReadableSegments("Voicetext batch readable segment exceeds its source utterance envelope");
    }
    const envelopeStartMs = Math.min(...sourceTurns.map((turn) =>
      turn.startMs - input.reference.timelineOffsetMs
    ));
    const envelopeEndMs = Math.max(...sourceTurns.map((turn) =>
      turn.endMs - input.reference.timelineOffsetMs
    ));
    const normalizedStartMs = Math.max(startMs, envelopeStartMs);
    const normalizedEndMs = Math.min(endMs, envelopeEndMs);
    if (normalizedEndMs <= normalizedStartMs) {
      throw invalidReadableSegments("Voicetext batch readable segment exceeds its source turn envelope");
    }
    return {
      endMs: addVoicetextBatchSafeIntegers(
        input.reference.timelineOffsetMs,
        normalizedEndMs,
      ),
      segmentId: stableVoicetextBatchId(
        "readable-segment",
        input.idempotencyKey,
        String(input.speakerIndex + 1),
        String(segmentIndex + 1),
      ),
      sourceTurnIds: sourceTurns.map(({ stableTurnId }) => stableTurnId),
      speakerId: input.reference.speakerId,
      startMs: addVoicetextBatchSafeIntegers(
        input.reference.timelineOffsetMs,
        normalizedStartMs,
      ),
      text,
    };
  });
}

export function compareVoicetextBatchReadableSegments(
  left: TranscriptReadableSegmentSnapshot,
  right: TranscriptReadableSegmentSnapshot,
): number {
  return left.startMs - right.startMs ||
    left.endMs - right.endMs ||
    left.speakerId.localeCompare(right.speakerId) ||
    left.segmentId.localeCompare(right.segmentId);
}

function invalidReadableSegments(message: string): VoicetextAdapterError {
  return new VoicetextAdapterError("invalid_provider_response", message, false);
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
    voicetextBatchIdentityVersion,
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
