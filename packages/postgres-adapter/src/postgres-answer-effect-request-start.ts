import type { Pool, PoolClient } from "pg";

import type { PostgresQuestionPolicyFence } from "./postgres-question-policy-fence.js";

interface AnswerRequestStartInput {
  readonly authorizationDigest: string;
  readonly effectId: string;
  readonly generation: number;
  readonly questionGeneration: number;
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
      await cancelClaimBeforeRequest(client, input);
      await client.query("COMMIT");
      return false;
    }
    const result = await client.query(
      `
        UPDATE meeting_core.answer_effects AS effect
        SET state = 'request_started',
            request_started_at = transaction_timestamp(),
            claim_until = NULL,
            updated_at = transaction_timestamp()
        WHERE effect_id = $1
          AND state = 'claimed'
          AND claim_generation = $2
          AND authorization_digest = $3
          AND claim_until > transaction_timestamp()
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
        input.generation,
        input.authorizationDigest,
        policyFence.identity.policyEpoch,
        policyFence.identity.policyVersion,
        policyFence.identity.authorizationPolicyVersion,
        input.questionGeneration,
      ],
    );
    if (result.rowCount !== 1) {
      await cancelClaimBeforeRequest(client, input);
    }
    await client.query("COMMIT");
    return result.rowCount === 1;
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

async function cancelClaimBeforeRequest(
  client: PoolClient,
  input: AnswerRequestStartInput,
): Promise<void> {
  await client.query(
    `
      UPDATE meeting_core.answer_effects
      SET state = 'cancelled',
          payload_bytes = '{}',
          settled_at = COALESCE(settled_at, transaction_timestamp()),
          claim_until = NULL,
          updated_at = transaction_timestamp()
      WHERE effect_id = $1
        AND state = 'claimed'
        AND claim_generation = $2
    `,
    [input.effectId, input.generation],
  );
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the effect transition error.
  }
}
