import type { QuestionBindingSnapshot } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import type { Pool } from "pg";
import { decodePersistedQuestionRecovery,
  durableQuestionRecoveryRetryReason,
  reconciliationDispositionForRecoveryReason } from
  "./postgres-question-recovery-codec.js";

export const questionReconciliationPageSql = `WITH job_candidates AS (
         SELECT question_id
         FROM meeting_knowledge.question_jobs
         WHERE (state <> 'terminal' OR reconciliation_disposition = 'reconcile')
           AND ($1::text IS NULL OR question_id > $1)
         ORDER BY question_id
         LIMIT $2
       ), effect_candidates AS (
         SELECT substring(effect.effect_id FROM 29) AS question_id
         FROM meeting_core.answer_effects AS effect
         WHERE effect.effect_id LIKE 'meeting-knowledge-answer:v1:%'
           AND effect.state IN (
             'request_started', 'outcome_unknown', 'absent_unconfirmed',
             'delivered', 'retraction_pending'
           )
           AND (effect.state <> 'delivered' OR EXISTS (
             SELECT 1 FROM meeting_knowledge.question_jobs AS effect_job
             WHERE effect_job.question_id = substring(effect.effect_id FROM 29)
               AND (effect_job.state <> 'terminal' OR
                 effect_job.reconciliation_disposition = 'reconcile')
           ))
           AND ($1::text IS NULL OR
             effect.effect_id > 'meeting-knowledge-answer:v1:' || $1)
         ORDER BY effect.effect_id
         LIMIT $2
       ), eligible AS (
         SELECT question_id FROM job_candidates
         UNION
         SELECT question_id FROM effect_candidates
         ORDER BY question_id
         LIMIT $2
       )
       SELECT job.question_id, job.authorization_principal_ref, job.binding,
              job.binding_hash, job.grounding_plan, job.question_text, job.state,
              job.reconciliation_disposition, job.reconciliation_reason,
              job.final_projection_receipt, job.question_hash,
              job.requester_subject, job.scope_id,
              job.binding ->> 'botApplicationIdentity' AS bot_application_identity,
              COALESCE(job.delivery_container_id,
                job.binding ->> 'deliveryContainerId',
                effect.delivery_container_id) AS delivery_container_id
       FROM eligible
       JOIN meeting_knowledge.question_jobs AS job USING (question_id)
       LEFT JOIN meeting_core.answer_effects AS effect
         ON effect.effect_id = 'meeting-knowledge-answer:v1:' || job.question_id
       ORDER BY job.question_id`;

export class PostgresQuestionReconciliationCheckpoint {
  public constructor(private readonly pool: Pool) {}

  public async load(): Promise<string | null> {
    const result = await this.pool.query<{ readonly after_question_id: string | null }>(
      `SELECT after_question_id
       FROM meeting_knowledge.question_reconciliation_checkpoints
       WHERE checkpoint_key = 'discord-active-questions-v1'`,
    );
    if (result.rowCount !== 1) {
      throw new Error("question reconciliation checkpoint is unavailable");
    }
    return result.rows[0]?.after_question_id ?? null;
  }

  public async list(input: {
    readonly afterQuestionId: string | null;
    readonly maximumRows: number;
  }) {
    validatePage(input);
    const result = await this.pool.query<{
      readonly authorization_principal_ref: string | null;
      readonly binding: unknown;
      readonly binding_hash: string;
      readonly bot_application_identity: string | null;
      readonly delivery_container_id: string | null;
      readonly final_projection_receipt: string;
      readonly grounding_plan: unknown;
      readonly question_hash: string;
      readonly question_id: string;
      readonly question_text: string | null;
      readonly requester_subject: string;
      readonly reconciliation_disposition: "quarantined" | "reconcile" | null;
      readonly reconciliation_reason: string | null;
      readonly scope_id: string;
      readonly state: string;
    }>(
      questionReconciliationPageSql,
      [input.afterQuestionId, input.maximumRows],
    );
    const reconciled = [];
    for (const row of result.rows) {
      let binding: QuestionBindingSnapshot | null = null;
      let disposition: "quarantined" | "reconcile" =
        row.reconciliation_disposition ?? "reconcile";
      if (row.state !== "terminal") {
        const recovery = row.binding === null || row.question_text === null
          ? { reason: "binding_structurally_corrupt" as const,
              status: "incompatible" as const }
          : decodePersistedQuestionRecovery({ binding: row.binding,
              bindingHash: row.binding_hash, groundingPlan: row.grounding_plan,
              questionText: row.question_text });
        if (recovery.status === "decoded" &&
          recovery.binding.questionId === row.question_id) {
          binding = recovery.binding;
        } else {
          const reason = recovery.status === "decoded"
            ? "binding_row_identity_conflict" : recovery.reason;
          const terminalized = await this.terminalizeIncompatible(
            row.question_id, row.binding_hash, reason,
          );
          const trustedReconciliationAuthority = terminalized &&
            recovery.status !== "decoded" &&
            reconciliationDispositionForRecoveryReason(recovery.reason) === "reconcile";
          if (!trustedReconciliationAuthority) {
            disposition = "quarantined";
          }
        }
      }
      const deliveryContainerId = binding?.deliveryContainerId ??
        row.delivery_container_id;
      if (deliveryContainerId === null) {disposition = "quarantined";}
      reconciled.push(Object.freeze({
        authorizationPrincipalRef: row.authorization_principal_ref,
        botApplicationIdentity: binding?.botApplicationIdentity ??
          row.bot_application_identity,
        deliveryContainerId,
        finalProjectionReceipt: row.final_projection_receipt,
        questionHash: row.question_hash,
        questionId: row.question_id,
        reconciliationDisposition: disposition,
        requesterSubject: row.requester_subject,
        scopeId: row.scope_id,
      }));
    }
    return Object.freeze(reconciled);
  }

  private async terminalizeIncompatible(
    questionId: string,
    bindingHash: string,
    reason: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE meeting_knowledge.question_jobs
       SET state = 'terminal', outcome = 'stale_binding',
           retry_reason = $3, authorization_principal_ref = NULL,
           delivery_container_id = COALESCE(
             delivery_container_id, binding ->> 'deliveryContainerId'
           ),
           reconciliation_disposition = $4,
           reconciliation_reason = $5,
           question_text = NULL, binding = NULL, grounding_plan = NULL,
           answer_candidate = NULL, lease_owner = NULL, lease_until = NULL,
           terminal_at = COALESCE(terminal_at, transaction_timestamp()),
           scrubbed_at = COALESCE(scrubbed_at, transaction_timestamp()),
           updated_at = transaction_timestamp()
       WHERE question_id = $1 AND binding_hash = $2 AND state <> 'terminal'`,
      [questionId, bindingHash, durableQuestionRecoveryRetryReason(reason),
        reconciliationDispositionForRecoveryReason(reason),
        reason],
    );
    return result.rowCount === 1;
  }

  public async save(input: {
    readonly expectedAfterQuestionId: string | null;
    readonly nextAfterQuestionId: string | null;
  }): Promise<boolean> {
    for (const cursor of [input.expectedAfterQuestionId, input.nextAfterQuestionId]) {
      if (cursor !== null && !/^[0-9]{17,20}$/u.test(cursor)) {
        throw new RangeError("question reconciliation cursor is invalid");
      }
    }
    const result = await this.pool.query(
      `UPDATE meeting_knowledge.question_reconciliation_checkpoints
       SET after_question_id = $2, updated_at = transaction_timestamp()
       WHERE checkpoint_key = 'discord-active-questions-v1'
         AND after_question_id IS NOT DISTINCT FROM $1::text`,
      [input.expectedAfterQuestionId, input.nextAfterQuestionId],
    );
    return result.rowCount === 1;
  }
}

function validatePage(input: {
  readonly afterQuestionId: string | null;
  readonly maximumRows: number;
}): void {
  if (!Number.isSafeInteger(input.maximumRows) || input.maximumRows < 1 ||
    input.maximumRows > 100 || (input.afterQuestionId !== null &&
      !/^[0-9]{17,20}$/u.test(input.afterQuestionId))) {
    throw new RangeError("active question reconciliation page is invalid");
  }
}
