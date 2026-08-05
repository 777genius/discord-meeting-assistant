import type {
  LiveGenerationTelemetrySnapshot,
  LiveGenerationUsageSnapshot,
} from "../domain/live-generation.js";
import type {
  LiveMeeting,
  LiveMeetingSnapshot,
} from "../domain/live-meeting.js";
import type { StageFailure } from "../domain/meeting.js";
import type { TranscriptTurnSnapshot } from "../domain/transcript.js";
import {
  currentTurns,
  type CurrentLiveMeeting,
} from "./live-meeting-refresh-planning.js";

export interface GenerationBase {
  readonly draftSummaryRevision: number | null;
  readonly evidenceTurns: readonly TranscriptTurnSnapshot[];
  readonly status: LiveMeetingSnapshot["status"];
}

export interface GeneratedResult {
  readonly failure?: StageFailure;
  readonly generated: boolean;
  readonly stale: boolean;
  readonly telemetry?: LiveGenerationTelemetrySnapshot;
  readonly usage?: LiveGenerationUsageSnapshot;
}

export const maximumCompatibleGenerationSaveAttempts = 3;

export function estimateSchedulingTokens(
  turns: readonly TranscriptTurnSnapshot[],
): number {
  const characters = turns.reduce((total, turn) => total + turn.text.length, 0);
  return Math.ceil(characters / 3);
}

export function unexpectedLiveRefreshFailure(
  stage: "generation" | "projection",
  error: unknown,
): StageFailure {
  return {
    code: `UNEXPECTED_LIVE_${stage.toUpperCase()}_FAILURE`,
    message: error instanceof Error ? error.message : `Unexpected live ${stage} failure`,
    retryable: true,
  };
}

export function invalidGenerationFailure(error: unknown): StageFailure {
  return {
    code: "INVALID_LIVE_SUMMARY_OUTPUT",
    message: error instanceof Error ? error.message : "Invalid live summary output",
    retryable: false,
  };
}

export function generationBaseSnapshot(
  meeting: LiveMeeting,
  turns: readonly TranscriptTurnSnapshot[],
): GenerationBase {
  return {
    draftSummaryRevision: meeting.draftSummary?.revision ?? null,
    evidenceTurns: turns.map((turn) => ({ ...turn })),
    status: meeting.status,
  };
}

export function isCompatibleGenerationBase(
  current: CurrentLiveMeeting,
  base: GenerationBase,
): boolean {
  return current.snapshot.status === base.status &&
    (current.snapshot.draftSummary?.revision ?? null) === base.draftSummaryRevision &&
    containsUnchangedEvidence(currentTurns(current.timeline), base.evidenceTurns);
}

export function generationBaseKey(
  meeting: LiveMeeting,
  turns: readonly TranscriptTurnSnapshot[],
): string {
  const nextSummaryRevision = (meeting.draftSummary?.revision ?? 0) + 1;
  return operationIdentity(
    "live-evidence-summary:v3",
    meeting.meetingId,
    String(nextSummaryRevision),
    meeting.status,
    String(turns.length),
    turns.at(-1)?.turnId ?? "none",
  );
}

function containsUnchangedEvidence(
  turns: readonly TranscriptTurnSnapshot[],
  evidenceTurns: readonly TranscriptTurnSnapshot[],
): boolean {
  const turnsById = new Map(turns.map((turn) => [turn.turnId, turn]));
  return evidenceTurns.every((evidenceTurn) => {
    const currentTurn = turnsById.get(evidenceTurn.turnId);
    return currentTurn !== undefined && sameTurn(currentTurn, evidenceTurn);
  });
}

function sameTurn(
  left: TranscriptTurnSnapshot,
  right: TranscriptTurnSnapshot,
): boolean {
  return left.turnId === right.turnId &&
    left.speakerId === right.speakerId &&
    left.startMs === right.startMs &&
    left.endMs === right.endMs &&
    left.text === right.text;
}

function operationIdentity(
  operation: string,
  ...parts: readonly string[]
): string {
  return [operation, ...parts.map(identityPart)].join("|");
}

function identityPart(value: string): string {
  return `${value.length}:${value}`;
}
