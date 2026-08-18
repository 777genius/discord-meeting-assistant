import type {
  QuestionJobStore,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { Pool, PoolClient } from "pg";

import type { QuestionPolicyIdentity } from "./postgres-question-policy-fence.js";

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
  public constructor(
    private readonly pool: Pool,
    _policy: QuestionPolicyIdentity,
  ) {}

  public async reserve(
    input: Parameters<QuestionJobStore["reserveProviderAttempt"]>[0],
  ): Promise<boolean> {
    const leaseSeconds = requireLeaseSeconds(input.leaseSeconds);
    const maximumProviderAttempts = requireMaximumProviderAttempts(
      input.maximumProviderAttempts,
    );
    const result = await this.pool.query(
      `
        UPDATE meeting_knowledge.question_jobs
        SET attempts = attempts + 1,
            provider_attempt_state = 'reserved',
            provider_attempt_id = $3,
            provider_attempt_started_at = transaction_timestamp(),
            provider_attempt_finished_at = NULL,
            lease_until = transaction_timestamp() + make_interval(secs => $4),
            updated_at = transaction_timestamp()
        WHERE question_id = $1
          AND generation = $2
          AND state = 'running'
          AND lease_until > transaction_timestamp()
          AND provider_attempt_state IN ('none', 'failed')
          AND attempts < $5
      `,
      [
        input.jobId,
        input.generation,
        input.attemptId,
        leaseSeconds,
        maximumProviderAttempts,
      ],
    );
    return result.rowCount === 1;
  }

  public async recordOutcome(
    input: Parameters<QuestionJobStore["recordProviderAttemptOutcome"]>[0],
  ): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE meeting_knowledge.question_jobs
        SET provider_attempt_state = $4,
            provider_attempt_finished_at = transaction_timestamp(),
            updated_at = transaction_timestamp()
        WHERE question_id = $1
          AND generation = $2
          AND state = 'running'
          AND provider_attempt_id = $3
          AND provider_attempt_state = 'reserved'
          AND lease_until > transaction_timestamp()
      `,
      [input.jobId, input.generation, input.attemptId, input.outcome],
    );
    return result.rowCount === 1;
  }

  public async failAbandoned(
    executor: Pick<PoolClient, "query"> = this.pool,
  ): Promise<void> {
    await executor.query(
      `
        UPDATE meeting_knowledge.question_jobs
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
          AND provider_attempt_state = 'reserved'
          AND lease_until <= transaction_timestamp()
      `,
    );
  }
}
