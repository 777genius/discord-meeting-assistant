import type {
  PostCallDeadLetterAppendResult,
  PostCallDeadLetterEvidence,
  PostCallDeadLetterRecord,
} from "@discord-meeting/meeting-core";
import type { Pool, PoolClient } from "pg";

import { PostCallDeadLetterConflictError } from "./errors.js";

interface StoredPostCallDeadLetterRow {
  readonly attempts_made: number;
  readonly failure_code: string;
  readonly meeting_id: string | null;
  readonly recorded_at: Date;
  readonly retryable: boolean;
  readonly schema_version: number;
  readonly source_job_ref: string;
}

interface PostCallOutboxTerminalRow {
  readonly dead_letter_source_job_ref: string | null;
  readonly processed_at: Date | null;
}

function normalizeRecord(
  record: PostCallDeadLetterRecord,
): PostCallDeadLetterRecord {
  if (!Number.isSafeInteger(record.attemptsMade) || record.attemptsMade < 1) {
    throw new RangeError("post-call dead-letter attemptsMade must be a positive safe integer");
  }
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(record.failureCode)) {
    throw new RangeError("post-call dead-letter failureCode is invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(record.sourceJobRef)) {
    throw new RangeError("post-call dead-letter sourceJobRef must be a SHA-256 hex digest");
  }
  const schemaVersion: unknown = record.schemaVersion;
  if (schemaVersion !== 1) {
    throw new Error("unsupported post-call schema version");
  }
  if (record.meetingId !== null && record.meetingId.trim().length === 0) {
    throw new RangeError("post-call dead-letter meetingId must not be blank");
  }
  return Object.freeze({ ...record });
}

function restoreRecord(
  row: StoredPostCallDeadLetterRow,
): PostCallDeadLetterEvidence {
  if (row.schema_version !== 1) {
    throw new Error("unsupported post-call schema version");
  }
  return Object.freeze({
    attemptsMade: row.attempts_made,
    failureCode: row.failure_code,
    meetingId: row.meeting_id,
    recordedAt: row.recorded_at.toISOString(),
    retryable: row.retryable,
    schemaVersion: 1,
    sourceJobRef: row.source_job_ref,
  });
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the error that caused rollback.
  }
}

export class PostgresPostCallTerminalSettlement {
  public constructor(private readonly pool: Pool) {}

  public async record(
    record: PostCallDeadLetterRecord,
  ): Promise<PostCallDeadLetterAppendResult> {
    return this.transaction(async (client) =>
      this.append(client, normalizeRecord(record))
    );
  }

  public async settle(
    record: PostCallDeadLetterRecord,
  ): Promise<PostCallDeadLetterAppendResult> {
    const normalized = normalizeRecord(record);
    return this.transaction(async (client) => {
      const outbox = normalized.meetingId === null
        ? undefined
        : await this.lockOutbox(client, normalized.meetingId);
      if (
        outbox !== undefined
        && outbox.dead_letter_source_job_ref !== null
        && outbox.dead_letter_source_job_ref !== normalized.sourceJobRef
      ) {
        throw new PostCallDeadLetterConflictError(normalized.sourceJobRef);
      }
      const result = await this.append(client, normalized);
      if (outbox !== undefined && outbox.processed_at === null) {
        await this.settleLockedOutbox(client, normalized);
      }
      return result;
    });
  }

  public async list(limit: number): Promise<readonly PostCallDeadLetterEvidence[]> {
    const result = await this.pool.query<StoredPostCallDeadLetterRow>(
      `
        SELECT source_job_ref, schema_version::float8 AS schema_version,
               meeting_id, attempts_made, failure_code, retryable, recorded_at
        FROM meeting_core.post_call_dead_letters
        ORDER BY recorded_at, source_job_ref
        LIMIT $1
      `,
      [limit],
    );
    return Object.freeze(result.rows.map(restoreRecord));
  }

  private async transaction<Result>(
    operation: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async append(
    client: PoolClient,
    record: PostCallDeadLetterRecord,
  ): Promise<PostCallDeadLetterAppendResult> {
    const inserted = await client.query(
      `
        INSERT INTO meeting_core.post_call_dead_letters
          (source_job_ref, schema_version, meeting_id, attempts_made, failure_code, retryable)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (source_job_ref) DO NOTHING
        RETURNING source_job_ref
      `,
      [
        record.sourceJobRef,
        record.schemaVersion,
        record.meetingId,
        record.attemptsMade,
        record.failureCode,
        record.retryable,
      ],
    );
    if (inserted.rowCount === 1) {
      return "recorded";
    }
    const existing = await this.find(client, record.sourceJobRef);
    if (existing === null) {
      throw new Error("post-call dead-letter disappeared during idempotency reconciliation");
    }
    if (
      existing.attemptsMade === record.attemptsMade
      && existing.failureCode === record.failureCode
      && existing.meetingId === record.meetingId
      && existing.retryable === record.retryable
    ) {
      return "reused";
    }
    throw new PostCallDeadLetterConflictError(record.sourceJobRef);
  }

  private async find(
    client: PoolClient,
    sourceJobRef: string,
  ): Promise<PostCallDeadLetterEvidence | null> {
    const result = await client.query<StoredPostCallDeadLetterRow>(
      `
        SELECT source_job_ref, schema_version::float8 AS schema_version,
               meeting_id, attempts_made, failure_code, retryable, recorded_at
        FROM meeting_core.post_call_dead_letters
        WHERE source_job_ref = $1
      `,
      [sourceJobRef],
    );
    const row = result.rows[0];
    return row === undefined ? null : restoreRecord(row);
  }

  private async lockOutbox(
    client: PoolClient,
    meetingId: string,
  ): Promise<PostCallOutboxTerminalRow | undefined> {
    const result = await client.query<PostCallOutboxTerminalRow>(
      `
        SELECT processed_at, dead_letter_source_job_ref
        FROM meeting_core.post_call_outbox
        WHERE meeting_id = $1
        FOR UPDATE
      `,
      [meetingId],
    );
    return result.rows[0];
  }

  private async settleLockedOutbox(
    client: PoolClient,
    record: PostCallDeadLetterRecord,
  ): Promise<void> {
    const settled = await client.query(
      `
        UPDATE meeting_core.post_call_outbox
        SET dead_lettered_at = COALESCE(dead_lettered_at, transaction_timestamp()),
            dead_letter_source_job_ref = COALESCE(dead_letter_source_job_ref, $2)
        WHERE meeting_id = $1
          AND processed_at IS NULL
      `,
      [record.meetingId, record.sourceJobRef],
    );
    if (settled.rowCount !== 1) {
      throw new Error("post-call terminal settlement lost its locked outbox item");
    }
  }
}
