import type { AcceptedFinalMeetingV1 } from "../domain/historical-evidence.js";
import type {
  HistoricalIndexPlannerResultV1,
  HistoricalPreparedWindowV1,
  HistoricalReceiptDigestPort,
  HistoricalWindowPlanningProfileV1,
} from "./ports/historical-index-planner.js";
import {
  historicalEmbeddingText,
  type HistoricalTurnProjection,
} from "./historical-embedding-windows.js";
import {
  HistoricalIndexPlanError,
  type HistoricalEvidenceBlockPolicyV1,
} from "./historical-index-plan-types.js";

export interface PreparedHistoricalWindowPolicy {
  readonly maximumEmbeddingTokens: number;
  readonly maxBlockUtf8Bytes: number;
  readonly maxBlocksPerMeeting: number;
  readonly maxTurnsPerBlock: number;
  readonly turnOverlap: number;
}

export function validatePreparedEnvelope(
  meeting: AcceptedFinalMeetingV1,
  candidatePolicy: HistoricalEvidenceBlockPolicyV1,
  prepared: HistoricalIndexPlannerResultV1,
  digest: HistoricalReceiptDigestPort,
): void {
  validatePreparedReceipt(meeting, candidatePolicy, prepared, digest);
  if (!validPlanningProfile(prepared.planningProfile)) {
    throw new HistoricalIndexPlanError(
      "STALE_PLAN",
      "historical window planning profile does not match the qualified profile",
    );
  }
}

export function validatePreparedWindows(
  meeting: AcceptedFinalMeetingV1,
  prepared: HistoricalIndexPlannerResultV1,
  policy: PreparedHistoricalWindowPolicy,
): readonly (readonly HistoricalTurnProjection[])[] {
  const allowedOverlaps = [...new Set([policy.turnOverlap, 1, 0])]
    .filter((overlap) => overlap <= policy.turnOverlap);
  if (!allowedOverlaps.includes(prepared.effectiveTurnOverlap) ||
    prepared.windows.length < 1 ||
    prepared.windows.length > policy.maxBlocksPerMeeting) {
    throw new HistoricalIndexPlanError(
      "BLOCK_LIMIT_EXCEEDED",
      "historical window result is outside the qualified policy",
    );
  }
  const projections = prepared.windows.map((window) =>
    validatePreparedWindow(meeting, window, policy)
  );
  validatePreparedTopology(meeting, projections, prepared.effectiveTurnOverlap);
  return Object.freeze(projections);
}

export function canonicalHistoricalPlannerJson(value: unknown): string {
  return JSON.stringify(canonicalHistoricalPlannerValue(value));
}

function canonicalHistoricalPlannerValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalHistoricalPlannerValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalHistoricalPlannerValue(entry)]));
  }
  return value;
}

function validatePreparedReceipt(
  meeting: AcceptedFinalMeetingV1,
  candidatePolicy: HistoricalEvidenceBlockPolicyV1,
  prepared: HistoricalIndexPlannerResultV1,
  digest: HistoricalReceiptDigestPort,
): void {
  const { receipt, ...result } = prepared;
  const expectedRequest = digest.digestUtf8(canonicalHistoricalPlannerJson({
    meeting,
    policy: candidatePolicy,
  }));
  const expectedResult = digest.digestUtf8(canonicalHistoricalPlannerJson(result));
  const expectedProfile = digest.digestUtf8(canonicalHistoricalPlannerJson({
    identity: prepared.planningProfile.identity,
    maximumInputTokens: prepared.planningProfile.maximumInputTokens,
  }));
  if (
    receipt.schemaVersion !==
      "meeting-knowledge.historical-index-planner-receipt.v1" ||
    receipt.workerRevision !== "meeting-knowledge.exact-window-planner.v1" ||
    receipt.requestSha256 !== expectedRequest ||
    receipt.resultSha256 !== expectedResult ||
    prepared.planningProfile.digestSha256 !== expectedProfile
  ) {
    throw new HistoricalIndexPlanError(
      "STALE_PLAN",
      "historical window planning receipt is invalid",
    );
  }
}

function validPlanningProfile(
  profile: HistoricalWindowPlanningProfileV1,
): boolean {
  return profile.schemaVersion === "meeting-knowledge.window-planning-profile.v1" &&
    profile.identity.length > 0 &&
    profile.identity.length <= 1_024 &&
    /^sha256:[a-f0-9]{64}$/u.test(profile.digestSha256) &&
    Number.isSafeInteger(profile.maximumInputTokens) &&
    profile.maximumInputTokens >= 16 &&
    profile.maximumInputTokens <= 512;
}

function validatePreparedWindow(
  meeting: AcceptedFinalMeetingV1,
  window: HistoricalPreparedWindowV1,
  policy: PreparedHistoricalWindowPolicy,
): readonly HistoricalTurnProjection[] {
  if (!Number.isSafeInteger(window.tokenCount) ||
    window.tokenCount < 1 ||
    window.tokenCount > policy.maximumEmbeddingTokens ||
    window.segments.length < 1 ||
    window.segments.length > Math.min(policy.maxTurnsPerBlock, 14)) {
    throw new HistoricalIndexPlanError(
      "BLOCK_LIMIT_EXCEEDED",
      "historical prepared window is outside count bounds",
    );
  }
  const turns = new Map(meeting.humanTurns.map((turn) => [turn.turnId, turn]));
  const projections = window.segments.map((segment) => {
    const turn = turns.get(segment.turnId);
    const characters = turn === undefined ? [] : Array.from(turn.text);
    if (turn === undefined ||
      !Number.isSafeInteger(segment.sourceStartCodePoint) ||
      !Number.isSafeInteger(segment.sourceEndCodePoint) ||
      segment.sourceStartCodePoint < 0 ||
      segment.sourceEndCodePoint <= segment.sourceStartCodePoint ||
      segment.sourceEndCodePoint > characters.length ||
      characters.slice(segment.sourceStartCodePoint, segment.sourceEndCodePoint)
        .join("") !== segment.text ||
      segment.text.length === 0) {
      throw new HistoricalIndexPlanError(
        "STALE_PLAN",
        "historical prepared segment does not match canonical evidence",
      );
    }
    return Object.freeze({
      sourceEndCodePoint: segment.sourceEndCodePoint,
      sourceStartCodePoint: segment.sourceStartCodePoint,
      text: segment.text,
      turn,
    });
  });
  const embeddingText = historicalEmbeddingText(projections);
  if (new TextEncoder().encode(embeddingText).byteLength > policy.maxBlockUtf8Bytes) {
    throw new HistoricalIndexPlanError(
      "BLOCK_LIMIT_EXCEEDED",
      "historical prepared window exceeds its UTF-8 bound",
    );
  }
  return Object.freeze(projections);
}

function validatePreparedTopology(
  meeting: AcceptedFinalMeetingV1,
  windows: readonly (readonly HistoricalTurnProjection[])[],
  effectiveTurnOverlap: number,
): void {
  const turnOrdinal = new Map(
    meeting.humanTurns.map((turn, ordinal) => [turn.turnId, ordinal]),
  );
  const canonical: HistoricalTurnProjection[] = [];
  let prior: readonly HistoricalTurnProjection[] | undefined;
  for (const window of windows) {
    const overlap = prior !== undefined && prior.length > effectiveTurnOverlap + 1
      ? effectiveTurnOverlap
      : 0;
    if (overlap > 0) {
      const suffix = prior!.slice(prior!.length - overlap);
      const prefix = window.slice(0, overlap);
      if (canonicalProjections(prefix) !== canonicalProjections(suffix)) {
        throw new HistoricalIndexPlanError(
          "STALE_PLAN",
          "historical prepared overlap does not match its prior window",
        );
      }
    }
    canonical.push(...window.slice(overlap));
    prior = window;
  }
  const covered = new Map(
    meeting.humanTurns.map((turn) => [
      turn.turnId,
      Array.from(turn.text).map(() => false),
    ]),
  );
  let previousOrdinal = -1;
  let previousEnd = -1;
  for (const projection of canonical) {
    const ordinal = turnOrdinal.get(projection.turn.turnId);
    const turnCoverage = covered.get(projection.turn.turnId);
    if (
      ordinal === undefined ||
      turnCoverage === undefined ||
      ordinal < previousOrdinal ||
      (ordinal === previousOrdinal &&
        projection.sourceStartCodePoint < previousEnd)
    ) {
      throw new HistoricalIndexPlanError(
        "STALE_PLAN",
        "historical prepared segments are not canonically ordered",
      );
    }
    for (
      let index = projection.sourceStartCodePoint;
      index < projection.sourceEndCodePoint;
      index += 1
    ) {
      if (turnCoverage[index] === true) {
        throw new HistoricalIndexPlanError(
          "STALE_PLAN",
          "historical prepared segments duplicate canonical evidence",
        );
      }
      turnCoverage[index] = true;
    }
    previousOrdinal = ordinal;
    previousEnd = projection.sourceEndCodePoint;
  }
  for (const turn of meeting.humanTurns) {
    const coverage = covered.get(turn.turnId) ?? [];
    if (Array.from(turn.text).some((character, index) =>
      !/^\s$/u.test(character) && coverage[index] !== true
    )) {
      throw new HistoricalIndexPlanError(
        "STALE_PLAN",
        "historical prepared segments omit canonical evidence",
      );
    }
  }
}

function canonicalProjections(
  projections: readonly HistoricalTurnProjection[],
): string {
  return JSON.stringify(projections.map((projection) => ({
    sourceEndCodePoint: projection.sourceEndCodePoint,
    sourceStartCodePoint: projection.sourceStartCodePoint,
    text: projection.text,
    turnId: projection.turn.turnId,
  })));
}
