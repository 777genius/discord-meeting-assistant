import type { HistoricalOperationOptionsV1 } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import type { Pool } from "pg";

import {
  withHistoricalPostgresTransaction,
  type HistoricalPostgresCancellationPort,
} from "./postgres-historical-query.js";

export function requireHistoricalIndexProfileId(indexProfileId: string): void {
  if (
    indexProfileId.trim().length === 0 ||
    new TextEncoder().encode(indexProfileId).byteLength > 1_000
  ) {
    throw new RangeError("historical index profile identity is outside its bounds");
  }
}

export function requireHistoricalMaximumRows(maximumRows: number): void {
  if (!Number.isSafeInteger(maximumRows) || maximumRows < 1 || maximumRows > 4_096) {
    throw new RangeError("historical room read bound is outside its qualified range");
  }
}

export async function enqueueHistoricalProfileRebuilds(
  pool: Pool,
  cancellation: HistoricalPostgresCancellationPort | undefined,
  indexProfileId: string,
  maximumRows: number,
  options: HistoricalOperationOptionsV1,
): Promise<{ readonly enqueued: number; readonly remaining: boolean }> {
  requireHistoricalIndexProfileId(indexProfileId);
  requireHistoricalMaximumRows(maximumRows);
  return withHistoricalPostgresTransaction(pool, options.signal, async (client) => {
    const result = await client.query<{
      readonly enqueued: number;
      readonly remaining: boolean;
    }>(`
      WITH selected AS (
        SELECT release_id FROM meeting_core.historical_memory_sync
        WHERE is_current AND operation = 'index' AND state = 'applied'
          AND applied_index_profile_id IS DISTINCT FROM $1
        ORDER BY meeting_id, desired_generation, release_id
        LIMIT $2 FOR UPDATE SKIP LOCKED
      ), rebuilt AS (
        UPDATE meeting_core.historical_memory_sync AS historical
        SET state = 'pending', profile_rebuild_requested = true,
            attempt_count = 0,
            retry_after = NULL, lease_expires_at = NULL,
            last_error_code = NULL, updated_at = transaction_timestamp()
        FROM selected WHERE historical.release_id = selected.release_id
        RETURNING 1
      )
      SELECT count(*)::float8 AS enqueued, EXISTS (
        SELECT 1 FROM meeting_core.historical_memory_sync
        WHERE is_current AND operation = 'index' AND state = 'applied'
          AND applied_index_profile_id IS DISTINCT FROM $1
      ) AS remaining FROM rebuilt
    `, [indexProfileId, maximumRows]);
    const row = result.rows[0];
    if (row === undefined || !Number.isSafeInteger(row.enqueued)) {
      throw new Error("historical profile rebuild query returned an invalid result");
    }
    return Object.freeze({ enqueued: row.enqueued, remaining: row.remaining });
  }, cancellation);
}
