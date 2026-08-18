import { createHash } from "node:crypto";

import {
  QuestionBinding,
  type QuestionAdmissionCommitPort,
  type QuestionAdmissionCommitResult,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { Pool, PoolClient } from "pg";

import { lockMeetingKnowledgeSource } from "./postgres-answer-source-withdrawal.js";
import { decodeQuestionBinding } from "./postgres-meeting-knowledge-codecs.js";
import {
  finalReplyAuthorityMatches,
  loadLockedFinalReplyAuthority,
} from "./postgres-final-reply-evidence.js";
import {
  lockMeetingKnowledgeProjection,
  pruneUnmatchedProjectionTombstones,
} from "./postgres-projection-withdrawal.js";
import {
  PostgresQuestionPolicyFence,
  type QuestionPolicyIdentity,
} from "./postgres-question-policy-fence.js";

interface StoredQuestionRow {
  readonly binding: unknown;
  readonly binding_hash: string;
  readonly policy_epoch: number;
  readonly question_id: string;
}

interface CountRow {
  readonly requester_count: number;
  readonly scope_count: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function admissionBindingHash(
  binding: ReturnType<QuestionBinding["toSnapshot"]>,
): string {
  const { authorizationPrincipalRef: _ephemeralPrincipal, ...dedupeBinding } = binding;
  return sha256(JSON.stringify(dedupeBinding));
}

function legacyAdmissionBindingHash(
  binding: ReturnType<QuestionBinding["toSnapshot"]>,
): string {
  const {
    authorizationPrincipalRef: _ephemeralPrincipal,
    deliveryContainerId: _deliveryContainerId,
    ...legacyDedupeBinding
  } = binding;
  return sha256(JSON.stringify(legacyDedupeBinding));
}

function admissionBindingsEqual(
  left: ReturnType<QuestionBinding["toSnapshot"]>,
  right: ReturnType<QuestionBinding["toSnapshot"]>,
): boolean {
  return admissionBindingHash(left) === admissionBindingHash(right);
}

function admissionMatchesPolicy(
  input: Parameters<QuestionAdmissionCommitPort["commit"]>[0],
  binding: ReturnType<QuestionBinding["toSnapshot"]>,
  policy: QuestionPolicyIdentity,
): boolean {
  return input.authorization.digest === binding.authorizationDigest &&
    input.authorization.policyVersion === binding.authorizationPolicyVersion &&
    input.authorization.scopeId === binding.scopeId &&
    input.authorization.deliveryContainerId === binding.deliveryContainerId &&
    input.authorization.containerId === binding.projectionTargetContainerId &&
    binding.policyVersion === policy.policyVersion &&
    binding.authorizationPolicyVersion === policy.authorizationPolicyVersion;
}

async function beginCurrentPolicy(
  client: PoolClient,
  fence: PostgresQuestionPolicyFence,
): Promise<boolean> {
  await client.query("BEGIN");
  return fence.lockCurrent(client);
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the admission failure.
  }
}

export class PostgresQuestionAdmissionCommit
  implements QuestionAdmissionCommitPort
{
  private readonly policyFence: PostgresQuestionPolicyFence;

  public constructor(
    private readonly pool: Pool,
    private readonly botApplicationIdentity: string,
    policy: QuestionPolicyIdentity,
  ) {
    this.policyFence = new PostgresQuestionPolicyFence(policy);
  }

  public async commit(
    input: Parameters<QuestionAdmissionCommitPort["commit"]>[0],
  ): Promise<QuestionAdmissionCommitResult> {
    const binding = QuestionBinding.create(input.binding).toSnapshot();
    if (!admissionMatchesPolicy(input, binding, this.policyFence.identity)) {
      return { status: "conflict" };
    }
    const client = await this.pool.connect();
    try {
      if (!await beginCurrentPolicy(client, this.policyFence)) {
        await client.query("ROLLBACK");
        return { status: "stale" };
      }
      await this.lockQuestion(client, binding.questionId);
      await lockMeetingKnowledgeProjection(client, binding.finalProjectionReceipt);
      await lockMeetingKnowledgeSource(client, binding.meetingId);
      const existing = await this.findQuestion(client, binding.questionId);
      if (existing !== null) {
        const bindingHash = admissionBindingHash(binding);
        const activeBindingMatches = existing.binding === null || admissionBindingsEqual(
          decodeQuestionBinding(existing.binding),
          binding,
        );
        const storedHashMatches = existing.binding_hash === bindingHash ||
          existing.binding_hash === legacyAdmissionBindingHash(binding);
        const result = activeBindingMatches && storedHashMatches &&
            existing.policy_epoch === this.policyFence.identity.policyEpoch
          ? { jobId: existing.question_id, status: "duplicate" } as const
          : { status: "conflict" } as const;
        await client.query("COMMIT");
        return result;
      }
      const authority = await loadLockedFinalReplyAuthority(
        client,
        binding.meetingId,
        this.botApplicationIdentity,
      );
      if (
        authority === null ||
        !finalReplyAuthorityMatches(authority.binding, binding) ||
        !authority.binding.humanActorIds.includes(input.authorization.actorId) ||
        await this.isProjectionUnavailable(client, binding.finalProjectionReceipt) ||
        await this.isSourceWithdrawn(client, binding.meetingId) ||
        !await this.authorizationIsCurrent(client, input.authorization.expiresAt)
      ) {
        await client.query("ROLLBACK");
        return { status: "stale" };
      }
      await this.lockRateSubjects(
        client,
        binding.requesterSubject,
        binding.scopeId,
      );
      if (await this.isRateLimited(client, input)) {
        await client.query("ROLLBACK");
        return { status: "rate_limited" };
      }
      const bindingJson = JSON.stringify(binding);
      await client.query(
        `
          INSERT INTO meeting_knowledge.question_jobs (
            question_id, requester_subject, question_hash, scope_id,
            final_projection_receipt, authorization_principal_ref,
            authorization_digest, locale, question_text, binding, binding_hash,
            source_meeting_ids, policy_epoch, expires_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11,
            ARRAY[$12]::text[], $13,
            transaction_timestamp() + make_interval(secs => $14)
          )
        `,
        [
          binding.questionId,
          binding.requesterSubject,
          binding.questionHash,
          binding.scopeId,
          binding.finalProjectionReceipt,
          binding.authorizationPrincipalRef,
          binding.authorizationDigest,
          binding.expectedLocale,
          input.questionText,
          bindingJson,
          admissionBindingHash(binding),
          binding.meetingId,
          this.policyFence.identity.policyEpoch,
          input.ratePolicy.jobTtlSeconds,
        ],
      );
      await client.query(
        `
          INSERT INTO meeting_knowledge.question_rate_reservations
            (question_id, requester_subject, scope_id)
          VALUES ($1, $2, $3)
        `,
        [binding.questionId, binding.requesterSubject, binding.scopeId],
      );
      await client.query("COMMIT");
      return { jobId: binding.questionId, status: "committed" };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async withdrawProjection(input: {
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

  private async findQuestion(
    client: PoolClient,
    questionId: string,
  ): Promise<StoredQuestionRow | null> {
    const result = await client.query<StoredQuestionRow>(
      `
        SELECT question_id, binding, binding_hash, policy_epoch::float8 AS policy_epoch
        FROM meeting_knowledge.question_jobs
        WHERE question_id = $1
        FOR UPDATE
      `,
      [questionId],
    );
    return result.rows[0] ?? null;
  }

  private async lockQuestion(
    client: PoolClient,
    questionId: string,
  ): Promise<void> {
    await client.query(
      `
        SELECT pg_advisory_xact_lock(
          hashtextextended('meeting-knowledge:question:' || $1, 0)
        )
      `,
      [questionId],
    );
  }

  private async isProjectionUnavailable(
    client: PoolClient,
    receipt: string,
  ): Promise<boolean> {
    const result = await client.query(
      `
        SELECT 1
        FROM meeting_knowledge.unavailable_final_projections
        WHERE final_projection_receipt = $1
      `,
      [receipt],
    );
    return result.rowCount === 1;
  }

  private async isSourceWithdrawn(
    client: PoolClient,
    meetingId: string,
  ): Promise<boolean> {
    const result = await client.query(
      `
        SELECT 1
        FROM meeting_knowledge.withdrawn_meeting_sources
        WHERE meeting_id = $1
      `,
      [meetingId],
    );
    return result.rowCount === 1;
  }

  private async authorizationIsCurrent(
    client: PoolClient,
    expiresAt: string,
  ): Promise<boolean> {
    const result = await client.query<{ readonly current: boolean }>(
      "SELECT ($1::timestamptz > transaction_timestamp()) AS current",
      [expiresAt],
    );
    return result.rows[0]?.current === true;
  }

  private async isRateLimited(
    client: PoolClient,
    input: Parameters<QuestionAdmissionCommitPort["commit"]>[0],
  ): Promise<boolean> {
    const result = await client.query<CountRow>(
      `
        SELECT count(*) FILTER (
                 WHERE requester_subject = $1
               )::integer AS requester_count,
               count(*) FILTER (
                 WHERE scope_id = $2
               )::integer AS scope_count
        FROM meeting_knowledge.question_rate_reservations
        WHERE reserved_at >= transaction_timestamp() - interval '1 hour'
      `,
      [input.binding.requesterSubject, input.binding.scopeId],
    );
    const row = result.rows[0];
    return (row?.requester_count ?? 0) >= input.ratePolicy.requesterQuestionsPerHour ||
      (row?.scope_count ?? 0) >= input.ratePolicy.guildQuestionsPerHour;
  }

  private async lockRateSubjects(
    client: PoolClient,
    requesterSubject: string,
    scopeId: string,
  ): Promise<void> {
    await client.query(
      `
        SELECT pg_advisory_xact_lock(
          hashtextextended('meeting-knowledge:requester:' || $1, 0)
        )
      `,
      [requesterSubject],
    );
    await client.query(
      `
        SELECT pg_advisory_xact_lock(
          hashtextextended('meeting-knowledge:scope:' || $1, 0)
        )
      `,
      [scopeId],
    );
  }
}
