import {
  Meeting,
  type MeetingRepository,
  type MeetingSnapshot,
} from "@discord-meeting/meeting-core";
import type { Pool, PoolClient } from "pg";

import {
  CorruptMeetingSnapshotError,
  MeetingPersistenceConflictError,
} from "./errors.js";

interface StoredMeetingRow {
  readonly revision: number;
  readonly snapshot: unknown;
}

interface LockedMeetingRow extends StoredMeetingRow {
  readonly snapshot_matches: boolean;
}

interface RevisionRow {
  readonly revision: number;
}

export interface PendingPostCall {
  readonly meetingId: string;
  readonly schemaVersion: 1;
}

interface PendingPostCallRow {
  readonly meeting_id: string;
  readonly schema_version: number;
}

function requireExpectedRevision(expectedRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new RangeError("expectedRevision must be a non-negative safe integer");
  }
}

function normalizeSnapshot(snapshot: MeetingSnapshot): MeetingSnapshot {
  return Meeting.restore(snapshot).toSnapshot();
}

function restoreStoredSnapshot(row: StoredMeetingRow, meetingId: string): MeetingSnapshot {
  try {
    const snapshot = Meeting.restore(row.snapshot as MeetingSnapshot).toSnapshot();
    if (snapshot.meetingId !== meetingId || snapshot.revision !== row.revision) {
      throw new Error("stored row metadata does not match its snapshot");
    }
    return snapshot;
  } catch (error) {
    throw new CorruptMeetingSnapshotError(meetingId, { cause: error });
  }
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the business or driver error that caused the rollback.
  }
}

function sameRecording(
  left: MeetingSnapshot["recording"],
  right: MeetingSnapshot["recording"],
): boolean {
  return left.recordingId === right.recordingId &&
    left.manifestLocator === right.manifestLocator &&
    left.speakerAudio.length === right.speakerAudio.length &&
    left.speakerAudio.every((track, index) => {
      const candidate = right.speakerAudio[index];
      return candidate !== undefined &&
        track.audioLocator === candidate.audioLocator &&
        track.speakerId === candidate.speakerId &&
        track.timelineOffsetMs === candidate.timelineOffsetMs;
    });
}

export class PostgresMeetingRepository implements MeetingRepository {
  public constructor(private readonly pool: Pool) {}

  public async findById(meetingId: string): Promise<MeetingSnapshot | null> {
    const result = await this.pool.query<StoredMeetingRow>(
      `
        SELECT revision::float8 AS revision, snapshot
        FROM meeting_core.meetings
        WHERE meeting_id = $1
      `,
      [meetingId],
    );
    const row = result.rows[0];
    return row === undefined ? null : restoreStoredSnapshot(row, meetingId);
  }

  public async save(
    snapshot: MeetingSnapshot,
    expectedRevision: number,
  ): Promise<void> {
    requireExpectedRevision(expectedRevision);
    const normalized = normalizeSnapshot(snapshot);
    if (normalized.revision < expectedRevision) {
      throw new RangeError("snapshot revision cannot be older than expectedRevision");
    }
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      await this.persist(client, normalized, expectedRevision);
      await client.query("COMMIT");
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async recordAndSchedule(
    snapshot: MeetingSnapshot,
    expectedRevision: number,
  ): Promise<void> {
    requireExpectedRevision(expectedRevision);
    const normalized = normalizeSnapshot(snapshot);
    if (normalized.revision !== 0 || expectedRevision !== 0) {
      throw new RangeError("recordAndSchedule requires an initial revision-zero snapshot");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.insertRecordedOrValidateExisting(client, normalized);
      await client.query(
        `
          INSERT INTO meeting_core.post_call_outbox (meeting_id, schema_version)
          VALUES ($1, 1)
          ON CONFLICT (meeting_id) DO NOTHING
        `,
        [normalized.meetingId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertRecordedOrValidateExisting(
    client: PoolClient,
    snapshot: MeetingSnapshot,
  ): Promise<void> {
    const inserted = await client.query<RevisionRow>(
      `
        INSERT INTO meeting_core.meetings (meeting_id, revision, snapshot)
        VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (meeting_id) DO NOTHING
        RETURNING revision::float8 AS revision
      `,
      [snapshot.meetingId, snapshot.revision, snapshot],
    );
    if (inserted.rowCount === 1) {
      return;
    }

    const current = await this.lockCurrent(client, snapshot);
    if (current === null) {
      throw new Error("meeting disappeared while validating a recording replay");
    }
    const currentSnapshot = restoreStoredSnapshot(current, snapshot.meetingId);
    if (
      currentSnapshot.publicationTargetId === snapshot.publicationTargetId &&
      sameRecording(currentSnapshot.recording, snapshot.recording)
    ) {
      return;
    }

    throw new MeetingPersistenceConflictError({
      actualRevision: current.revision,
      attemptedRevision: snapshot.revision,
      expectedRevision: 0,
      kind: "meeting-already-exists",
      meetingId: snapshot.meetingId,
    });
  }

  public async listPendingPostCall(limit = 100): Promise<readonly PendingPostCall[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("post-call outbox limit must be between 1 and 1000");
    }
    const result = await this.pool.query<PendingPostCallRow>(
      `
        SELECT meeting_id, schema_version::float8 AS schema_version
        FROM meeting_core.post_call_outbox
        WHERE dispatched_at IS NULL
        ORDER BY created_at, meeting_id
        LIMIT $1
      `,
      [limit],
    );
    return result.rows.map((row) => {
      if (row.schema_version !== 1) {
        throw new Error("unsupported post-call outbox schema version");
      }
      return Object.freeze({ meetingId: row.meeting_id, schemaVersion: 1 as const });
    });
  }

  public async markPostCallDispatched(meetingId: string): Promise<void> {
    const result = await this.pool.query(
      `
        UPDATE meeting_core.post_call_outbox
        SET dispatched_at = transaction_timestamp()
        WHERE meeting_id = $1
          AND dispatched_at IS NULL
      `,
      [meetingId],
    );
    if (result.rowCount !== 0 && result.rowCount !== 1) {
      throw new Error("unexpected post-call outbox update count");
    }
  }

  private async persist(
    client: PoolClient,
    normalized: MeetingSnapshot,
    expectedRevision: number,
  ): Promise<void> {
    if (normalized.revision === expectedRevision) {
      await this.insertOrReplay(client, normalized, expectedRevision);
    } else {
      await this.updateOrReplay(client, normalized, expectedRevision);
    }
  }

  private async insertOrReplay(
    client: PoolClient,
    snapshot: MeetingSnapshot,
    expectedRevision: number,
  ): Promise<void> {
    const inserted = await client.query<RevisionRow>(
      `
        INSERT INTO meeting_core.meetings (meeting_id, revision, snapshot)
        VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (meeting_id) DO NOTHING
        RETURNING revision::float8 AS revision
      `,
      [snapshot.meetingId, snapshot.revision, snapshot],
    );
    if (inserted.rowCount === 1) {
      return;
    }

    const current = await this.lockCurrent(client, snapshot);
    if (current !== null && this.isReplay(current, snapshot)) {
      return;
    }

    throw new MeetingPersistenceConflictError({
      actualRevision: current?.revision ?? expectedRevision,
      attemptedRevision: snapshot.revision,
      expectedRevision,
      kind: "meeting-already-exists",
      meetingId: snapshot.meetingId,
    });
  }

  private async updateOrReplay(
    client: PoolClient,
    snapshot: MeetingSnapshot,
    expectedRevision: number,
  ): Promise<void> {
    const updated = await client.query<RevisionRow>(
      `
        UPDATE meeting_core.meetings
        SET revision = $2,
            snapshot = $3::jsonb,
            updated_at = transaction_timestamp()
        WHERE meeting_id = $1
          AND revision = $4
        RETURNING revision::float8 AS revision
      `,
      [snapshot.meetingId, snapshot.revision, snapshot, expectedRevision],
    );
    if (updated.rowCount === 1) {
      return;
    }

    const current = await this.lockCurrent(client, snapshot);
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

  private async lockCurrent(
    client: PoolClient,
    snapshot: MeetingSnapshot,
  ): Promise<LockedMeetingRow | null> {
    const result = await client.query<LockedMeetingRow>(
      `
        SELECT revision::float8 AS revision,
               snapshot,
               snapshot = $2::jsonb AS snapshot_matches
        FROM meeting_core.meetings
        WHERE meeting_id = $1
        FOR UPDATE
      `,
      [snapshot.meetingId, snapshot],
    );
    return result.rows[0] ?? null;
  }

  private isReplay(
    current: LockedMeetingRow,
    snapshot: MeetingSnapshot,
  ): boolean {
    return current.revision === snapshot.revision && current.snapshot_matches;
  }
}
