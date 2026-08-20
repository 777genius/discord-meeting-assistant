import type { AcceptedFinalMeetingV1 } from "../domain/historical-evidence.js";
import type {
  HistoricalBlockManifestV1,
  HistoricalEvidenceSliceV1,
  HistoricalIndexPlanV1,
} from "./ports/historical-memory.js";
import type { HistoricalEmbeddingTokenizerPort } from
  "./ports/historical-embedding-tokenizer.js";

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

export type HistoricalWindowPlanningAction =
  | Readonly<{ kind: "checkpoint" }>
  | Readonly<{ kind: "count_tokens"; text: string }>;

export interface HistoricalEmbeddingPartitions {
  readonly effectiveTurnOverlap: number;
  readonly windows: readonly (readonly HistoricalTurnProjection[])[];
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

export function canonicalHistoricalTurnSources(
  sources: HistoricalBlockManifestV1["turnSources"],
): string {
  return JSON.stringify(sources.map((source) => ({
    embeddingEndCodePoint: source.embeddingEndCodePoint,
    embeddingStartCodePoint: source.embeddingStartCodePoint,
    endMs: source.endMs,
    sourceEndCodePoint: source.sourceEndCodePoint,
    sourceRef: source.sourceRef,
    sourceStartCodePoint: source.sourceStartCodePoint,
    speakerId: source.speakerId,
    startMs: source.startMs,
    turnId: source.turnId,
  })));
}

export function buildHistoricalTurnSources(
  projections: readonly HistoricalTurnProjection[],
  sourceRef: (turnId: string) => string,
): HistoricalBlockManifestV1["turnSources"] {
  let embeddingOffset = 0;
  return Object.freeze(projections.map((projection) => {
    const textLength = Array.from(projection.text).length;
    const source = Object.freeze({
      embeddingEndCodePoint: embeddingOffset + textLength,
      embeddingStartCodePoint: embeddingOffset,
      endMs: projection.turn.endMs,
      sourceEndCodePoint: projection.sourceEndCodePoint,
      sourceRef: sourceRef(projection.turn.turnId),
      sourceStartCodePoint: projection.sourceStartCodePoint,
      speakerId: projection.turn.speakerId,
      startMs: projection.turn.startMs,
      turnId: projection.turn.turnId,
    });
    embeddingOffset += textLength + 1;
    return source;
  }));
}

export function rehydrateHistoricalProjectionTurns(
  meeting: AcceptedFinalMeetingV1,
  embeddingText: string,
  sources: HistoricalBlockManifestV1["turnSources"],
): readonly HistoricalEvidenceSliceV1[] | null {
  const turnsById = new Map(meeting.humanTurns.map((turn) => [turn.turnId, turn]));
  const embeddingCodePoints = Array.from(embeddingText);
  const turns: HistoricalEvidenceSliceV1[] = [];
  for (const source of sources) {
    const turn = turnsById.get(source.turnId);
    if (turn === undefined) {
      return null;
    }
    const sourceCodePoints = Array.from(turn.text);
    const text = sourceCodePoints
      .slice(source.sourceStartCodePoint, source.sourceEndCodePoint)
      .join("");
    const projectedText = embeddingCodePoints
      .slice(source.embeddingStartCodePoint, source.embeddingEndCodePoint)
      .join("");
    if (!sourceRangeMatchesTurn(source, turn, sourceCodePoints.length) ||
      source.embeddingEndCodePoint > embeddingCodePoints.length ||
      text.length === 0 || text !== projectedText) {
      return null;
    }
    turns.push(Object.freeze({
      ...turn,
      sourceEndCodePoint: source.sourceEndCodePoint,
      sourceRef: source.sourceRef,
      sourceStartCodePoint: source.sourceStartCodePoint,
      text,
    }));
  }
  return Object.freeze(turns);
}

export function historicalPlanProjectionMatches(
  meeting: AcceptedFinalMeetingV1,
  plan: HistoricalIndexPlanV1,
  sourceRef: (turnId: string) => string,
): boolean {
  if (plan.documents.length === 0 || plan.documents.length > 500) {
    return false;
  }
  const covered = new Map<string, boolean[]>();
  for (const turn of meeting.humanTurns) {
    covered.set(turn.turnId, Array.from(turn.text).map(() => false));
  }
  for (const document of plan.documents) {
    const turns = rehydrateHistoricalProjectionTurns(
      meeting,
      document.embeddingText,
      document.manifest.turnSources,
    );
    if (turns === null || turns.map(({ text }) => text).join("\n") !== document.embeddingText) {
      return false;
    }
    for (const source of document.manifest.turnSources) {
      const coverage = covered.get(source.turnId);
      if (coverage === undefined || source.sourceRef !== sourceRef(source.turnId)) {
        return false;
      }
      coverage.fill(true, source.sourceStartCodePoint, source.sourceEndCodePoint);
    }
  }
  return meeting.humanTurns.every((turn) => {
    const coverage = covered.get(turn.turnId) ?? [];
    return Array.from(turn.text).every((character, index) =>
      /^\s$/u.test(character) || coverage[index] === true
    );
  });
}

function sourceRangeMatchesTurn(
  source: HistoricalBlockManifestV1["turnSources"][number],
  turn: AcceptedFinalMeetingV1["humanTurns"][number],
  sourceLength: number,
): boolean {
  return source.speakerId === turn.speakerId && source.startMs === turn.startMs &&
    source.endMs === turn.endMs && source.sourceStartCodePoint >= 0 &&
    source.sourceEndCodePoint > source.sourceStartCodePoint &&
    source.sourceEndCodePoint <= sourceLength &&
    source.embeddingStartCodePoint >= 0 &&
    source.embeddingEndCodePoint > source.embeddingStartCodePoint;
}

export function partitionHistoricalEmbeddingWindows(
  meeting: AcceptedFinalMeetingV1,
  policy: HistoricalEmbeddingWindowPolicy,
  tokenizer?: HistoricalEmbeddingTokenizerPort,
): HistoricalEmbeddingPartitions {
  const countTokens = tokenizer?.countTokens.bind(tokenizer) ??
    estimateHistoricalEmbeddingTokens;
  const planner = planHistoricalEmbeddingWindows(meeting, policy);
  let step = planner.next();
  while (step.done !== true) {
    step = planner.next(
      step.value.kind === "count_tokens"
        ? countTokens(step.value.text)
        : undefined,
    );
  }
  return step.value;
}

/**
 * Provider-neutral deterministic planner. It yields text requiring an exact token
 * count and accepts that count on the following next call.
 */
export function* planHistoricalEmbeddingWindows(
  meeting: AcceptedFinalMeetingV1,
  policy: HistoricalEmbeddingWindowPolicy,
): Generator<HistoricalWindowPlanningAction, HistoricalEmbeddingPartitions, number | undefined> {
  const projections: HistoricalTurnProjection[] = [];
  for (const turn of meeting.humanTurns) {
    projections.push(...yield* splitTurn(
      turn,
      policy.maximumEmbeddingTokens,
      policy.maxBlockUtf8Bytes,
    ));
  }
  const overlapCandidates = [...new Set([policy.turnOverlap, 1, 0])]
    .filter((overlap) => overlap <= policy.turnOverlap);
  for (const effectiveTurnOverlap of overlapCandidates) {
    const windows = yield* partitionProjections(
      projections,
      policy,
      effectiveTurnOverlap,
    );
    if (windows.length <= policy.maxBlocksPerMeeting) {
      return Object.freeze({ effectiveTurnOverlap, windows });
    }
  }
  throw new RangeError(
    "accepted meeting requires more evidence blocks than the qualified policy permits",
  );
}

function* partitionProjections(
  projections: readonly HistoricalTurnProjection[],
  policy: HistoricalEmbeddingWindowPolicy,
  effectiveTurnOverlap: number,
): Generator<HistoricalWindowPlanningAction, readonly (readonly HistoricalTurnProjection[])[], number | undefined> {
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
      const outsideStructuralBound = candidate.length > maximumWindowSize ||
        byteLength(candidateText) > policy.maxBlockUtf8Bytes;
      const outsideTokenBound = outsideStructuralBound
        ? false
        : requireTokenCount(yield Object.freeze({
          kind: "count_tokens",
          text: candidateText,
        })) > policy.maximumEmbeddingTokens;
      if (current.length > 0 && (outsideStructuralBound || outsideTokenBound)) {
        break;
      }
      if (outsideStructuralBound || outsideTokenBound) {
        throw new RangeError("one historical projection exceeds its qualified bounds");
      }
      current.push(projections[index]!);
    }
    partitions.push(Object.freeze(current));
    const overlap = current.length > effectiveTurnOverlap + 1
      ? effectiveTurnOverlap
      : 0;
    start += Math.max(1, current.length - overlap);
  }
  return Object.freeze(partitions);
}

function* splitTurn(
  turn: AcceptedFinalMeetingV1["humanTurns"][number],
  maximumTokens: number,
  maximumUtf8Bytes: number,
): Generator<HistoricalWindowPlanningAction, readonly HistoricalTurnProjection[], number | undefined> {
  const { characters, utf8PrefixBytes } = yield* readCodePoints(turn.text);
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
    let high = byteBoundEnd(utf8PrefixBytes, start, maximumUtf8Bytes);
    let fittingEnd = start;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const text = characters.slice(start, middle).join("").trimEnd();
      const count = requireTokenCount(yield Object.freeze({
        kind: "count_tokens",
        text,
      }));
      if (count <= maximumTokens) {
        fittingEnd = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (fittingEnd === start) {
      throw new RangeError(
        "authoritative turn " + turn.turnId + " cannot fit the token bound",
      );
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

function* readCodePoints(
  value: string,
): Generator<
  HistoricalWindowPlanningAction,
  Readonly<{ characters: readonly string[]; utf8PrefixBytes: readonly number[] }>,
  number | undefined
> {
  const characters: string[] = [];
  const utf8PrefixBytes = [0];
  for (const character of value) {
    characters.push(character);
    utf8PrefixBytes.push(utf8PrefixBytes.at(-1)! + byteLength(character));
    if (characters.length % 1_024 === 0) {
      yield Object.freeze({ kind: "checkpoint" });
    }
  }
  return Object.freeze({
    characters: Object.freeze(characters),
    utf8PrefixBytes: Object.freeze(utf8PrefixBytes),
  });
}

function byteBoundEnd(
  utf8PrefixBytes: readonly number[],
  start: number,
  maximumUtf8Bytes: number,
): number {
  let low = start + 1;
  let high = utf8PrefixBytes.length - 1;
  let fitting = start;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (utf8PrefixBytes[middle]! - utf8PrefixBytes[start]! <= maximumUtf8Bytes) {
      fitting = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return fitting;
}

function requireTokenCount(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("exact historical token count is invalid");
  }
  return value;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
