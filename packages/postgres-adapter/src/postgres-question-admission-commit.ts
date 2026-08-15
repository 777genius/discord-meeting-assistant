import { createHash } from "node:crypto";

import {
  QuestionBinding,
  type QuestionAdmissionCommitPort,
  type QuestionAdmissionCommitResult,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { Pool, PoolClient } from "pg";

import { decodeQuestionBinding } from "./postgres-meeting-knowledge-codecs.js";
import {
  finalReplyAuthorityMatches,
  loadLockedFinalReplyAuthority,
} from "./postgres-final-reply-evidence.js";

interface StoredQuestionRow {
  readonly binding: unknown;
  readonly binding_hash: string;
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

function admissionBindingsEqual(
  left: ReturnType<QuestionBinding["toSnapshot"]>,
  right: ReturnType<QuestionBinding["toSnapshot"]>,
): boolean {
  return admissionBindingHash(left) === admissionBindingHash(right);
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
  public constructor(
    private readonly pool: Pool,
    private readonly botApplicationIdentity: string,
  ) {}

  public async commit(
    input: Parameters<QuestionAdmissionCommitPort["commit"]>[0],
  ): Promise<QuestionAdmissionCommitResult> {
    const binding = QuestionBinding.create(input.binding).toSnapshot();
    if (
      input.authorization.digest !== binding.authorizationDigest ||
      input.authorization.policyVersion !== binding.authorizationPolicyVersion ||
      input.authorization.scopeId !== binding.scopeId ||
      input.authorization.containerId !== binding.projectionTargetContainerId
    ) {
      return { status: "conflict" };
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.lockQuestion(client, binding.questionId);
      const existing = await this.findQuestion(client, binding.questionId);
      if (existing !== null) {
        const bindingHash = admissionBindingHash(binding);
        const activeBindingMatches = existing.binding === null || admissionBindingsEqual(
          decodeQuestionBinding(existing.binding),
          binding,
        );
        const result = activeBindingMatches && existing.binding_hash === bindingHash
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
            expires_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11,
            transaction_timestamp() + make_interval(secs => $12)
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
    readonly projectionTargetContainerId: string;
    readonly remoteMessageId: string;
  }): Promise<readonly string[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          INSERT INTO meeting_knowledge.unavailable_final_projections
            (final_projection_receipt)
          SELECT projection.receipt
          FROM (
            SELECT meeting.snapshot -> 'publication' ->> 'externalPublicationId'
              AS receipt
            FROM meeting_core.meetings AS meeting
            WHERE meeting.snapshot ->> 'publicationTargetId' = $1
              AND meeting.snapshot -> 'publication' ->> 'externalPublicationId'
                LIKE ('%:message:' || $2)
            UNION ALL
            SELECT live.snapshot ->> 'projectionExternalId' AS receipt
            FROM meeting_core.live_meetings AS live
            WHERE live.snapshot ->> 'publicationTargetId' = $1
              AND live.snapshot ->> 'projectionExternalId'
                LIKE ('%:message:' || $2)
          ) AS projection
          WHERE projection.receipt IS NOT NULL
          ON CONFLICT (final_projection_receipt) DO NOTHING
        `,
        [input.projectionTargetContainerId, input.remoteMessageId],
      );
      const affected = await client.query<{ readonly question_id: string }>(
        `
          SELECT job.question_id
          FROM meeting_knowledge.question_jobs AS job
          WHERE job.state <> 'terminal'
            AND job.final_projection_receipt IN (
              SELECT unavailable.final_projection_receipt
              FROM meeting_knowledge.unavailable_final_projections AS unavailable
            )
          ORDER BY job.question_id
          FOR UPDATE OF job
        `,
      );
      await client.query("COMMIT");
      return Object.freeze(affected.rows.map(({ question_id: questionId }) => questionId));
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
        SELECT question_id, binding, binding_hash
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
