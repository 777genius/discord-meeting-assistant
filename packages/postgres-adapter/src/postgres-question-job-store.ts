import type {
  QuestionJobLease,
  QuestionJobState,
  QuestionJobStore,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { Pool, PoolClient } from "pg";

import { lockMeetingKnowledgeSources } from "./postgres-answer-source-withdrawal.js";
import {
  decodeGroundedAnswerCandidate,
  decodeGroundingPlan,
  decodeQuestionBinding,
} from "./postgres-meeting-knowledge-codecs.js";
import {
  PostgresQuestionPolicyFence,
  type QuestionPolicyIdentity,
} from "./postgres-question-policy-fence.js";
import { PostgresQuestionProviderAttemptStore } from "./postgres-question-provider-attempt-store.js";

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

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original persistence failure.
  }
}

function requireLeaseSeconds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 5 || value > 600) {
    throw new RangeError("question job lease must be between 5 and 600 seconds");
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

export class PostgresQuestionJobStore implements QuestionJobStore {
  private readonly policyFence: PostgresQuestionPolicyFence;
  private readonly providerAttempts: PostgresQuestionProviderAttemptStore;

  public constructor(
    private readonly pool: Pool,
    policy: QuestionPolicyIdentity,
  ) {
    this.policyFence = new PostgresQuestionPolicyFence(policy);
    this.providerAttempts = new PostgresQuestionProviderAttemptStore(pool, policy);
  }

  public async leaseNext(input: {
    readonly leaseSeconds: number;
    readonly maximumProviderAttempts: number;
    readonly workerId: string;
  }): Promise<QuestionJobLease | null> {
    const leaseSeconds = requireLeaseSeconds(input.leaseSeconds);
    requireMaximumProviderAttempts(input.maximumProviderAttempts);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!await this.policyFence.lockCurrent(client)) {
        await client.query("COMMIT");
        return null;
      }
      await this.expireJobs(client);
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
                state IN ('running', 'ready')
                  AND lease_until <= transaction_timestamp()
                  AND provider_attempt_state <> 'reserved'
              )
            ORDER BY created_at, question_id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          UPDATE meeting_knowledge.question_jobs AS job
          SET state = CASE WHEN job.state = 'ready' THEN 'ready' ELSE 'running' END,
              generation = job.generation + 1,
              lease_owner = $1,
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
          this.policyFence.identity.policyEpoch,
          this.policyFence.identity.policyVersion,
          this.policyFence.identity.authorizationPolicyVersion,
        ],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      return row === undefined ? null : toLease(row);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public reserveProviderAttempt(
    input: Parameters<QuestionJobStore["reserveProviderAttempt"]>[0],
  ): Promise<boolean> {
    return this.providerAttempts.reserve(input);
  }

  public recordProviderAttemptOutcome(
    input: Parameters<QuestionJobStore["recordProviderAttemptOutcome"]>[0],
  ): Promise<boolean> {
    return this.providerAttempts.recordOutcome(input);
  }

  public async persistGroundingPlan(
    input: Parameters<QuestionJobStore["persistGroundingPlan"]>[0],
  ): Promise<boolean> {
    return this.withCurrentPolicyMutation(async (client) => {
      await lockMeetingKnowledgeSources(client, input.sourceMeetingIds);
      const result = await client.query(
        `
          WITH source_fence AS (
            SELECT meeting_id, operation
            FROM meeting_core.historical_memory_sync
            WHERE meeting_id = ANY($6::text[])
            FOR UPDATE
          )
          UPDATE meeting_knowledge.question_jobs AS job
          SET grounding_plan = $3::jsonb,
              grounding_measurement = $4::jsonb,
              runtime_profile = $5,
              source_meeting_ids = $6::text[],
              updated_at = transaction_timestamp()
          WHERE question_id = $1
            AND generation = $2
            AND state = 'running'
            AND lease_until > transaction_timestamp()
            AND NOT EXISTS (
              SELECT 1 FROM source_fence WHERE operation = 'delete_meeting'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM meeting_knowledge.withdrawn_meeting_sources AS withdrawn
              WHERE withdrawn.meeting_id = ANY($6::text[])
            )
            AND ${currentPolicySql(7)}
        `,
        [
          input.jobId,
          input.generation,
          JSON.stringify(input.plan),
          JSON.stringify({
            inputTokens: input.measurement.inputTokens,
            requestBytes: input.measurement.requestBytes,
            schemaVersion: 1,
          }),
          input.runtimeProfile,
          input.sourceMeetingIds,
          ...policyParameters(this.policyFence.identity),
        ],
      );
      return result.rowCount === 1;
    });
  }

  public async markReady(
    input: Parameters<QuestionJobStore["markReady"]>[0],
  ): Promise<boolean> {
    return this.withCurrentPolicyMutation(async (client) => {
      const result = await client.query(
        `
          UPDATE meeting_knowledge.question_jobs AS job
          SET state = 'ready',
              answer_candidate = $3::jsonb,
              ready_at = COALESCE(ready_at, transaction_timestamp()),
              updated_at = transaction_timestamp()
          WHERE question_id = $1
            AND generation = $2
            AND state = 'running'
            AND grounding_plan IS NOT NULL
            AND provider_attempt_state = 'completed'
            AND lease_until > transaction_timestamp()
            AND ${currentPolicySql(4)}
        `,
        [
          input.jobId,
          input.generation,
          JSON.stringify(input.answerCandidate),
          ...policyParameters(this.policyFence.identity),
        ],
      );
      return result.rowCount === 1;
    });
  }

  public async releaseForRetry(
    input: Parameters<QuestionJobStore["releaseForRetry"]>[0],
  ): Promise<boolean> {
    return this.withCurrentPolicyMutation(async (client) => {
      const result = await client.query(
        `
          UPDATE meeting_knowledge.question_jobs AS job
          SET state = 'queued',
              lease_owner = NULL,
              lease_until = NULL,
              retry_reason = $3,
              updated_at = transaction_timestamp()
          WHERE question_id = $1
            AND generation = $2
            AND state = 'running'
            AND ${currentPolicySql(4)}
            AND provider_attempt_state = 'failed'
        `,
        [
          input.jobId,
          input.generation,
          input.reason.slice(0, 256),
          ...policyParameters(this.policyFence.identity),
        ],
      );
      return result.rowCount === 1;
    });
  }

  public async settle(
    input: Parameters<QuestionJobStore["settle"]>[0],
  ): Promise<boolean> {
    return this.withCurrentPolicyMutation(async (client) => {
      const result = await client.query(
        `
          UPDATE meeting_knowledge.question_jobs AS job
          SET state = 'terminal',
              outcome = $3,
              authorization_principal_ref = NULL,
              question_text = NULL,
              binding = NULL,
              grounding_plan = NULL,
              answer_candidate = NULL,
              lease_owner = NULL,
              lease_until = NULL,
              terminal_at = COALESCE(terminal_at, transaction_timestamp()),
              scrubbed_at = COALESCE(scrubbed_at, transaction_timestamp()),
              updated_at = transaction_timestamp()
          WHERE question_id = $1
            AND generation = $2
            AND state IN ('running', 'ready')
            AND ${currentPolicySql(4)}
        `,
        [
          input.jobId,
          input.generation,
          input.outcome,
          ...policyParameters(this.policyFence.identity),
        ],
      );
      return result.rowCount === 1;
    });
  }

  public async cancelQuestion(questionId: string): Promise<void> {
    await this.pool.query(
      `
        WITH locked_question AS (
          SELECT question_id
          FROM meeting_knowledge.question_jobs
          WHERE question_id = $1
          FOR UPDATE
        ), terminalized AS (
        UPDATE meeting_knowledge.question_jobs AS job
        SET state = 'terminal',
            outcome = CASE WHEN EXISTS (
              SELECT 1
              FROM meeting_core.answer_effects AS effect
              WHERE effect.effect_id = 'meeting-knowledge-answer:v1:' || job.question_id
                AND effect.state IN (
                  'request_started', 'delivered', 'outcome_unknown', 'absent_unconfirmed'
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
        )
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
              ) THEN COALESCE(effect.retraction_requested_at, transaction_timestamp())
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
      `,
      [questionId],
    );
  }

  public async hasActiveQuestion(questionId: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        SELECT 1
        FROM meeting_knowledge.question_jobs AS job
        WHERE question_id = $1
          AND state <> 'terminal'
      `,
      [questionId],
    );
    return result.rowCount === 1;
  }

  public async confirmActiveLease(input: {
    readonly generation: number;
    readonly jobId: string;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `
        SELECT 1
        FROM meeting_knowledge.question_jobs AS job
        WHERE question_id = $1
          AND generation = $2
          AND state IN ('running', 'ready')
          AND lease_until > transaction_timestamp()
          AND expires_at > transaction_timestamp()
          AND ${currentPolicySql(3)}
      `,
      [input.jobId, input.generation, ...policyParameters(this.policyFence.identity)],
    );
    return result.rowCount === 1;
  }

  private async expireJobs(executor: Pick<PoolClient, "query">): Promise<void> {
    await executor.query(
      `
        UPDATE meeting_knowledge.question_jobs AS job
        SET state = 'terminal',
            outcome = CASE WHEN EXISTS (
              SELECT 1
              FROM meeting_core.answer_effects AS effect
              WHERE effect.effect_id = 'meeting-knowledge-answer:v1:' || job.question_id
                AND effect.state IN (
                  'request_started', 'delivered', 'outcome_unknown', 'absent_unconfirmed'
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
        WHERE job.state <> 'terminal'
          AND job.expires_at <= transaction_timestamp()
          AND ${currentPolicySql(1)}
      `,
      [...policyParameters(this.policyFence.identity)],
    );
  }

  private async withCurrentPolicyMutation(
    operation: (client: PoolClient) => Promise<boolean>,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!await this.policyFence.lockCurrent(client)) {
        await client.query("COMMIT");
        return false;
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

function policyParameters(policy: QuestionPolicyIdentity): readonly [number, string, string] {
  return [policy.policyEpoch, policy.policyVersion, policy.authorizationPolicyVersion];
}

function currentPolicySql(firstParameter: number): string {
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

function requireMaximumProviderAttempts(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) {
    throw new RangeError("maximum provider attempts must be between 1 and 32");
  }
  return value;
}
