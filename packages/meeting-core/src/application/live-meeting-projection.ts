import { LiveMeeting } from "../domain/live-meeting.js";
import type { StageFailure } from "../domain/meeting.js";
import type {
  LiveCaptionSnapshot,
  LiveMeetingProjectionPhase,
  LiveMeetingProjectionPort,
  LiveMeetingStateRepository,
} from "./ports/live-meeting.js";

export interface LiveProjectionResult {
  readonly failure?: StageFailure;
  readonly projected: boolean;
}

export interface PublishLiveMeetingProjectionInput {
  readonly captions: readonly LiveCaptionSnapshot[];
  readonly elapsedMs: number;
  readonly meeting: LiveMeeting;
  readonly nowMs: number;
  readonly phase: LiveMeetingProjectionPhase;
}

const maximumProjectionSaveAttempts = 3;

function projectionIdentityPart(value: string): string {
  return `${value.length}:${value}`;
}

function projectionIdempotencyKey(meeting: LiveMeeting): string {
  return [
    "meeting-live-projection:v1",
    meeting.meetingId,
    meeting.publicationTargetId,
  ].map(projectionIdentityPart).join("|");
}

function unexpectedProjectionFailure(error: unknown): StageFailure {
  return {
    code: "UNEXPECTED_LIVE_PROJECTION_FAILURE",
    message: error instanceof Error ? error.message : "Unexpected live projection failure",
    retryable: true,
  };
}

/** Coordinates projection publication and compact receipt CAS reconciliation. */
export class LiveMeetingProjectionCoordinator {
  public constructor(
    private readonly meetings: LiveMeetingStateRepository,
    private readonly projector: LiveMeetingProjectionPort,
  ) {}

  public async publish(input: PublishLiveMeetingProjectionInput): Promise<LiveProjectionResult> {
    let meeting = input.meeting;
    for (let attempt = 0; attempt < maximumProjectionSaveAttempts; attempt += 1) {
      const projectedRevision = meeting.revision;
      let result;
      try {
        result = await this.projector.publish({
          captions: input.captions,
          currentExternalPublicationId: meeting.projectionExternalId,
          elapsedMs: input.elapsedMs,
          idempotencyKey: projectionIdempotencyKey(meeting),
          meetingId: meeting.meetingId,
          phase: input.phase,
          publicationTargetId: meeting.publicationTargetId,
          revision: projectedRevision,
          status: meeting.status,
          summary: meeting.draftSummary,
          updatedAtMs: input.nowMs,
        });
      } catch (error) {
        return { failure: unexpectedProjectionFailure(error), projected: false };
      }
      if (!result.ok) {
        return { failure: result.failure, projected: false };
      }

      const expectedRevision = meeting.revision;
      try {
        const receiptChanged = meeting.completeProjection(
          result.value.externalPublicationId,
          projectedRevision,
        );
        if (receiptChanged) {
          await this.meetings.save(meeting.toSnapshot(), expectedRevision);
        }
        return { projected: true };
      } catch (error) {
        const latest = await this.meetings.findById(meeting.meetingId);
        if (latest === null) {
          return {
            failure: unexpectedProjectionFailure(
              new Error("Live meeting disappeared after projection publication"),
            ),
            projected: false,
          };
        }
        if (
          latest.projectionExternalId === result.value.externalPublicationId &&
          latest.projectedRevision >= projectedRevision
        ) {
          return { projected: true };
        }
        if (latest.revision === expectedRevision) {
          return { failure: unexpectedProjectionFailure(error), projected: false };
        }
        meeting = LiveMeeting.restore(latest);
      }
    }
    return {
      failure: {
        code: "LIVE_PROJECTION_CONFLICT",
        message: "Live projection changed concurrently during receipt reconciliation",
        retryable: true,
      },
      projected: false,
    };
  }
}
