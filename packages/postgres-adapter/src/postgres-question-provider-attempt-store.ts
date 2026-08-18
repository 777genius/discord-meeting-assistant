import type {
  QuestionJobStore,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { Pool, PoolClient } from "pg";

import type { QuestionPolicyIdentity } from "./postgres-question-policy-fence.js";
import {
  currentQuestionPolicySql,
  PostgresQuestionPolicyTransaction,
  questionPolicyParameters,
} from "./postgres-question-policy-transaction.js";

function requireLeaseSeconds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 5 || value > 600) {
    throw new RangeError("question job lease must be between 5 and 600 seconds");
  }
  return value;
}

function requireMaximumProviderAttempts(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) {
    throw new RangeError("maximum provider attempts must be between 1 and 32");
  }
  return value;
}

export class PostgresQuestionProviderAttemptStore {
  private readonly policyTransaction: PostgresQuestionPolicyTransaction;

  public constructor(
    pool: Pool,
    policy: QuestionPolicyIdentity,
  ) {
    this.policyTransaction = new PostgresQuestionPolicyTransaction(pool, policy);
  }

  public async reserve(
    input: Parameters<QuestionJobStore["reserveProviderAttempt"]>[0],
  ): Promise<boolean> {
    const leaseSeconds = requireLeaseSeconds(input.leaseSeconds);
    const maximumProviderAttempts = requireMaximumProviderAttempts(
      input.maximumProviderAttempts,
    );
    return this.policyTransaction.execute(false, async (client) => {
      const result = await client.query(
      `
        UPDATE meeting_knowledge.question_jobs AS job
        SET attempts = attempts + 1,
            provider_attempt_state = 'reserved',
            provider_attempt_id = $3,
            provider_attempt_started_at = transaction_timestamp(),
            provider_attempt_finished_at = NULL,
            provider_attempt_retryable = NULL,
            lease_until = transaction_timestamp() + make_interval(secs => $4),
            updated_at = transaction_timestamp()
        WHERE question_id = $1
          AND generation = $2
          AND state = 'running'
          AND worker_protocol_epoch = 2
          AND worker_protocol_generation = generation
          AND lease_until > transaction_timestamp()
          AND provider_attempt_state IN ('none', 'failed')
          AND expires_at >
            transaction_timestamp() + make_interval(secs => $4)
          AND attempts < $5
          AND ${currentQuestionPolicySql(6)}
      `,
      [
        input.jobId,
        input.generation,
        input.attemptId,
        leaseSeconds,
        maximumProviderAttempts,
        ...questionPolicyParameters(this.policyTransaction.identity),
      ],
    );
      return result.rowCount === 1;
    });
  }

  public async complete(
    input: Parameters<QuestionJobStore["completeProviderAttempt"]>[0],
  ): Promise<boolean> {
    return this.policyTransaction.execute(false, async (client) => {
      const result = await client.query(
      `
        UPDATE meeting_knowledge.question_jobs AS job
        SET state = 'ready',
            answer_candidate = $4::jsonb,
            ready_at = COALESCE(ready_at, transaction_timestamp()),
            provider_attempt_state = 'completed',
            provider_attempt_finished_at = transaction_timestamp(),
            provider_attempt_retryable = NULL,
            updated_at = transaction_timestamp()
        WHERE question_id = $1
          AND generation = $2
          AND state = 'running'
          AND worker_protocol_epoch = 2
          AND worker_protocol_generation = generation
          AND provider_attempt_id = $3
          AND provider_attempt_state = 'reserved'
          AND lease_until > transaction_timestamp()
          AND expires_at > transaction_timestamp()
          AND grounding_plan IS NOT NULL
          AND ${currentQuestionPolicySql(5)}
      `,
        [
        input.jobId,
        input.generation,
        input.attemptId,
        JSON.stringify(input.answerCandidate),
        ...questionPolicyParameters(this.policyTransaction.identity),
      ],
    );
      return result.rowCount === 1;
    });
  }

  public async fail(
    input: Parameters<QuestionJobStore["failProviderAttempt"]>[0],
  ): Promise<"deferred" | "settled" | "stale"> {
    const maximumProviderAttempts = requireMaximumProviderAttempts(
      input.maximumProviderAttempts,
    );
    return this.policyTransaction.execute<"deferred" | "settled" | "stale">(
      "stale",
      async (client) => {
        const result = await client.query<{ readonly state: "queued" | "terminal" }>(
      `
        UPDATE meeting_knowledge.question_jobs AS job
        SET provider_attempt_state = 'failed',
            provider_attempt_finished_at = transaction_timestamp(),
            provider_attempt_retryable = $4,
            state = CASE
              WHEN $4 AND attempts < $5 AND expires_at > transaction_timestamp()
                THEN 'queued'
              ELSE 'terminal'
            END,
            outcome = CASE
              WHEN $4 AND attempts < $5 AND expires_at > transaction_timestamp()
                THEN NULL
              ELSE 'unavailable'
            END,
            authorization_principal_ref = CASE
              WHEN $4 AND attempts < $5 AND expires_at > transaction_timestamp()
                THEN authorization_principal_ref
              ELSE NULL
            END,
            question_text = CASE
              WHEN $4 AND attempts < $5 AND expires_at > transaction_timestamp()
                THEN question_text
              ELSE NULL
            END,
            binding = CASE
              WHEN $4 AND attempts < $5 AND expires_at > transaction_timestamp()
                THEN binding
              ELSE NULL
            END,
            grounding_plan = CASE
              WHEN $4 AND attempts < $5 AND expires_at > transaction_timestamp()
                THEN grounding_plan
              ELSE NULL
            END,
            answer_candidate = NULL,
            lease_owner = NULL,
            lease_until = NULL,
            retry_reason = $6,
            terminal_at = CASE
              WHEN $4 AND attempts < $5 AND expires_at > transaction_timestamp()
                THEN NULL
              ELSE transaction_timestamp()
            END,
            scrubbed_at = CASE
              WHEN $4 AND attempts < $5 AND expires_at > transaction_timestamp()
                THEN NULL
              ELSE transaction_timestamp()
            END,
            updated_at = transaction_timestamp()
        WHERE question_id = $1
          AND generation = $2
          AND state = 'running'
          AND worker_protocol_epoch = 2
          AND worker_protocol_generation = generation
          AND provider_attempt_id = $3
          AND provider_attempt_state = 'reserved'
          AND lease_until > transaction_timestamp()
          AND ${currentQuestionPolicySql(7)}
        RETURNING state
      `,
          [
            input.jobId,
            input.generation,
            input.attemptId,
            input.retryable,
            maximumProviderAttempts,
            input.reason.slice(0, 256),
            ...questionPolicyParameters(this.policyTransaction.identity),
          ],
        );
        const state = result.rows[0]?.state;
        return state === "queued" ? "deferred" : state === "terminal" ? "settled" : "stale";
      },
    );
  }

  public async failAbandoned(
    executor: Pick<PoolClient, "query">,
  ): Promise<void> {
    await executor.query(
      `
        UPDATE meeting_knowledge.question_jobs AS job
        SET state = 'terminal',
            outcome = 'unavailable',
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
        WHERE state = 'running'
          AND provider_attempt_state IN ('reserved', 'completed')
          AND lease_until <= transaction_timestamp()
          AND ${currentQuestionPolicySql(1)}
      `,
      [...questionPolicyParameters(this.policyTransaction.identity)],
    );
  }
}
