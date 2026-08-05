import { SpeachesAdapterError } from "./errors.js";
import { createSpeachesStableId } from "./speaches-final-transcription-identity.js";
import type {
  ChunkTask,
  ProviderTranscriptTurn,
} from "./speaches-final-transcription-types.js";

export function parseSpeachesProviderTurns(
  response: unknown,
  task: ChunkTask,
  idempotencyKey: string,
  recordingMediaOriginMs: number,
): readonly ProviderTranscriptTurn[] {
  if (!isRecord(response) || typeof response.text !== "string") {
    throw invalidProviderResponse("Speaches verbose transcription is not an object");
  }
  if (response.segments === undefined) {
    if (response.text.trim().length === 0) {
      return [];
    }
    throw invalidProviderResponse(
      "Speaches returned transcript text without required segment timestamps",
    );
  }
  if (!Array.isArray(response.segments)) {
    throw invalidProviderResponse("Speaches transcription segments must be an array");
  }

  const segmentIds = new Set<string>();
  return response.segments.flatMap((segment): readonly ProviderTranscriptTurn[] =>
    parseSegment(segment, task, idempotencyKey, recordingMediaOriginMs, segmentIds),
  );
}

export function compareSpeachesProviderTurns(
  left: ProviderTranscriptTurn,
  right: ProviderTranscriptTurn,
): number {
  return (
    left.startMs - right.startMs ||
    left.endMs - right.endMs ||
    left.speakerId.localeCompare(right.speakerId) ||
    left.stableTurnId.localeCompare(right.stableTurnId)
  );
}

function parseSegment(
  segment: unknown,
  task: ChunkTask,
  idempotencyKey: string,
  recordingMediaOriginMs: number,
  segmentIds: Set<string>,
): readonly ProviderTranscriptTurn[] {
  if (!isProviderSegment(segment)) {
    throw invalidProviderResponse("Speaches returned an invalid transcript segment");
  }
  const providerSegmentId = String(segment.id).trim();
  if (providerSegmentId.length === 0 || segmentIds.has(providerSegmentId)) {
    throw invalidProviderResponse("Speaches returned duplicate or empty segment identities");
  }
  segmentIds.add(providerSegmentId);

  const text = segment.text.trim();
  if (text.length === 0) {
    return [];
  }
  if (!isValidSegmentRange(segment.start, segment.end)) {
    throw invalidProviderResponse("Speaches returned an invalid segment time range");
  }

  const timestampOriginMs = task.artifact.providerTimestampOrigin === "recording-media-origin"
    ? recordingMediaOriginMs
    : task.reference.timelineOffsetMs;
  const baseOffsetMs = addSafeIntegers(timestampOriginMs, task.chunk.timelineOffsetMs);
  const startMs = addSafeIntegers(baseOffsetMs, secondsToMilliseconds(segment.start));
  const endMs = addSafeIntegers(baseOffsetMs, secondsToMilliseconds(segment.end));
  if (endMs <= startMs) {
    throw invalidProviderResponse("Speaches segment duration is below millisecond precision");
  }

  return [{
    endMs,
    providerSegmentId,
    speakerId: task.reference.speakerId,
    stableTurnId: createSpeachesStableId(
      "turn",
      idempotencyKey,
      String(task.sourceAudioIndex + 1),
      String(task.chunkIndex + 1),
      providerSegmentId,
    ),
    startMs,
    text,
  }];
}

function isProviderSegment(value: unknown): value is {
  readonly end: number;
  readonly id: number | string;
  readonly start: number;
  readonly text: string;
} {
  return (
    isRecord(value) &&
    (typeof value.id === "number" || typeof value.id === "string") &&
    typeof value.start === "number" &&
    typeof value.end === "number" &&
    typeof value.text === "string"
  );
}

function isValidSegmentRange(start: number, end: number): boolean {
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start;
}

function secondsToMilliseconds(seconds: number): number {
  const milliseconds = Math.round(seconds * 1_000);
  if (!Number.isSafeInteger(milliseconds)) {
    throw invalidProviderResponse("Speaches returned a timestamp outside the supported range");
  }
  return milliseconds;
}

function addSafeIntegers(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw invalidProviderResponse("Speaches returned a timestamp outside the supported range");
  }
  return result;
}

function invalidProviderResponse(message: string): SpeachesAdapterError {
  return new SpeachesAdapterError("invalid_provider_response", message, false);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
