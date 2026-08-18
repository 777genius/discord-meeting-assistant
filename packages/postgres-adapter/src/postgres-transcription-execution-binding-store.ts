import type { PostCallWorkItem } from "@discord-meeting/meeting-core/post-call-workflow";
import type { Pool, PoolClient } from "pg";

interface TranscriptionExecutionBindingRow {
  readonly transcription_execution_binding: string | null;
}

interface BindingRecoverablePostCallRow {
  readonly meeting_id: string;
  readonly recovery_generation: number;
  readonly schema_version: number;
}

const maximumTranscriptionExecutionBindingLength = 128;
const legacyBindingBackfillBatchSize = 100;

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

/** Durable opaque binding store; concrete provider values remain in composition. */
export class PostgresTranscriptionExecutionBindingStore {
  public constructor(private readonly pool: Pool) {}

  public async listRecoverablePostCall(
    limit: number,
    supportedBindings: ReadonlySet<string>,
  ): Promise<readonly PostCallWorkItem[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("post-call outbox limit must be between 1 and 1000");
    }
    const result = await this.pool.query<BindingRecoverablePostCallRow>(
      `
        SELECT meeting_id, schema_version::float8 AS schema_version,
               recovery_generation::float8 AS recovery_generation
        FROM meeting_core.post_call_outbox
        CROSS JOIN LATERAL (
          SELECT CASE
            WHEN transcription_execution_binding_required THEN binding_recovery_after
            ELSE recovery_after
          END AS effective_recovery_after
        ) AS recovery
        WHERE processed_at IS NULL
          AND dead_lettered_at IS NULL
          AND (
            (
              transcription_execution_binding_required = FALSE
              AND transcription_execution_binding IS NULL
            )
            OR transcription_execution_binding = ANY($2::text[])
          )
          AND (
            effective_recovery_after IS NULL
            OR effective_recovery_after <= transaction_timestamp()
          )
        ORDER BY COALESCE(effective_recovery_after, created_at), meeting_id
        LIMIT $1
      `,
      [limit, [...supportedBindings]],
    );
    return result.rows.map((row) => {
      if (row.schema_version !== 1) {
        throw new Error("unsupported post-call schema version");
      }
      if (!Number.isSafeInteger(row.recovery_generation) || row.recovery_generation < 0) {
        throw new Error("invalid post-call recovery generation");
      }
      return Object.freeze({
        meetingId: row.meeting_id,
        recoveryGeneration: row.recovery_generation,
        schemaVersion: 1 as const,
      });
    });
  }

  public async pinTranscriptionExecutionBinding(
    meetingId: string,
    binding: string,
  ): Promise<string> {
    const requiredBinding = requireTranscriptionExecutionBinding(binding);
    const client = await this.pool.connect();
    let transactionActive = false;
    let clientReusable = true;
    try {
      await client.query("BEGIN");
      transactionActive = true;
      await client.query("SET LOCAL lock_timeout = '250ms'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const result = await client.query<TranscriptionExecutionBindingRow>(
        `
          UPDATE meeting_core.post_call_outbox
          SET transcription_execution_binding = COALESCE(
            transcription_execution_binding,
            $2
          )
          WHERE meeting_id = $1
            AND processed_at IS NULL
            AND dead_lettered_at IS NULL
          RETURNING transcription_execution_binding
        `,
        [meetingId, requiredBinding],
      );
      const row = result.rows[0];
      if (row?.transcription_execution_binding === null || row === undefined) {
        throw new Error("transcription execution binding does not reference one outbox item");
      }
      await client.query("COMMIT");
      transactionActive = false;
      return row.transcription_execution_binding;
    } catch (error) {
      if (transactionActive) {
        clientReusable = await rollbackQuietly(client);
      }
      throw error;
    } finally {
      client.release(!clientReusable);
    }
  }

  public async getTranscriptionExecutionBinding(meetingId: string): Promise<string | undefined> {
    const result = await this.pool.query<TranscriptionExecutionBindingRow>(
      `
        SELECT transcription_execution_binding
        FROM meeting_core.post_call_outbox
        WHERE meeting_id = $1
      `,
      [meetingId],
    );
    const binding = result.rows[0]?.transcription_execution_binding;
    return binding === undefined || binding === null
      ? undefined
      : requireTranscriptionExecutionBinding(binding);
  }

  public async backfillRecoverableUnboundTranscriptionExecutionBindings(
    binding: string,
  ): Promise<number> {
    const client = await this.pool.connect();
    let transactionActive = false;
    let clientReusable = true;
    try {
      await client.query("BEGIN");
      transactionActive = true;
      await client.query("SET LOCAL lock_timeout = '250ms'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const result = await client.query(
        `
          WITH batch AS (
            SELECT meeting_id
            FROM meeting_core.post_call_outbox
            WHERE transcription_execution_binding IS NULL
              AND transcription_execution_binding_required = FALSE
              AND processed_at IS NULL
              AND dead_lettered_at IS NULL
            ORDER BY COALESCE(recovery_after, created_at), meeting_id
            LIMIT $2
            FOR UPDATE SKIP LOCKED
          )
          UPDATE meeting_core.post_call_outbox AS outbox
          SET transcription_execution_binding = $1
          FROM batch
          WHERE outbox.meeting_id = batch.meeting_id
        `,
        [
          requireTranscriptionExecutionBinding(binding),
          legacyBindingBackfillBatchSize,
        ],
      );
      await client.query("COMMIT");
      transactionActive = false;
      // Startup performs one bounded maintenance batch. Remaining legacy rows
      // stay recoverable and are pinned individually by dispatch, so a large or
      // concurrently locked backlog cannot hold readiness indefinitely.
      return result.rowCount ?? 0;
    } catch (error) {
      if (transactionActive) {
        clientReusable = await rollbackQuietly(client);
      }
      throw error;
    } finally {
      client.release(!clientReusable);
    }
  }
}

async function rollbackQuietly(client: PoolClient): Promise<boolean> {
  try {
    await client.query("ROLLBACK");
    return true;
  } catch {
    // Preserve the original bounded transaction failure.
    return false;
  }
}
