import type { PoolClient } from "pg";

/** Atomically withdraws derived memory and every answer that cites the source. */
export async function requestAnswerSourceWithdrawal(
  client: PoolClient,
  meetingId: string,
): Promise<void> {
  await client.query(
    `UPDATE meeting_core.historical_memory_sync
     SET is_current = false, operation = 'delete_meeting',
         state = CASE
           WHEN state = 'deleted' THEN 'deleted'
           WHEN state = 'in_flight' THEN 'in_flight'
           ELSE 'deleting'
         END,
         retry_after = NULL,
         lease_expires_at = CASE
           WHEN state = 'in_flight' THEN lease_expires_at ELSE NULL
         END,
         updated_at = transaction_timestamp()
     WHERE meeting_id = $1`,
    [meetingId],
  );
  await client.query(
    `UPDATE meeting_knowledge.question_jobs
     SET state = 'terminal', outcome = 'cancelled',
         authorization_principal_ref = NULL, question_text = NULL,
         binding = NULL, grounding_plan = NULL, answer_candidate = NULL,
         lease_owner = NULL, lease_until = NULL,
         terminal_at = COALESCE(terminal_at, transaction_timestamp()),
         scrubbed_at = COALESCE(scrubbed_at, transaction_timestamp()),
         updated_at = transaction_timestamp()
     WHERE state <> 'terminal'
       AND source_meeting_ids @> ARRAY[$1]::text[]`,
    [meetingId],
  );
  await client.query(
    `UPDATE meeting_core.answer_effects
     SET state = CASE
           WHEN state IN ('reserved', 'claimed') THEN 'cancelled'
           ELSE 'retraction_pending'
         END,
         payload_bytes = CASE
           WHEN state IN ('reserved', 'claimed') THEN '{}' ELSE payload_bytes
         END,
         claim_until = NULL,
         retraction_requested_at = CASE
           WHEN state IN (
             'request_started', 'delivered', 'outcome_unknown',
             'absent_unconfirmed', 'retraction_pending'
           ) THEN COALESCE(retraction_requested_at, transaction_timestamp())
           ELSE retraction_requested_at
         END,
         settled_at = CASE
           WHEN state IN ('reserved', 'claimed')
             THEN COALESCE(settled_at, transaction_timestamp())
           ELSE settled_at
         END,
         updated_at = transaction_timestamp()
     WHERE source_meeting_ids @> ARRAY[$1]::text[]
       AND state IN (
         'reserved', 'claimed', 'request_started', 'delivered',
         'outcome_unknown', 'absent_unconfirmed', 'retraction_pending'
       )`,
    [meetingId],
  );
}
