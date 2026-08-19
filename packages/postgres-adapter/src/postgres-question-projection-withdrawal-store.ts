import type { Pool, PoolClient } from "pg";

import {
  lockMeetingKnowledgeProjection,
  pruneUnmatchedProjectionTombstones,
} from "./postgres-projection-withdrawal.js";

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the projection-withdrawal failure.
  }
}

export class PostgresQuestionProjectionWithdrawalStore {
  public constructor(private readonly pool: Pool) {}

  public async withdraw(input: {
    readonly finalProjectionReceipt: string;
  }): Promise<readonly string[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await pruneUnmatchedProjectionTombstones(client);
      await lockMeetingKnowledgeProjection(client, input.finalProjectionReceipt);
      await client.query(
        `
          INSERT INTO meeting_knowledge.unavailable_final_projections
            (final_projection_receipt)
          VALUES ($1)
          ON CONFLICT (final_projection_receipt) DO NOTHING
        `,
        [input.finalProjectionReceipt],
      );
      const affected = await client.query<{ readonly question_id: string }>(
        `
          SELECT job.question_id
          FROM meeting_knowledge.question_jobs AS job
          WHERE job.final_projection_receipt = $1
          ORDER BY job.question_id
          FOR UPDATE OF job
        `,
        [input.finalProjectionReceipt],
      );
      const questionIds = affected.rows.map(({ question_id: questionId }) => questionId);
      const expectedEffectIds = questionIds.map((questionId) =>
        `meeting-knowledge-answer:v1:${questionId}`
      );
      const affectedEffects = await client.query<{ readonly effect_id: string }>(
        `
          SELECT effect_id
          FROM meeting_core.answer_effects
          WHERE effect_id = ANY($1::text[])
          ORDER BY effect_id
          FOR UPDATE
        `,
        [expectedEffectIds],
      );
      const effectIds = affectedEffects.rows.map(({ effect_id: effectId }) => effectId);
      if (questionIds.length > 0) {
        await client.query(
          `
            UPDATE meeting_knowledge.question_jobs
            SET state = 'terminal', outcome = 'cancelled',
                authorization_principal_ref = NULL, question_text = NULL,
                binding = NULL, grounding_plan = NULL, answer_candidate = NULL,
                lease_owner = NULL, lease_until = NULL,
                terminal_at = COALESCE(terminal_at, transaction_timestamp()),
                scrubbed_at = COALESCE(scrubbed_at, transaction_timestamp()),
                updated_at = transaction_timestamp()
            WHERE question_id = ANY($1::text[]) AND state <> 'terminal'
          `,
          [questionIds],
        );
        await client.query(
          `
            UPDATE meeting_core.answer_effects
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
            WHERE effect_id = ANY($1::text[]) AND state IN (
                'reserved', 'claimed', 'request_started', 'delivered',
                'outcome_unknown', 'absent_unconfirmed', 'retraction_pending'
              )
          `,
          [effectIds],
        );
      }
      await client.query("COMMIT");
      return Object.freeze(questionIds);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
