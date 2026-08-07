import { DomainInvariantError } from "../domain/errors.js";
import { LiveMeeting, type StartLiveMeetingInput } from "../domain/live-meeting.js";
import {
  TranscriptTurn,
  type TranscriptTurnSnapshot,
} from "../../transcription/index.js";
import type {
  LiveMeetingSnapshotAndTimeline,
  LiveMeetingSnapshotAndTimelineReader,
  LiveMeetingStateRepository,
  LiveMeetingTimelineRepository,
} from "./ports/live-meeting.js";

export interface StartLiveMeetingDependencies {
  readonly meetings: LiveMeetingSnapshotAndTimelineReader &
    LiveMeetingStateRepository;
}

export type StartLiveMeetingResult =
  | {
      readonly finalizedTurns: readonly TranscriptTurnSnapshot[];
      readonly lifecycleStatus: "active";
      readonly status: "started";
    }
  | {
      readonly finalizedTurns: readonly TranscriptTurnSnapshot[];
      readonly lifecycleStatus: "active" | "ended";
      readonly status: "reused";
    };

const maximumLifecycleReconciliationAttempts = 3;

export class StartLiveMeeting {
  public constructor(private readonly dependencies: StartLiveMeetingDependencies) {}

  public async execute(input: StartLiveMeetingInput): Promise<StartLiveMeetingResult> {
    for (let attempt = 1; attempt <= maximumLifecycleReconciliationAttempts; attempt += 1) {
      const existing = await this.dependencies.meetings.readSnapshotAndTimeline(input.meetingId);
      if (existing !== null) {
        return this.reuse(existing, input);
      }

      const meeting = LiveMeeting.start(input);
      try {
        await this.dependencies.meetings.save(meeting.toSnapshot(), null);
        return { finalizedTurns: [], lifecycleStatus: "active", status: "started" };
      } catch (error) {
        if (!isPersistenceConflict(error) || attempt === maximumLifecycleReconciliationAttempts) {
          throw error;
        }
      }
    }
    throw new Error("live meeting start reconciliation did not terminate");
  }

  private async reuse(
    current: LiveMeetingSnapshotAndTimeline,
    input: StartLiveMeetingInput,
  ): Promise<StartLiveMeetingResult> {
    const meeting = LiveMeeting.restore(current.snapshot);
    if (
      meeting.publicationTargetId !== input.publicationTargetId ||
      meeting.startedAtMs !== input.startedAtMs
    ) {
      throw new DomainInvariantError(
        "CONFLICTING_COMPLETION",
        "live meeting identity was reused with different start data",
      );
    }
    return {
      finalizedTurns: current.timeline.map(({ turn }) => turn),
      lifecycleStatus: meeting.status,
      status: "reused",
    };
  }
}

export class AppendLiveTranscriptTurn {
  public constructor(private readonly timeline: LiveMeetingTimelineRepository) {}

  public execute(
    meetingId: string,
    turn: TranscriptTurnSnapshot,
  ): Promise<"appended" | "not-found" | "reused"> {
    return this.timeline.appendFinalizedTurn(meetingId, TranscriptTurn.create(turn).toSnapshot());
  }
}

export class FinishLiveMeeting {
  public constructor(private readonly meetings: LiveMeetingStateRepository) {}

  public async execute(
    meetingId: string,
    endedAtMs: number,
  ): Promise<"ended" | "not-found" | "reused"> {
    for (let attempt = 1; attempt <= maximumLifecycleReconciliationAttempts; attempt += 1) {
      const snapshot = await this.meetings.findById(meetingId);
      if (snapshot === null) {
        return "not-found";
      }
      const meeting = LiveMeeting.restore(snapshot);
      if (meeting.status === "ended") {
        return "reused";
      }
      const expectedRevision = meeting.revision;
      if (!meeting.end(endedAtMs)) {
        return "reused";
      }
      try {
        await this.meetings.save(meeting.toSnapshot(), expectedRevision);
        return "ended";
      } catch (error) {
        if (!isPersistenceConflict(error) || attempt === maximumLifecycleReconciliationAttempts) {
          throw error;
        }
      }
    }
    throw new Error("live meeting finish reconciliation did not terminate");
  }
}

function isPersistenceConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { readonly code?: unknown; readonly name?: unknown };
  return candidate.code === "MEETING_PERSISTENCE_CONFLICT" ||
    candidate.name === "MeetingPersistenceConflictError";
}

export {
  RefreshLiveMeeting,
  defaultLiveSummaryCadencePolicy,
  type LiveSummaryCadencePolicy,
  type RefreshLiveMeetingDependencies,
  type RefreshLiveMeetingInput,
  type RefreshLiveMeetingResult,
} from "./live-meeting-refresh.js";
