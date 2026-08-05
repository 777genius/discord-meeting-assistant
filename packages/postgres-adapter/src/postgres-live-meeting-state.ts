import type { LiveMeetingSnapshot } from "@discord-meeting/meeting-core";
import type { Pool, PoolClient } from "pg";

import {
  MeetingPersistenceConflictError,
  type MeetingPersistenceConflict,
} from "./errors.js";
import {
  type ComparedLiveMeetingRow,
  type StoredLiveMeetingRow,
  normalizeLiveMeetingSnapshot,
  requireExpectedLiveRevision,
  restoreStoredLiveMeeting,
} from "./postgres-live-meeting-codec.js";

export type LiveMeetingQueryExecutor = Pool | PoolClient;

export class PostgresLiveMeetingStateStore {
  public constructor(private readonly pool: Pool) {}

  public findById(meetingId: string): Promise<LiveMeetingSnapshot | null> {
    return this.findByIdWithExecutor(this.pool, meetingId);
  }

  public async findByIdWithExecutor(
    executor: LiveMeetingQueryExecutor,
    meetingId: string,
  ): Promise<LiveMeetingSnapshot | null> {
    const result = await executor.query<StoredLiveMeetingRow>(
      `
        SELECT revision::float8 AS revision, snapshot
        FROM meeting_core.live_meetings
        WHERE meeting_id = $1
      `,
      [meetingId],
    );
    const row = result.rows[0];
    return row === undefined ? null : restoreStoredLiveMeeting(row, meetingId);
  }

  public async save(
    snapshot: LiveMeetingSnapshot,
    expectedRevision: number | null,
  ): Promise<void> {
    await this.saveWithExecutor(this.pool, snapshot, expectedRevision);
  }

  public async saveWithExecutor(
    executor: LiveMeetingQueryExecutor,
    snapshot: LiveMeetingSnapshot,
    expectedRevision: number | null,
  ): Promise<void> {
    const normalized = normalizeLiveMeetingSnapshot(snapshot);
    if (expectedRevision === null) {
      await this.insertOrReplay(executor, normalized);
      return;
    }
    requireExpectedLiveRevision(expectedRevision);
    if (normalized.revision <= expectedRevision) {
      throw new RangeError("updated live snapshot must advance expectedRevision");
    }
    await this.updateOrReplay(executor, normalized, expectedRevision);
  }

  private async insertOrReplay(
    executor: LiveMeetingQueryExecutor,
    snapshot: LiveMeetingSnapshot,
  ): Promise<void> {
    const inserted = await executor.query(
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
    const current = await this.compareCurrent(executor, snapshot);
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
    executor: LiveMeetingQueryExecutor,
    snapshot: LiveMeetingSnapshot,
    expectedRevision: number,
  ): Promise<void> {
    const updated = await executor.query(
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
    const current = await this.compareCurrent(executor, snapshot);
    if (current !== null && this.isReplay(current, snapshot)) {
      return;
    }
    throw new MeetingPersistenceConflictError(
      this.revisionConflict(current, snapshot, expectedRevision),
    );
  }

  private async compareCurrent(
    executor: LiveMeetingQueryExecutor,
    snapshot: LiveMeetingSnapshot,
  ): Promise<ComparedLiveMeetingRow | null> {
    const result = await executor.query<ComparedLiveMeetingRow>(
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

  private revisionConflict(
    current: ComparedLiveMeetingRow | null,
    snapshot: LiveMeetingSnapshot,
    expectedRevision: number,
  ): MeetingPersistenceConflict {
    if (current === null) {
      return {
        actualRevision: null,
        attemptedRevision: snapshot.revision,
        expectedRevision,
        kind: "meeting-not-found",
        meetingId: snapshot.meetingId,
      };
    }
    return {
      actualRevision: current.revision,
      attemptedRevision: snapshot.revision,
      expectedRevision,
      kind: "revision-mismatch",
      meetingId: snapshot.meetingId,
    };
  }
}
