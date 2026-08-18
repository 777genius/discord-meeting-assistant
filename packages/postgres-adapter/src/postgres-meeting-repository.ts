import {
  Meeting,
  type MeetingRepository,
  type MeetingSnapshot,
} from "@discord-meeting/meeting-core/meeting-lifecycle";
import {
  type PostCallDeadLetterAppendResult,
  type PostCallDeadLetterEvidence,
  type PostCallDeadLetterLedger,
  type PostCallDeadLetterRecord,
  type PostCallOutbox,
  type PostCallTerminalFailureSettlement,
  type PostCallWorkItem,
} from "@discord-meeting/meeting-core/post-call-workflow";
import type { Pool, PoolClient } from "pg";

import {
  CorruptMeetingSnapshotError,
  MeetingPersistenceConflictError,
} from "./errors.js";
import { sameRecordedMeetingIdentity } from "./meeting-replay-identity.js";
import { projectAcceptedHistoricalRelease } from "./postgres-historical-release-projection.js";
import { PostgresPostCallTerminalSettlement } from "./postgres-post-call-terminal-settlement.js";

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

interface RecoverablePostCallRow {
  readonly meeting_id: string;
  readonly recovery_generation: number;
  readonly schema_version: number;
}

function requireExpectedRevision(expectedRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new RangeError("expectedRevision must be a non-negative safe integer");
  }
}

function requirePostCallLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError("post-call outbox limit must be between 1 and 1000");
  }
}

function assertPostCallSchemaVersion(value: number): 1 {
  if (value !== 1) {
    throw new Error("unsupported post-call schema version");
  }
  return 1;
}

function assertRecoveryGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("invalid post-call recovery generation");
  }
  return value;
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

export class PostgresMeetingRepository implements
  MeetingRepository,
  PostCallDeadLetterLedger,
  PostCallOutbox,
  PostCallTerminalFailureSettlement
{
  readonly #terminalFailures: PostgresPostCallTerminalSettlement;

  public constructor(private readonly pool: Pool) {
    this.#terminalFailures = new PostgresPostCallTerminalSettlement(pool);
  }

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
      await projectAcceptedHistoricalRelease(client, normalized);
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
    transcriptionExecutionBinding: string,
  ): Promise<void> {
    requireExpectedRevision(expectedRevision);
    const normalized = normalizeSnapshot(snapshot);
    if (normalized.revision !== 0 || expectedRevision !== 0) {
      throw new RangeError("recordAndSchedule requires an initial revision-zero snapshot");
    }
    const client = await this.pool.connect();
    const requiredBinding = requireTranscriptionExecutionBinding(transcriptionExecutionBinding);
    try {
      await client.query("BEGIN");
      await this.insertRecordedOrValidateExisting(client, normalized);
      await client.query(
        `
          INSERT INTO meeting_core.post_call_outbox (
            meeting_id,
            schema_version,
            transcription_execution_binding,
            transcription_execution_binding_required
          )
          VALUES ($1, 1, $2, TRUE)
          ON CONFLICT (meeting_id) DO NOTHING
        `,
        [normalized.meetingId, requiredBinding],
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
    if (sameRecordedMeetingIdentity(currentSnapshot, snapshot)) {
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

  public async listRecoverablePostCall(limit = 100): Promise<readonly PostCallWorkItem[]> {
    requirePostCallLimit(limit);
    const result = await this.pool.query<RecoverablePostCallRow>(
      `
        SELECT meeting_id, schema_version::float8 AS schema_version,
               recovery_generation::float8 AS recovery_generation
        FROM meeting_core.post_call_outbox
        WHERE processed_at IS NULL
          AND dead_lettered_at IS NULL
          AND (recovery_after IS NULL OR recovery_after <= transaction_timestamp())
        ORDER BY COALESCE(recovery_after, created_at), meeting_id
        LIMIT $1
      `,
      [limit],
    );
    return result.rows.map((row) => {
      return Object.freeze({
        meetingId: row.meeting_id,
        recoveryGeneration: assertRecoveryGeneration(row.recovery_generation),
        schemaVersion: assertPostCallSchemaVersion(row.schema_version),
      });
    });
  }

  public async markPostCallEnqueued(meetingId: string): Promise<void> {
    const result = await this.pool.query(
      `
        UPDATE meeting_core.post_call_outbox
        SET last_enqueued_at = transaction_timestamp()
        WHERE meeting_id = $1
          AND dead_lettered_at IS NULL
      `,
      [meetingId],
    );
    if (result.rowCount !== 1) {
      throw new Error("unexpected post-call outbox update count");
    }
  }

  public async markPostCallProcessed(meetingId: string): Promise<void> {
    const result = await this.pool.query(
      `
        UPDATE meeting_core.post_call_outbox
        SET processed_at = COALESCE(processed_at, transaction_timestamp())
        WHERE meeting_id = $1
          AND dead_lettered_at IS NULL
      `,
      [meetingId],
    );
    if (result.rowCount !== 1) {
      throw new Error("post-call processing receipt does not reference one outbox item");
    }
  }

  public async recordPostCallDeadLetter(
    record: PostCallDeadLetterRecord,
  ): Promise<PostCallDeadLetterAppendResult> {
    return this.#terminalFailures.record(record);
  }

  public async settlePostCallFailure(
    record: PostCallDeadLetterRecord,
  ): Promise<PostCallDeadLetterAppendResult> {
    return this.#terminalFailures.settle(record);
  }

  public async listPostCallDeadLetters(
    limit = 100,
  ): Promise<readonly PostCallDeadLetterEvidence[]> {
    requirePostCallLimit(limit);
    return this.#terminalFailures.list(limit);
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

const maximumTranscriptionExecutionBindingLength = 128;

function requireTranscriptionExecutionBinding(binding: string): string {
  if (
    binding.length < 1 ||
    binding.length > maximumTranscriptionExecutionBindingLength ||
    !/^[a-z0-9][a-z0-9._:-]*$/u.test(binding)
  ) {
    throw new RangeError("transcription execution binding is invalid");
  }
  return binding;
}
