import {
  LiveMeeting,
  TranscriptTurn,
  type LiveFinalizedTurn,
  type LiveMeetingSnapshot,
  type TranscriptTurnSnapshot,
} from "@discord-meeting/meeting-core";

import { CorruptMeetingSnapshotError } from "./errors.js";

export interface StoredLiveMeetingRow {
  readonly revision: number;
  readonly snapshot: unknown;
}

export interface ComparedLiveMeetingRow extends StoredLiveMeetingRow {
  readonly snapshot_matches: boolean;
}

interface StoredLiveTurnRow {
  readonly is_summarized: boolean;
  readonly turn: unknown;
}

export function normalizeLiveMeetingSnapshot(
  snapshot: LiveMeetingSnapshot,
): LiveMeetingSnapshot {
  return LiveMeeting.restore(snapshot).toSnapshot();
}

export function normalizeLiveTurn(turn: TranscriptTurnSnapshot): TranscriptTurnSnapshot {
  return TranscriptTurn.create(turn).toSnapshot();
}

export function restoreStoredLiveMeeting(
  row: StoredLiveMeetingRow,
  meetingId: string,
): LiveMeetingSnapshot {
  try {
    const snapshot = LiveMeeting.restore(row.snapshot as LiveMeetingSnapshot).toSnapshot();
    if (snapshot.meetingId !== meetingId || snapshot.revision !== row.revision) {
      throw new Error("stored live row metadata does not match its snapshot");
    }
    return snapshot;
  } catch (error) {
    throw new CorruptMeetingSnapshotError(meetingId, { cause: error });
  }
}

export function restoreStoredLiveTurn(
  row: StoredLiveTurnRow,
  meetingId: string,
): LiveFinalizedTurn {
  try {
    return {
      isSummarized: row.is_summarized,
      turn: TranscriptTurn.create(row.turn as TranscriptTurnSnapshot).toSnapshot(),
    };
  } catch (error) {
    throw new CorruptMeetingSnapshotError(meetingId, { cause: error });
  }
}

export function requireExpectedLiveRevision(expectedRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new RangeError("expectedRevision must be a non-negative safe integer or null");
  }
}
