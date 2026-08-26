import type { Pool, PoolClient } from "pg";

import type { PostgresQuestionPolicyFence } from "./postgres-question-policy-fence.js";

interface AnswerRequestStartInput {
  readonly authorizationDigest: string;
  readonly effectId: string;
  readonly questionGeneration: number;
  readonly workerId: string;
}

export async function startPolicyFencedAnswerRequest(
  pool: Pool,
  policyFence: PostgresQuestionPolicyFence,
  input: AnswerRequestStartInput,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!await policyFence.lockCurrent(client)) {
      await client.query("COMMIT");
      return false;
    }
    const result = await client.query(
      `
        UPDATE meeting_core.answer_effects AS effect
        SET state = 'request_started',
            claim_generation = claim_generation + 1,
            claim_owner = $2,
            request_started_at = transaction_timestamp(),
            claim_until = NULL,
            updated_at = transaction_timestamp()
        WHERE effect_id = $1
          AND authorization_digest = $3
          AND (
            state = 'reserved' OR
            state = 'claimed' AND claim_until <= transaction_timestamp()
          )
          AND EXISTS (
            SELECT 1
            FROM meeting_knowledge.question_jobs AS job
            WHERE job.question_id = effect.reply_to_remote_message_id
              AND job.state IN ('running', 'ready')
              AND job.lease_until > transaction_timestamp()
              AND job.expires_at > transaction_timestamp()
              AND job.policy_epoch = $4
              AND job.binding ->> 'policyVersion' = $5
              AND job.binding ->> 'authorizationPolicyVersion' = $6
              AND job.generation = $7
          )
      `,
      [
        input.effectId,
        input.workerId,
        input.authorizationDigest,
        policyFence.identity.policyEpoch,
        policyFence.identity.policyVersion,
        policyFence.identity.authorizationPolicyVersion,
        input.questionGeneration,
      ],
    );
    await client.query("COMMIT");
    return result.rowCount === 1;
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the effect transition error.
  }
}
