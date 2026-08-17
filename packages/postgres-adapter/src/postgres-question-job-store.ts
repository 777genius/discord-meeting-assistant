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
  public constructor(private readonly pool: Pool) {}

  public async leaseNext(input: {
    readonly leaseSeconds: number;
    readonly workerId: string;
  }): Promise<QuestionJobLease | null> {
    const leaseSeconds = requireLeaseSeconds(input.leaseSeconds);
    await this.expireJobs();
    const result = await this.pool.query<QuestionJobRow>(
      `
        WITH selected AS (
          SELECT question_id
          FROM meeting_knowledge.question_jobs
          WHERE expires_at > transaction_timestamp()
            AND (
              state = 'queued' OR
              state IN ('running', 'ready') AND lease_until <= transaction_timestamp()
            )
          ORDER BY created_at, question_id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE meeting_knowledge.question_jobs AS job
        SET state = CASE WHEN job.state = 'ready' THEN 'ready' ELSE 'running' END,
            attempts = CASE WHEN job.state = 'ready' THEN job.attempts ELSE job.attempts + 1 END,
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
      [input.workerId, leaseSeconds],
    );
    const row = result.rows[0];
    return row === undefined ? null : toLease(row);
  }

  public async persistGroundingPlan(
    input: Parameters<QuestionJobStore["persistGroundingPlan"]>[0],
  ): Promise<boolean> {
    const result = await this.pool.query(
      `
        WITH source_fence AS (
          SELECT meeting_id, operation
          FROM meeting_core.historical_memory_sync
          WHERE meeting_id = ANY($6::text[])
          FOR UPDATE
        )
        UPDATE meeting_knowledge.question_jobs
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
      ],
    );
    return result.rowCount === 1;
  }

  public async markReady(
    input: Parameters<QuestionJobStore["markReady"]>[0],
  ): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE meeting_knowledge.question_jobs
        SET state = 'ready',
            answer_candidate = $3::jsonb,
            ready_at = COALESCE(ready_at, transaction_timestamp()),
            updated_at = transaction_timestamp()
        WHERE question_id = $1
          AND generation = $2
          AND state = 'running'
          AND grounding_plan IS NOT NULL
          AND lease_until > transaction_timestamp()
      `,
      [input.jobId, input.generation, JSON.stringify(input.answerCandidate)],
    );
    return result.rowCount === 1;
  }

  public async releaseForRetry(
    input: Parameters<QuestionJobStore["releaseForRetry"]>[0],
  ): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE meeting_knowledge.question_jobs
        SET state = 'queued',
            lease_owner = NULL,
            lease_until = NULL,
            retry_reason = $3,
            updated_at = transaction_timestamp()
        WHERE question_id = $1
          AND generation = $2
          AND state = 'running'
      `,
      [input.jobId, input.generation, input.reason.slice(0, 256)],
    );
    return result.rowCount === 1;
  }

  public async settle(
    input: Parameters<QuestionJobStore["settle"]>[0],
  ): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE meeting_knowledge.question_jobs
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
      `,
      [input.jobId, input.generation, input.outcome],
    );
    return result.rowCount === 1;
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
        FROM meeting_knowledge.question_jobs
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
        FROM meeting_knowledge.question_jobs
        WHERE question_id = $1
          AND generation = $2
          AND state IN ('running', 'ready')
          AND lease_until > transaction_timestamp()
          AND expires_at > transaction_timestamp()
      `,
      [input.jobId, input.generation],
    );
    return result.rowCount === 1;
  }

  private async expireJobs(): Promise<void> {
    await this.pool.query(
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
      `,
    );
  }
}
