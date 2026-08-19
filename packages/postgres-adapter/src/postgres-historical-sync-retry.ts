import type {
  HistoricalOperationOptionsV1,
  HistoricalSyncLeaseV1,
  HistoricalSyncRetryV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { Pool } from "pg";

import {
  queryHistoricalPostgres,
  type HistoricalPostgresCancellationPort,
} from "./postgres-historical-query.js";

export function recordHistoricalSyncRetry(
  pool: Pool,
  cancellation: HistoricalPostgresCancellationPort | undefined,
  lease: HistoricalSyncLeaseV1,
  failure: HistoricalSyncRetryV1,
  options: HistoricalOperationOptionsV1,
): Promise<{ readonly rowCount: number | null }> {
  const outcomeUnknown = failure.outcome === "outcome_unknown";
  return queryHistoricalPostgres(pool, {
    text: `
      UPDATE meeting_core.historical_memory_sync
      SET state = CASE WHEN $5::boolean THEN 'in_flight' ELSE 'retry_wait' END,
          retry_after = CASE
            WHEN $5::boolean THEN GREATEST(
              lease_expires_at,
              transaction_timestamp() + ($3::double precision * interval '1 millisecond')
            )
            ELSE transaction_timestamp() + ($3::double precision * interval '1 millisecond')
          END,
          lease_expires_at = CASE WHEN $5::boolean THEN lease_expires_at ELSE NULL END,
          last_error_code = $4,
          updated_at = transaction_timestamp()
      WHERE release_id = $1 AND lease_fence = $2 AND state = 'in_flight'
    `,
    values: [
      lease.binding.releaseId,
      lease.fence,
      failure.retryAfterMs,
      failure.code,
      outcomeUnknown,
    ],
  }, options.signal, cancellation);
}
