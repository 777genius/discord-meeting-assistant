import type {
  QuestionJobLease,
  QuestionJobStore,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { Pool } from "pg";

import { lockMeetingKnowledgeSources } from "./postgres-answer-source-withdrawal.js";
import {
  PostgresQuestionJobLeaseStore,
} from "./postgres-question-job-lease-store.js";
import type { QuestionPolicyIdentity } from "./postgres-question-policy-fence.js";
import {
  currentQuestionPolicySql,
  PostgresQuestionPolicyTransaction,
  questionPolicyParameters,
} from "./postgres-question-policy-transaction.js";
import { PostgresQuestionProviderAttemptStore } from "./postgres-question-provider-attempt-store.js";

export class PostgresQuestionJobStore implements QuestionJobStore {
  private readonly leases: PostgresQuestionJobLeaseStore;
  private readonly policyTransaction: PostgresQuestionPolicyTransaction;
  private readonly providerAttempts: PostgresQuestionProviderAttemptStore;

  public constructor(
    private readonly pool: Pool,
    policy: QuestionPolicyIdentity,
  ) {
    this.policyTransaction = new PostgresQuestionPolicyTransaction(pool, policy);
    this.providerAttempts = new PostgresQuestionProviderAttemptStore(pool, policy);
    this.leases = new PostgresQuestionJobLeaseStore(
      pool,
      policy,
      this.providerAttempts,
    );
  }

  public leaseNext(
    input: Parameters<QuestionJobStore["leaseNext"]>[0],
  ): Promise<QuestionJobLease | null> {
    return this.leases.leaseNext(input);
  }

  public reserveProviderAttempt(
    input: Parameters<QuestionJobStore["reserveProviderAttempt"]>[0],
  ): Promise<boolean> {
    return this.providerAttempts.reserve(input);
  }

  public completeProviderAttempt(
    input: Parameters<QuestionJobStore["completeProviderAttempt"]>[0],
  ): Promise<boolean> {
    return this.providerAttempts.complete(input);
  }

  public abortProviderAttempt(
    input: Parameters<QuestionJobStore["abortProviderAttempt"]>[0],
  ): Promise<boolean> {
    return this.providerAttempts.abort(input);
  }

  public failProviderAttempt(
    input: Parameters<QuestionJobStore["failProviderAttempt"]>[0],
  ): Promise<"deferred" | "settled" | "stale"> {
    return this.providerAttempts.fail(input);
  }

  public async persistGroundingPlan(
    input: Parameters<QuestionJobStore["persistGroundingPlan"]>[0],
  ): Promise<boolean> {
    return this.policyTransaction.execute(false, async (client) => {
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
            AND ${currentQuestionPolicySql(7)}
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
          ...questionPolicyParameters(this.policyTransaction.identity),
        ],
      );
      return result.rowCount === 1;
    });
  }

  public async settle(
    input: Parameters<QuestionJobStore["settle"]>[0],
  ): Promise<boolean> {
    return this.policyTransaction.execute(false, async (client) => {
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
            AND ${currentQuestionPolicySql(4)}
        `,
        [
          input.jobId,
          input.generation,
          input.outcome,
          ...questionPolicyParameters(this.policyTransaction.identity),
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
            payload_bytes = '{}',
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
          AND ${currentQuestionPolicySql(3)}
      `,
      [
        input.jobId,
        input.generation,
        ...questionPolicyParameters(this.policyTransaction.identity),
      ],
    );
    return result.rowCount === 1;
  }
}
