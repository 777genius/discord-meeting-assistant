import type { AcceptedFinalMeetingV1 } from "../domain/historical-evidence.js";

export interface HistoricalEmbeddingWindowPolicy {
  readonly maximumEmbeddingTokens: number;
  readonly maxBlockUtf8Bytes: number;
  readonly maxBlocksPerMeeting: number;
  readonly maxTurnsPerBlock: number;
  readonly turnOverlap: number;
}

export interface HistoricalTurnProjection {
  readonly sourceEndCodePoint: number;
  readonly sourceStartCodePoint: number;
  readonly text: string;
  readonly turn: AcceptedFinalMeetingV1["humanTurns"][number];
}

const MAXIMUM_REMOTE_TURN_REFS_PER_DOCUMENT = 14;

/** Deterministic conservative WordPiece-style estimate for multilingual text. */
export function estimateHistoricalEmbeddingTokens(value: string): number {
  const pieces = value.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) ?? [];
  return 2 + pieces.reduce((total, piece) => {
    const length = Array.from(piece).length;
    return total + (/^[a-z0-9]+$/iu.test(piece)
      ? Math.max(1, Math.ceil(length / 4))
      : /^[\p{L}\p{N}]+$/u.test(piece)
        ? Math.max(1, Math.ceil(length / 6))
        : length);
  }, 0);
}

export function historicalEmbeddingText(
  projections: readonly HistoricalTurnProjection[],
): string {
  return projections.map(({ text }) => text).join("\n");
}

export function partitionHistoricalEmbeddingWindows(
  meeting: AcceptedFinalMeetingV1,
  policy: HistoricalEmbeddingWindowPolicy,
): readonly (readonly HistoricalTurnProjection[])[] {
  const projections = meeting.humanTurns.flatMap((turn) =>
    splitTurn(turn, policy.maximumEmbeddingTokens)
  );
  const partitions: Array<readonly HistoricalTurnProjection[]> = [];
  const maximumWindowSize = Math.min(
    policy.maxTurnsPerBlock,
    MAXIMUM_REMOTE_TURN_REFS_PER_DOCUMENT,
  );
  let start = 0;
  while (start < projections.length) {
    const current: HistoricalTurnProjection[] = [];
    for (let index = start; index < projections.length; index += 1) {
      const candidate = [...current, projections[index]!];
      const candidateText = historicalEmbeddingText(candidate);
      if (
        current.length > 0 &&
        (candidate.length > maximumWindowSize ||
          byteLength(candidateText) > policy.maxBlockUtf8Bytes ||
          estimateHistoricalEmbeddingTokens(candidateText) > policy.maximumEmbeddingTokens)
      ) {
        break;
      }
      if (
        byteLength(candidateText) > policy.maxBlockUtf8Bytes ||
        estimateHistoricalEmbeddingTokens(candidateText) > policy.maximumEmbeddingTokens
      ) {
        throw new RangeError("one historical projection exceeds its qualified bounds");
      }
      current.push(projections[index]!);
    }
    partitions.push(Object.freeze(current));
    const overlap = current.length > policy.turnOverlap + 1
      ? policy.turnOverlap
      : 0;
    start += Math.max(1, current.length - overlap);
  }
  if (partitions.length > policy.maxBlocksPerMeeting) {
    throw new RangeError(
      "accepted meeting requires more evidence blocks than the qualified policy permits",
    );
  }
  return Object.freeze(partitions);
}

function splitTurn(
  turn: AcceptedFinalMeetingV1["humanTurns"][number],
  maximumTokens: number,
): readonly HistoricalTurnProjection[] {
  const characters = Array.from(turn.text);
  const projections: HistoricalTurnProjection[] = [];
  let start = 0;
  while (start < characters.length) {
    while (start < characters.length && /^\s$/u.test(characters[start] ?? "")) {
      start += 1;
    }
    if (start >= characters.length) {
      break;
    }
    let low = start + 1;
    let high = characters.length;
    let fittingEnd = start;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const text = characters.slice(start, middle).join("").trimEnd();
      if (estimateHistoricalEmbeddingTokens(text) <= maximumTokens) {
        fittingEnd = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (fittingEnd === start) {
      throw new RangeError(`authoritative turn ${turn.turnId} cannot fit the token bound`);
    }
    if (fittingEnd < characters.length) {
      const whitespace = characters
        .slice(start, fittingEnd)
        .findLastIndex((character) => /^\s$/u.test(character));
      if (whitespace > 0) {
        fittingEnd = start + whitespace;
      }
    }
    let sourceEndCodePoint = fittingEnd;
    while (
      sourceEndCodePoint > start &&
      /^\s$/u.test(characters[sourceEndCodePoint - 1] ?? "")
    ) {
      sourceEndCodePoint -= 1;
    }
    projections.push(Object.freeze({
      sourceEndCodePoint,
      sourceStartCodePoint: start,
      text: characters.slice(start, sourceEndCodePoint).join(""),
      turn,
    }));
    start = fittingEnd;
  }
  return Object.freeze(projections);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
