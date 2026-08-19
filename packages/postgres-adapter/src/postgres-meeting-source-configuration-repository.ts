import {
  MeetingSourceConfiguration,
  type ActiveMeetingRoom,
  type ActiveMeetingRoomReader,
  type MeetingSourceConfigurationRepository,
  type MeetingSourceConfigurationSaveResult,
  type MeetingSourceConfigurationSnapshot,
} from "@discord-meeting/meeting-routing-core";
import type { Pool } from "pg";

import { CorruptMeetingSnapshotError } from "./errors.js";

interface StoredMeetingSourceConfigurationRow {
  readonly revision: number;
  readonly snapshot: unknown;
}

interface StoredActiveMeetingSourceConfigurationRow extends
  StoredMeetingSourceConfigurationRow
{
  readonly source_id: string;
}

function normalize(
  snapshot: MeetingSourceConfigurationSnapshot,
): MeetingSourceConfigurationSnapshot {
  return MeetingSourceConfiguration.restore(snapshot).toSnapshot();
}

function restore(
  row: StoredMeetingSourceConfigurationRow,
  sourceId: string,
): MeetingSourceConfigurationSnapshot {
  try {
    const snapshot = MeetingSourceConfiguration.restore(
      row.snapshot as MeetingSourceConfigurationSnapshot,
    ).toSnapshot();
    if (snapshot.sourceId !== sourceId || snapshot.revision !== row.revision) {
      throw new Error(
        "stored meeting source configuration metadata does not match its snapshot",
      );
    }
    return snapshot;
  } catch (error) {
    throw new CorruptMeetingSnapshotError(`source:${sourceId}`, { cause: error });
  }
}

export class PostgresMeetingSourceConfigurationRepository implements
  ActiveMeetingRoomReader,
  MeetingSourceConfigurationRepository
{
  public constructor(private readonly pool: Pool) {}

  public async findBySourceId(
    sourceId: string,
  ): Promise<MeetingSourceConfigurationSnapshot | null> {
    const result = await this.pool.query<StoredMeetingSourceConfigurationRow>(
      `
        SELECT revision::float8 AS revision, snapshot
        FROM meeting_routing.source_configurations
        WHERE source_id = $1
      `,
      [sourceId],
    );
    const row = result.rows[0];
    return row === undefined ? null : restore(row, sourceId);
  }

  public async listActiveMeetingRooms(): Promise<readonly ActiveMeetingRoom[]> {
    const result = await this.pool.query<StoredActiveMeetingSourceConfigurationRow>(
      `
        SELECT source_id, revision::float8 AS revision, snapshot
        FROM meeting_routing.source_configurations
        WHERE snapshot ->> 'status' = 'active'
        ORDER BY source_id ASC
      `,
    );
    return result.rows.map((row) => {
      const snapshot = restore(row, row.source_id);
      return {
        roomId: snapshot.roomId,
        sourceId: snapshot.sourceId,
      };
    });
  }

  public async save(
    snapshot: MeetingSourceConfigurationSnapshot,
    expectedRevision: number | null,
  ): Promise<MeetingSourceConfigurationSaveResult> {
    const normalized = normalize(snapshot);
    if (expectedRevision === null) {
      if (normalized.revision !== 0) {
        throw new RangeError(
          "a new meeting source configuration must have revision zero",
        );
      }
      const inserted = await this.pool.query(
        `
          INSERT INTO meeting_routing.source_configurations
            (source_id, revision, snapshot)
          VALUES ($1, $2, $3::jsonb)
          ON CONFLICT (source_id) DO NOTHING
          RETURNING source_id
        `,
        [normalized.sourceId, normalized.revision, normalized],
      );
      if (inserted.rowCount === 1) {
        return { status: "saved" };
      }
      return this.conflict(normalized.sourceId);
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new RangeError(
        "expectedRevision must be a non-negative safe integer or null",
      );
    }
    if (normalized.revision !== expectedRevision + 1) {
      throw new RangeError(
        "updated meeting source configuration must advance one revision",
      );
    }
    const updated = await this.pool.query(
      `
        UPDATE meeting_routing.source_configurations
        SET revision = $2,
            snapshot = $3::jsonb,
            updated_at = transaction_timestamp()
        WHERE source_id = $1
          AND revision = $4
        RETURNING source_id
      `,
      [
        normalized.sourceId,
        normalized.revision,
        normalized,
        expectedRevision,
      ],
    );
    return updated.rowCount === 1
      ? { status: "saved" }
      : this.conflict(normalized.sourceId);
  }

  private async conflict(
    sourceId: string,
  ): Promise<MeetingSourceConfigurationSaveResult> {
    const result = await this.pool.query<{ readonly revision: number }>(
      `
        SELECT revision::float8 AS revision
        FROM meeting_routing.source_configurations
        WHERE source_id = $1
      `,
      [sourceId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(
        "meeting source configuration disappeared during compare-and-swap",
      );
    }
    return { actualRevision: row.revision, status: "conflict" };
  }
}
