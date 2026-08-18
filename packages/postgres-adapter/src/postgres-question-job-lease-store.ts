import type {
  QuestionJobLease,
  QuestionJobState,
  QuestionJobStore,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { Pool } from "pg";

import {
  decodeGroundedAnswerCandidate,
  decodeGroundingPlan,
  decodeQuestionBinding,
} from "./postgres-meeting-knowledge-codecs.js";
import {
  PostgresQuestionPolicyTransaction,
  questionPolicyParameters,
} from "./postgres-question-policy-transaction.js";
import type { QuestionPolicyIdentity } from "./postgres-question-policy-fence.js";
import type { PostgresQuestionProviderAttemptStore } from "./postgres-question-provider-attempt-store.js";

interface QuestionJobRow {
  readonly answer_candidate: unknown;
  readonly attempts: number;
  readonly binding: unknown;
  readonly generation: number;
  readonly grounding_plan: unknown;
  readonly question_id: string;
  readonly question_text: string;
  readonly state: QuestionJobState;
}

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

function toLease(row: QuestionJobRow): QuestionJobLease {
  if (row.state !== "running" && row.state !== "ready") {
    throw new Error("leased question job has an unsupported state");
  }
  return Object.freeze({
    answerCandidate: row.answer_candidate === null
      ? null
      : decodeGroundedAnswerCandidate(row.answer_candidate),
    attempts: row.attempts,
    binding: decodeQuestionBinding(row.binding),
    generation: row.generation,
    groundingPlan: row.grounding_plan === null
      ? null
      : decodeGroundingPlan(row.grounding_plan),
    jobId: row.question_id,
    questionText: row.question_text,
    state: row.state,
  });
}

export class PostgresQuestionJobLeaseStore {
  private readonly policyTransaction: PostgresQuestionPolicyTransaction;

  public constructor(
    pool: Pool,
    policy: QuestionPolicyIdentity,
    private readonly providerAttempts: PostgresQuestionProviderAttemptStore,
  ) {
    this.policyTransaction = new PostgresQuestionPolicyTransaction(pool, policy);
  }

  public leaseNext(
    input: Parameters<QuestionJobStore["leaseNext"]>[0],
  ): Promise<QuestionJobLease | null> {
    const leaseSeconds = requireLeaseSeconds(input.leaseSeconds);
    requireMaximumProviderAttempts(input.maximumProviderAttempts);
    return this.policyTransaction.execute(null, async (client) => {
      await this.providerAttempts.failAbandoned(client);
      const result = await client.query<QuestionJobRow>(
        `
          WITH selected AS (
            SELECT question_id
            FROM meeting_knowledge.question_jobs
            WHERE expires_at > transaction_timestamp()
              AND policy_epoch = $3
              AND binding ->> 'policyVersion' = $4
              AND binding ->> 'authorizationPolicyVersion' = $5
              AND (
                state = 'queued' OR
                (state = 'ready' AND
                  lease_until <= transaction_timestamp()) OR
                (state = 'running'
                  AND lease_until <= transaction_timestamp()
                  AND provider_attempt_state IN ('none', 'failed'))
              )
            ORDER BY created_at, question_id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          UPDATE meeting_knowledge.question_jobs AS job
          SET state = CASE WHEN job.state = 'ready' THEN 'ready' ELSE 'running' END,
              generation = job.generation + 1,
              lease_owner = $1,
              worker_protocol_epoch = 2,
              worker_protocol_generation = job.generation + 1,
              lease_until = transaction_timestamp() + make_interval(secs => $2),
              updated_at = transaction_timestamp()
          FROM selected
          WHERE job.question_id = selected.question_id
          RETURNING job.question_id, job.question_text, job.binding,
                    job.state, job.attempts, job.generation::float8 AS generation,
                    job.grounding_plan, job.answer_candidate
        `,
        [
          input.workerId,
          leaseSeconds,
          ...questionPolicyParameters(this.policyTransaction.identity),
        ],
      );
      const row = result.rows[0];
      return row === undefined ? null : toLease(row);
    });
  }

}
