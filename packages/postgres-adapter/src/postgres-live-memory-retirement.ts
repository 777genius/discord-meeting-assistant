import type { PoolClient } from "pg";

/** Atomically revokes serving and schedules exact remote live-document retirement. */
export async function retireLiveFinalizedMemoryGeneration(
  client: PoolClient,
  meetingId: string,
  state: "ended" | "withdrawn",
): Promise<void> {
  await client.query(
    `UPDATE meeting_knowledge.live_memory_meetings
     SET state = CASE WHEN state = 'withdrawn' THEN state ELSE $2 END,
         updated_at = transaction_timestamp()
     WHERE meeting_id = $1`,
    [meetingId, state],
  );
  await client.query(
    `UPDATE meeting_knowledge.live_memory_outbox
     SET state = CASE
           WHEN state = 'applied' THEN 'retire_pending'
           WHEN state IN ('in_flight', 'outcome_unknown') THEN 'retire_outcome_unknown'
           WHEN state IN ('pending', 'retry_wait', 'dead_letter') THEN 'retired'
           ELSE state
         END,
         lease_expires_at = CASE
           WHEN state = 'retire_in_flight' THEN lease_expires_at ELSE NULL
         END,
         retry_after = CASE
           WHEN state IN ('retire_pending', 'retire_outcome_unknown') THEN retry_after
           ELSE NULL
         END,
         updated_at = transaction_timestamp()
     WHERE meeting_id = $1 AND state IN (
       'pending', 'in_flight', 'retry_wait', 'outcome_unknown', 'applied', 'dead_letter'
     )`,
    [meetingId],
  );
  await client.query(
    `DELETE FROM meeting_knowledge.live_memory_hot_tail WHERE meeting_id = $1`,
    [meetingId],
  );
}
