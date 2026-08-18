import type { PoolClient } from "pg";

const unmatchedProjectionTombstoneRetentionSeconds = 24 * 60 * 60;

export async function lockMeetingKnowledgeProjection(
  client: PoolClient,
  finalProjectionReceipt: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended('meeting-knowledge:projection:' || $1, 0)
     )`,
    [finalProjectionReceipt],
  );
}

/**
 * Bounds untrusted/partial delete observations while preserving any tombstone
 * that gained durable publication or question authority during the race window.
 */
export async function pruneUnmatchedProjectionTombstones(
  client: PoolClient,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended('meeting-knowledge:projection-tombstone-prune', 0)
     )`,
  );
  await client.query(
    `WITH candidates AS MATERIALIZED (
       SELECT unavailable.final_projection_receipt
       FROM meeting_knowledge.unavailable_final_projections AS unavailable
       WHERE unavailable.unavailable_at <
           transaction_timestamp() - make_interval(secs => $1)
         AND NOT EXISTS (
           SELECT 1 FROM meeting_core.meetings AS meeting
           WHERE meeting.snapshot -> 'publication' ->> 'externalPublicationId' =
             unavailable.final_projection_receipt
         )
         AND NOT EXISTS (
           SELECT 1 FROM meeting_core.live_meetings AS live
           WHERE live.snapshot ->> 'projectionExternalId' =
             unavailable.final_projection_receipt
         )
         AND NOT EXISTS (
           SELECT 1 FROM meeting_core.summary_publication_effects AS effect
           WHERE effect.external_receipt = unavailable.final_projection_receipt
         )
         AND NOT EXISTS (
           SELECT 1 FROM meeting_knowledge.question_jobs AS job
           WHERE job.final_projection_receipt = unavailable.final_projection_receipt
         )
       ORDER BY unavailable.final_projection_receipt
     )
     DELETE FROM meeting_knowledge.unavailable_final_projections AS unavailable
     USING candidates
     WHERE unavailable.final_projection_receipt = candidates.final_projection_receipt
       AND pg_try_advisory_xact_lock(hashtextextended(
         'meeting-knowledge:projection:' || candidates.final_projection_receipt, 0
       ))`,
    [unmatchedProjectionTombstoneRetentionSeconds],
  );
}
