import type { PoolClient } from "pg";

/** Serializes source acceptance and withdrawal even before either has a row. */
export async function lockMeetingKnowledgeSource(
  client: PoolClient,
  meetingId: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended('meeting-knowledge:source:' || $1, 0)
     )`,
    [meetingId],
  );
}

/** Locks a source set in one canonical order before a multi-source mutation. */
export async function lockMeetingKnowledgeSources(
  client: PoolClient,
  meetingIds: readonly string[],
): Promise<void> {
  for (const meetingId of [...new Set(meetingIds)].toSorted()) {
    await lockMeetingKnowledgeSource(client, meetingId);
  }
}

/** Atomically withdraws derived memory and every answer that cites the source. */
export async function requestAnswerSourceWithdrawal(
  client: PoolClient,
  meetingId: string,
): Promise<void> {
  await lockMeetingKnowledgeSource(client, meetingId);
  await client.query(
    `INSERT INTO meeting_knowledge.withdrawn_meeting_sources (meeting_id)
     VALUES ($1)
     ON CONFLICT (meeting_id) DO NOTHING`,
    [meetingId],
  );
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
  const affectedQuestions = await client.query<{ readonly question_id: string }>(
    `SELECT question_id
     FROM meeting_knowledge.question_jobs
     WHERE binding ->> 'meetingId' = $1
        OR source_meeting_ids @> ARRAY[$1]::text[]
     ORDER BY question_id
     FOR UPDATE`,
    [meetingId],
  );
  const questionIds = affectedQuestions.rows.map(({ question_id: questionId }) =>
    questionId
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
     WHERE question_id = ANY($1::text[])
       AND state <> 'terminal'`,
    [questionIds],
  );
  const affectedEffects = await client.query<{ readonly effect_id: string }>(
    `SELECT effect_id
     FROM meeting_core.answer_effects
     WHERE source_meeting_ids @> ARRAY[$1]::text[]
        OR effect_id = ANY($2::text[])
     ORDER BY effect_id
     FOR UPDATE`,
    [
      meetingId,
      questionIds.map((questionId) =>
        `meeting-knowledge-answer:v1:${questionId}`
      ),
    ],
  );
  const effectIds = affectedEffects.rows.map(({ effect_id: effectId }) => effectId);
  await client.query(
    `UPDATE meeting_core.answer_effects
     SET state = CASE
           WHEN state IN ('reserved', 'claimed') THEN 'cancelled'
           ELSE 'retraction_pending'
         END,
         payload_bytes = '{}',
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
     WHERE effect_id = ANY($1::text[])
       AND state IN (
         'reserved', 'claimed', 'request_started', 'delivered',
         'outcome_unknown', 'absent_unconfirmed', 'retraction_pending'
       )`,
    [effectIds],
  );
}
