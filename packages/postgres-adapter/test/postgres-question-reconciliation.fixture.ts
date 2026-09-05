import { QuestionBinding } from "@discord-meeting/meeting-core/meeting-knowledge";
import { createHash } from "node:crypto";
import type { Pool } from "pg";

import { questionAdmissionBindingHash } from "../src/postgres-meeting-knowledge-codecs.js";
import { exactPreCompositeFixture, serializeQuestionReconciliationFixtureRows } from
  "./postgres-protocol2-recovery.fixture.js";

export const questionPolicy = Object.freeze({
  authorizationPolicyVersion: "discord.participant-current-results.v1",
  policyEpoch: 1,
  policyVersion: "meeting-knowledge.focused-memory-final-reply.v2",
});

export function currentBinding(questionId: string) {
  return QuestionBinding.create({
    authorizationDigest: "a".repeat(64),
    authorizationPolicyVersion: questionPolicy.authorizationPolicyVersion,
    authorizationPrincipalRef: "principal:restart",
    botApplicationIdentity: "11111111111111111",
    bindingProtocolVersion: 2,
    canonicalEvidenceHash: "b".repeat(64),
    deliveryContainerId: "22222222222222222",
    expectedLocale: "en",
    finalProjectionEpoch: "projection-epoch-restart",
    finalProjectionReceipt:
      "discord:v2:channel:22222222222222222:message:44444444444444444",
    humanActorIds: ["77777777777777777"],
    meetingId: `meeting-${questionId}`,
    meetingRevision: 1,
    memoryGeneration: `focused-memory:v1:${"b".repeat(64)}`,
    policyVersion: questionPolicy.policyVersion,
    projectionTargetContainerId: "22222222222222222",
    questionHash: "c".repeat(64), questionId,
    requesterSubject: "d".repeat(64),
    retrievalBinding: {
      canonicalEvidenceFilters: { relativeTimeInterval: null,
        requiresSpeakerMatch: false, speakerIds: [] },
      cutoverEpoch: "restart-r1",
      localCurrentIdentity: { algorithmId: "canonical_local_exact_lexical_v1",
        profileFingerprint: "e".repeat(64),
        profileId: "meeting-knowledge.local-current.v2" },
      originalQuestion: "Question?", profileFingerprint: "e".repeat(64),
      provenanceSchemaVersion: 1,
      retrievalPath: "canonical_local_exact_lexical_v1",
    },
    roomId: "room-restart", scopeId: "66666666666666666",
    transcriptId: "transcript-restart", transcriptVersion: 1,
  }).toSnapshot();
}

export function flattenPlanNodes(value: unknown): readonly Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) { visit(item); }
      return;
    }
    if (typeof candidate !== "object" || candidate === null) { return; }
    const record = candidate as Record<string, unknown>;
    if (typeof record["Node Type"] === "string") { nodes.push(record); }
    for (const nested of Object.values(record)) { visit(nested); }
  };
  visit(value);
  return nodes;
}

// Only the sparse-corpus suite calls this fixture, after the shared truncation.
export async function prepareSparseTerminalCorpus(
  database: Pool,
  active: ReturnType<typeof currentBinding>,
  signal: AbortSignal,
): Promise<void> {
  const client = await database.connect();
  try {
    signal.throwIfAborted();
    await client.query("BEGIN");
    try {
      // Server-side limits leave room for awaited rollback before hook expiry.
      await client.query("SET LOCAL statement_timeout = '10s'");
      await client.query("SET LOCAL transaction_timeout = '60s'");
      await client.query(`INSERT INTO meeting_knowledge.question_jobs (
        question_id, requester_subject, question_hash, scope_id,
        final_projection_receipt, authorization_digest, locale, binding_hash,
        state, outcome, terminal_at, scrubbed_at, expires_at
      ) SELECT (78000000000000000::bigint + item)::text, $1, $2, $3, $4, $5,
          'en', $6, 'terminal', 'answered', transaction_timestamp(),
          transaction_timestamp(), transaction_timestamp() + interval '30 minutes'
        FROM generate_series(1, 20000) AS item`,
      ["d".repeat(64), "c".repeat(64), "66666666666666666",
        "discord:v2:channel:22222222222222222:message:44444444444444444",
        "a".repeat(64), "b".repeat(64)]);
      const reservedPayload = '{"content":"not-actionable"}';
      await client.query(`INSERT INTO meeting_core.answer_effects (
        effect_id, authority_scope_id, projection_target_container_id,
        delivery_container_id, reply_to_remote_message_id, marker,
        payload_bytes, payload_hash, binding_hash, authorization_digest,
        source_meeting_ids
      ) SELECT 'meeting-knowledge-answer:v1:' ||
          (78000000000000000::bigint + item)::text,
          $1, $2, $2, (78000000000000000::bigint + item)::text,
          'marker:' || item::text, $3, $4, $5, $6,
          ARRAY['meeting-sparse'] FROM generate_series(1, 20000) AS item`,
      ["66666666666666666", "22222222222222222", reservedPayload,
        createHash("sha256").update(reservedPayload).digest("hex"),
        "b".repeat(64), "a".repeat(64)]);
      await client.query(`INSERT INTO meeting_knowledge.question_jobs (
        question_id, requester_subject, question_hash, scope_id,
        final_projection_receipt, authorization_principal_ref,
        authorization_digest, locale, question_text, binding, binding_hash,
        expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'en', 'Question?', $8, $9,
        transaction_timestamp() + interval '30 minutes')`,
      [active.questionId, active.requesterSubject, active.questionHash, active.scopeId,
        active.finalProjectionReceipt, active.authorizationPrincipalRef,
        active.authorizationDigest, active, questionAdmissionBindingHash(active)]);
      await client.query("ANALYZE meeting_knowledge.question_jobs");
      await client.query("ANALYZE meeting_core.answer_effects");
      signal.throwIfAborted();
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    // Never return a failed or interrupted transaction to the shared pool.
    client.release(true);
  }
}

export function crashRecoveryRows() {
  const rows: Array<{ readonly binding: unknown; readonly bindingHash: string;
    readonly groundingPlan: unknown; readonly questionId: string;
    readonly state: "queued" | "terminal" }> =
    Array.from({ length: 403 }, (_, index) => {
      const questionId = String(77_000_000_000_000_000n + BigInt(index));
      if (index === 350 || index === 400) {
        return { binding: null, bindingHash: "7".repeat(64), groundingPlan: null,
          questionId, state: "terminal" };
      }
      const binding = currentBinding(questionId);
      return { binding, bindingHash: questionAdmissionBindingHash(binding),
        groundingPlan: null, questionId, state: "queued" };
    });
  const old = exactPreCompositeFixture();
  rows.push({ binding: old.binding, bindingHash: old.bindingHash,
    groundingPlan: old.groundingPlan, questionId: "33333333333333333",
    state: "queued" });
  rows.push({ binding: { bindingProtocolVersion: 2, corrupt: true },
    bindingHash: "6".repeat(64), groundingPlan: null,
    questionId: "55555555555555555", state: "queued" });
  return rows;
}

export async function seedCrashRecoveryRows(
  database: Pool,
  serializedRows: ReturnType<typeof serializeQuestionReconciliationFixtureRows>,
): Promise<void> {
  await database.query(`UPDATE meeting_knowledge.question_reconciliation_checkpoints
    SET after_question_id = NULL WHERE checkpoint_key = 'discord-active-questions-v1'`);
  await database.query(
    `INSERT INTO meeting_knowledge.question_jobs (
       question_id, requester_subject, question_hash, scope_id,
       final_projection_receipt, authorization_principal_ref,
       authorization_digest, locale, question_text, binding, binding_hash,
       grounding_plan, state, outcome, terminal_at, scrubbed_at, expires_at
     ) SELECT item.question_id, $2, $3, $4, $5,
         CASE WHEN item.state = 'terminal' THEN NULL ELSE 'principal:restart' END,
         $6, 'en',
         CASE WHEN item.state = 'terminal' THEN NULL ELSE 'Question?' END,
         item.binding, item.binding_hash, item.grounding_plan, item.state,
         CASE WHEN item.state = 'terminal' THEN 'answered' ELSE NULL END,
         CASE WHEN item.state = 'terminal' THEN transaction_timestamp() ELSE NULL END,
         CASE WHEN item.state = 'terminal' THEN transaction_timestamp() ELSE NULL END,
         transaction_timestamp() + interval '30 minutes'
       FROM jsonb_to_recordset($1::jsonb) AS item(
         question_id text, binding jsonb, binding_hash text,
         grounding_plan jsonb, state text
       )`,
    [JSON.stringify(serializedRows), "d".repeat(64), "c".repeat(64),
      "66666666666666666",
      "discord:v2:channel:22222222222222222:message:44444444444444444",
      "a".repeat(64)],
  );
}

export async function seedDeliveredRecoveryEffects(
  database: Pool,
  deliveredIds: readonly string[],
): Promise<void> {
  for (const questionId of deliveredIds) {
    const payload = JSON.stringify({ content: "delivered", message_reference: {
      channel_id: "22222222222222222", message_id: questionId } });
    await database.query(
      `INSERT INTO meeting_core.answer_effects (
         effect_id, state, authority_scope_id,
         projection_target_container_id, delivery_container_id,
         reply_to_remote_message_id, marker, payload_bytes, payload_hash,
         binding_hash, authorization_digest, source_meeting_ids,
         request_started_at, external_receipt, settled_at
       ) VALUES (
         'meeting-knowledge-answer:v1:' || $1, 'delivered', $2, $3, $3,
         $1, 'marker:' || $1, $4, $5, $6, $7,
         ARRAY['meeting-restart'], transaction_timestamp(),
         'discord-receipt:' || $1, transaction_timestamp()
       )`,
      [questionId, "66666666666666666", "22222222222222222", payload,
        createHash("sha256").update(payload).digest("hex"), "7".repeat(64),
        "a".repeat(64)],
    );
  }
}
