import {
  QuestionBinding,
  type QuestionAdmissionCommitPort,
  type QuestionAdmissionCommitResult,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { Pool, PoolClient } from "pg";

import { lockMeetingKnowledgeSource } from "./postgres-answer-source-withdrawal.js";
import {
  decodeQuestionBinding,
  questionAdmissionBindingHash,
  questionAdmissionBindingHashMatches,
} from "./postgres-meeting-knowledge-codecs.js";
import {
  finalReplyAuthorityMatches,
  loadLockedFinalReplyAuthority,
} from "./postgres-final-reply-evidence.js";
import { lockMeetingKnowledgeProjection } from "./postgres-projection-withdrawal.js";
import {
  PostgresQuestionPolicyFence,
  type QuestionPolicyIdentity,
} from "./postgres-question-policy-fence.js";
import { PostgresQuestionProjectionWithdrawalStore } from "./postgres-question-projection-withdrawal-store.js";

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

function admissionBindingHash(
  binding: ReturnType<QuestionBinding["toSnapshot"]>,
): string {
  return questionAdmissionBindingHash(binding);
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
  private readonly projectionWithdrawals: PostgresQuestionProjectionWithdrawalStore;

  public constructor(
    private readonly pool: Pool,
    private readonly botApplicationIdentity: string,
    policy: QuestionPolicyIdentity,
  ) {
    this.policyFence = new PostgresQuestionPolicyFence(policy);
    this.projectionWithdrawals = new PostgresQuestionProjectionWithdrawalStore(pool);
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
        const activeBindingMatches = existing.binding === null || admissionBindingsEqual(
          decodeQuestionBinding(existing.binding),
          binding,
        );
        const storedHashMatches = questionAdmissionBindingHashMatches(
          binding,
          existing.binding_hash,
        );
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

  public withdrawProjection(input: {
    readonly finalProjectionReceipt: string;
  }): Promise<readonly string[]> {
    return this.projectionWithdrawals.withdraw(input);
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
