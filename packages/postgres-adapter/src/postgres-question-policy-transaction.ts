import type { Pool, PoolClient } from "pg";

import {
  PostgresQuestionPolicyFence,
  type QuestionPolicyIdentity,
} from "./postgres-question-policy-fence.js";

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original persistence failure.
  }
}

/** Runs one question mutation while holding the current cluster policy lock. */
export class PostgresQuestionPolicyTransaction {
  public readonly identity: QuestionPolicyIdentity;
  private readonly fence: PostgresQuestionPolicyFence;

  public constructor(
    private readonly pool: Pool,
    identity: QuestionPolicyIdentity,
  ) {
    this.fence = new PostgresQuestionPolicyFence(identity);
    this.identity = this.fence.identity;
  }

  public async execute<Result>(
    staleResult: Result,
    operation: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    return this.executeWithBegin("BEGIN", staleResult, operation);
  }

  /** Stable MVCC snapshot for evidence fences spanning several bounded reads. */
  public async executeConsistent<Result>(
    staleResult: Result,
    operation: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    return this.executeWithBegin(
      "BEGIN ISOLATION LEVEL REPEATABLE READ",
      staleResult,
      operation,
    );
  }

  private async executeWithBegin<Result>(
    begin: string,
    staleResult: Result,
    operation: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.pool.connect();
    try {
      await client.query(begin);
      if (!await this.fence.lockCurrent(client)) {
        await client.query("COMMIT");
        return staleResult;
      }
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

export function questionPolicyParameters(
  policy: QuestionPolicyIdentity,
): readonly [number, string, string] {
  return [policy.policyEpoch, policy.policyVersion, policy.authorizationPolicyVersion];
}

export function currentQuestionPolicySql(firstParameter: number): string {
  return `EXISTS (
    SELECT 1
    FROM meeting_knowledge.current_question_policy AS policy
    WHERE policy.policy_key = 'local-final-reply'
      AND policy.policy_epoch = $${firstParameter}
      AND policy.policy_version = $${firstParameter + 1}
      AND policy.authorization_policy_version = $${firstParameter + 2}
      AND job.policy_epoch = policy.policy_epoch
      AND job.binding ->> 'policyVersion' = policy.policy_version
      AND job.binding ->> 'authorizationPolicyVersion' = policy.authorization_policy_version
  )`;
}
