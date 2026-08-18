import type {
  FinalReplyMaintenancePort,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { Pool } from "pg";

function requireMaximumJobs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new RangeError("final reply maintenance limit must be between 1 and 1000");
  }
  return value;
}

export class PostgresFinalReplyMaintenance
  implements FinalReplyMaintenancePort
{
  public constructor(private readonly pool: Pool) {}

  public async maintain(
    input: Parameters<FinalReplyMaintenancePort["maintain"]>[0],
  ): ReturnType<FinalReplyMaintenancePort["maintain"]> {
    const maximumJobs = requireMaximumJobs(input.maximumJobs);
    const cancelled = input.servingEnabled
      ? 0
      : await this.cancelUnservedJobs(maximumJobs);
    const expired = await this.expireJobs(maximumJobs);
    return { cancelled, expired };
  }

  private async cancelUnservedJobs(maximumJobs: number): Promise<number> {
    const result = await this.pool.query<{ readonly cancelled: string }>(
      `
        WITH locked_question AS (
          SELECT question_id
          FROM meeting_knowledge.question_jobs
          WHERE state <> 'terminal'
          ORDER BY created_at, question_id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        ), terminalized AS (
          UPDATE meeting_knowledge.question_jobs AS job
          SET state = 'terminal',
              outcome = CASE WHEN EXISTS (
                SELECT 1
                FROM meeting_core.answer_effects AS effect
                WHERE effect.effect_id =
                    'meeting-knowledge-answer:v1:' || job.question_id
                  AND effect.state IN (
                    'request_started', 'delivered', 'outcome_unknown',
                    'absent_unconfirmed'
                  )
              ) THEN 'delivery_unknown' ELSE 'cancelled' END,
              authorization_principal_ref = NULL,
              question_text = NULL,
              binding = NULL,
              grounding_plan = NULL,
              answer_candidate = NULL,
              lease_owner = NULL,
              lease_until = NULL,
              terminal_at = transaction_timestamp(),
              scrubbed_at = transaction_timestamp(),
              updated_at = transaction_timestamp()
          FROM locked_question
          WHERE job.question_id = locked_question.question_id
            AND job.state <> 'terminal'
          RETURNING job.question_id
        ), effects AS (
          UPDATE meeting_core.answer_effects AS effect
          SET state = CASE
                WHEN effect.state IN ('reserved', 'claimed') THEN 'cancelled'
                ELSE 'retraction_pending'
              END,
              payload_bytes = CASE
                WHEN effect.state IN ('reserved', 'claimed') THEN '{}'
                ELSE effect.payload_bytes
              END,
              claim_until = NULL,
              retraction_requested_at = CASE
                WHEN effect.state IN (
                  'request_started', 'delivered', 'outcome_unknown',
                  'absent_unconfirmed', 'retraction_pending'
                ) THEN COALESCE(
                  effect.retraction_requested_at,
                  transaction_timestamp()
                )
                ELSE effect.retraction_requested_at
              END,
              settled_at = CASE
                WHEN effect.state IN ('reserved', 'claimed')
                  THEN COALESCE(effect.settled_at, transaction_timestamp())
                ELSE effect.settled_at
              END,
              updated_at = transaction_timestamp()
          FROM locked_question
          WHERE effect.effect_id =
              'meeting-knowledge-answer:v1:' || locked_question.question_id
            AND effect.state IN (
              'reserved', 'claimed', 'request_started', 'delivered',
              'outcome_unknown', 'absent_unconfirmed', 'retraction_pending'
            )
          RETURNING effect.effect_id
        )
        SELECT count(*)::text AS cancelled FROM terminalized
      `,
      [maximumJobs],
    );
    return Number(result.rows[0]?.cancelled ?? "0");
  }

  private async expireJobs(maximumJobs: number): Promise<number> {
    const result = await this.pool.query<{ readonly expired: string }>(
      `
        WITH expired AS (
          SELECT question_id
          FROM meeting_knowledge.question_jobs
          WHERE state <> 'terminal'
            AND expires_at <= transaction_timestamp()
          ORDER BY expires_at, question_id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        ), terminalized AS (
          UPDATE meeting_knowledge.question_jobs AS job
          SET state = 'terminal',
              outcome = CASE WHEN EXISTS (
                SELECT 1
                FROM meeting_core.answer_effects AS effect
                WHERE effect.effect_id =
                    'meeting-knowledge-answer:v1:' || job.question_id
                  AND effect.state IN (
                    'request_started', 'delivered', 'outcome_unknown',
                    'absent_unconfirmed'
                  )
              ) THEN 'delivery_unknown' ELSE 'expired' END,
              authorization_principal_ref = NULL,
              question_text = NULL,
              binding = NULL,
              grounding_plan = NULL,
              answer_candidate = NULL,
              lease_owner = NULL,
              lease_until = NULL,
              terminal_at = transaction_timestamp(),
              scrubbed_at = transaction_timestamp(),
              updated_at = transaction_timestamp()
          FROM expired
          WHERE job.question_id = expired.question_id
            AND job.state <> 'terminal'
          RETURNING job.question_id
        )
        SELECT count(*)::text AS expired FROM terminalized
      `,
      [maximumJobs],
    );
    return Number(result.rows[0]?.expired ?? "0");
  }
}
