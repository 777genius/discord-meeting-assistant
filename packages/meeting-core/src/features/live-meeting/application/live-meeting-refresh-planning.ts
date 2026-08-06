import {
  LiveMeeting,
  type LiveMeetingSnapshot,
} from "../domain/live-meeting.js";
import type { TranscriptTurnSnapshot } from "../../transcription/index.js";
import type {
  LiveCaptionSnapshot,
  LiveFinalizedTurn,
  LiveMeetingProjectionPhase,
} from "./ports/live-meeting.js";

export interface CurrentLiveMeeting {
  readonly snapshot: LiveMeetingSnapshot;
  readonly timeline: readonly LiveFinalizedTurn[];
}

export interface RefreshPlan {
  readonly canProject: boolean;
  readonly elapsedMs: number;
  readonly generationBase: string | undefined;
  readonly meeting: LiveMeeting;
  readonly newTurns: readonly TranscriptTurnSnapshot[];
  readonly nowMs: number;
  readonly projectionAllowed: boolean;
  readonly projectionPhase: LiveMeetingProjectionPhase;
  readonly shouldGenerate: boolean;
  readonly shouldProject: boolean;
  readonly turns: readonly TranscriptTurnSnapshot[];
}

export function currentTurns(
  timeline: readonly LiveFinalizedTurn[],
): readonly TranscriptTurnSnapshot[] {
  return timeline.map(({ turn }) => turn);
}

export function resolvedProjectionPhase(
  requestedPhase: LiveMeetingProjectionPhase | undefined,
  meeting: LiveMeeting,
): LiveMeetingProjectionPhase {
  return requestedPhase ?? (meeting.status === "ended" ? "finalizing" : "live");
}

export function hasVisibleCaption(captions: readonly LiveCaptionSnapshot[]): boolean {
  return captions.some(({ text }) => text.trim().length > 0);
}

export function isInitialProjectionDue(
  meeting: LiveMeeting,
  elapsedMs: number,
  visibleCaption: boolean,
  turnCount: number,
  publishAfterMs: number,
): boolean {
  const hasRecognizedEvidence = visibleCaption || turnCount > 0 || meeting.draftSummary !== null;
  return hasRecognizedEvidence && (
    meeting.status === "ended" || elapsedMs >= publishAfterMs || visibleCaption
  );
}

export function isProjectionDue(
  meeting: LiveMeeting,
  phase: LiveMeetingProjectionPhase,
  canProject: boolean,
  projectionRequested: boolean,
): boolean {
  return canProject && (
    phase === "finalizing" ||
    meeting.status === "ended" ||
    meeting.projectedRevision < meeting.revision ||
    projectionRequested
  );
}
