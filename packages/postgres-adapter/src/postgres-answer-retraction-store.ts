import type {
  AnswerEffectRecord,
  AnswerEffectState,
} from "@discord-meeting/meeting-core/publishing";
import type { Pool } from "pg";

interface AnswerRetractionRow {
  readonly authorization_digest: string;
  readonly binding_hash: string;
  readonly claim_generation: number;
  readonly delivery_container_id: string;
  readonly effect_id: string;
  readonly external_receipt: string | null;
  readonly marker: string;
  readonly payload_bytes: string;
  readonly payload_hash: string;
  readonly projection_target_container_id: string;
  readonly reply_to_remote_message_id: string;
  readonly source_meeting_ids: readonly string[];
  readonly state: AnswerEffectState;
}

export async function listAnswerRetractions(
  pool: Pool,
  limit: number,
): Promise<readonly AnswerEffectRecord[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError("answer retraction reconciliation limit must be between 1 and 1000");
  }
  const result = await pool.query<AnswerRetractionRow>(
    `SELECT effect_id, state, projection_target_container_id,
            delivery_container_id, reply_to_remote_message_id, marker,
            payload_bytes, payload_hash, binding_hash, authorization_digest,
            source_meeting_ids,
            claim_generation::float8 AS claim_generation, external_receipt
     FROM meeting_core.answer_effects
     WHERE state = 'retraction_pending'
     ORDER BY updated_at, effect_id
     LIMIT $1`,
    [limit],
  );
  return Object.freeze(result.rows.map((row) => Object.freeze({
    authorizationDigest: row.authorization_digest,
    bindingHash: row.binding_hash,
    claimGeneration: row.claim_generation,
    deliveryContainerId: row.delivery_container_id,
    effectId: row.effect_id,
    externalReceipt: row.external_receipt,
    marker: row.marker,
    payloadBytes: row.payload_bytes,
    payloadHash: row.payload_hash,
    projectionTargetContainerId: row.projection_target_container_id,
    replyToRemoteMessageId: row.reply_to_remote_message_id,
    sourceMeetingIds: Object.freeze([...row.source_meeting_ids]),
    state: row.state,
  })));
}

export async function recordAnswerRetractionReceipt(
  pool: Pool,
  input: { readonly effectId: string; readonly externalReceipt: string },
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE meeting_core.answer_effects
     SET external_receipt = COALESCE(external_receipt, $2),
         updated_at = transaction_timestamp()
     WHERE effect_id = $1 AND state = 'retraction_pending'
       AND (external_receipt IS NULL OR external_receipt = $2)`,
    [input.effectId, input.externalReceipt],
  );
  return result.rowCount === 1;
}

export async function markAnswerRetracted(
  pool: Pool,
  input: { readonly effectId: string; readonly externalReceipt: string },
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE meeting_core.answer_effects
     SET state = 'retracted', payload_bytes = '{}',
         retracted_at = COALESCE(retracted_at, transaction_timestamp()),
         settled_at = COALESCE(settled_at, transaction_timestamp()),
         updated_at = transaction_timestamp()
     WHERE effect_id = $1 AND state IN ('retraction_pending', 'retracted')
       AND external_receipt = $2`,
    [input.effectId, input.externalReceipt],
  );
  return result.rowCount === 1;
}
