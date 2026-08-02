import {
  LiveMeeting,
  type LiveMeetingRepository,
  type LiveMeetingSnapshot,
} from "@discord-meeting/meeting-core";
import type { Pool } from "pg";

import {
  CorruptMeetingSnapshotError,
  MeetingPersistenceConflictError,
} from "./errors.js";

interface StoredLiveMeetingRow {
  readonly revision: number;
  readonly snapshot: unknown;
}

interface ComparedLiveMeetingRow extends StoredLiveMeetingRow {
  readonly snapshot_matches: boolean;
}

function normalizeSnapshot(snapshot: LiveMeetingSnapshot): LiveMeetingSnapshot {
  return LiveMeeting.restore(snapshot).toSnapshot();
}

function restoreStoredSnapshot(
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

function requireExpectedRevision(expectedRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new RangeError("expectedRevision must be a non-negative safe integer or null");
  }
}

export class PostgresLiveMeetingRepository implements LiveMeetingRepository {
  public constructor(private readonly pool: Pool) {}

  public async findById(meetingId: string): Promise<LiveMeetingSnapshot | null> {
    const result = await this.pool.query<StoredLiveMeetingRow>(
      `
        SELECT revision::float8 AS revision, snapshot
        FROM meeting_core.live_meetings
        WHERE meeting_id = $1
      `,
      [meetingId],
    );
    const row = result.rows[0];
    return row === undefined ? null : restoreStoredSnapshot(row, meetingId);
  }

  public async save(
    snapshot: LiveMeetingSnapshot,
    expectedRevision: number | null,
  ): Promise<void> {
    const normalized = normalizeSnapshot(snapshot);
    if (expectedRevision === null) {
      await this.insertOrReplay(normalized);
      return;
    }
    requireExpectedRevision(expectedRevision);
    if (normalized.revision <= expectedRevision) {
      throw new RangeError("updated live snapshot must advance expectedRevision");
    }
    await this.updateOrReplay(normalized, expectedRevision);
  }

  private async insertOrReplay(snapshot: LiveMeetingSnapshot): Promise<void> {
    const inserted = await this.pool.query(
      `
        INSERT INTO meeting_core.live_meetings (meeting_id, revision, snapshot)
        VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (meeting_id) DO NOTHING
        RETURNING meeting_id
      `,
      [snapshot.meetingId, snapshot.revision, snapshot],
    );
    if (inserted.rowCount === 1) {
      return;
    }
    const current = await this.compareCurrent(snapshot);
    if (current !== null && this.isReplay(current, snapshot)) {
      return;
    }
    throw new MeetingPersistenceConflictError({
      actualRevision: current?.revision ?? 0,
      attemptedRevision: snapshot.revision,
      expectedRevision: 0,
      kind: "meeting-already-exists",
      meetingId: snapshot.meetingId,
    });
  }

  private async updateOrReplay(
    snapshot: LiveMeetingSnapshot,
    expectedRevision: number,
  ): Promise<void> {
    const updated = await this.pool.query(
      `
        UPDATE meeting_core.live_meetings
        SET revision = $2,
            snapshot = $3::jsonb,
            updated_at = transaction_timestamp()
        WHERE meeting_id = $1
          AND revision = $4
        RETURNING meeting_id
      `,
      [snapshot.meetingId, snapshot.revision, snapshot, expectedRevision],
    );
    if (updated.rowCount === 1) {
      return;
    }
    const current = await this.compareCurrent(snapshot);
    if (current !== null && this.isReplay(current, snapshot)) {
      return;
    }
    if (current === null) {
      throw new MeetingPersistenceConflictError({
        actualRevision: null,
        attemptedRevision: snapshot.revision,
        expectedRevision,
        kind: "meeting-not-found",
        meetingId: snapshot.meetingId,
      });
    }
    throw new MeetingPersistenceConflictError({
      actualRevision: current.revision,
      attemptedRevision: snapshot.revision,
      expectedRevision,
      kind: "revision-mismatch",
      meetingId: snapshot.meetingId,
    });
  }

  private async compareCurrent(
    snapshot: LiveMeetingSnapshot,
  ): Promise<ComparedLiveMeetingRow | null> {
    const result = await this.pool.query<ComparedLiveMeetingRow>(
      `
        SELECT revision::float8 AS revision,
               snapshot,
               snapshot = $2::jsonb AS snapshot_matches
        FROM meeting_core.live_meetings
        WHERE meeting_id = $1
      `,
      [snapshot.meetingId, snapshot],
    );
    return result.rows[0] ?? null;
  }

  private isReplay(
    current: ComparedLiveMeetingRow,
    snapshot: LiveMeetingSnapshot,
  ): boolean {
    return current.revision === snapshot.revision && current.snapshot_matches;
  }
}
