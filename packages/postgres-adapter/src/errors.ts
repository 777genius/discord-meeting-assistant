export type MeetingPersistenceConflict =
  | {
      readonly actualRevision: number;
      readonly attemptedRevision: number;
      readonly expectedRevision: number;
      readonly kind: "meeting-already-exists";
      readonly meetingId: string;
    }
  | {
      readonly actualRevision: null;
      readonly attemptedRevision: number;
      readonly expectedRevision: number;
      readonly kind: "meeting-not-found";
      readonly meetingId: string;
    }
  | {
      readonly actualRevision: number;
      readonly attemptedRevision: number;
      readonly expectedRevision: number;
      readonly kind: "revision-mismatch";
      readonly meetingId: string;
    };

function conflictMessage(conflict: MeetingPersistenceConflict): string {
  if (conflict.kind === "meeting-not-found") {
    return `meeting ${conflict.meetingId} does not exist for revision ${conflict.expectedRevision}`;
  }

  if (conflict.kind === "meeting-already-exists") {
    return `meeting ${conflict.meetingId} already exists with revision ${conflict.actualRevision}`;
  }

  return `meeting ${conflict.meetingId} revision conflict: expected ${conflict.expectedRevision}, actual ${conflict.actualRevision}`;
}

export class MeetingPersistenceConflictError extends Error {
  public readonly code = "MEETING_PERSISTENCE_CONFLICT";

  public constructor(public readonly conflict: MeetingPersistenceConflict) {
    super(conflictMessage(conflict));
    this.name = "MeetingPersistenceConflictError";
  }
}

export class CorruptMeetingSnapshotError extends Error {
  public readonly code = "CORRUPT_MEETING_SNAPSHOT";

  public constructor(
    public readonly meetingId: string,
    options: ErrorOptions,
  ) {
    super(`stored snapshot for meeting ${meetingId} is invalid`, options);
    this.name = "CorruptMeetingSnapshotError";
  }
}

export class PostCallDeadLetterConflictError extends Error {
  public readonly code = "POST_CALL_DEAD_LETTER_CONFLICT";

  public constructor(sourceJobRef: string) {
    super(`post-call dead-letter ${sourceJobRef} was replayed with different evidence`);
    this.name = "PostCallDeadLetterConflictError";
  }
}
