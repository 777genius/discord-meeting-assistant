import type {
  AnswerEffectClaim,
  AnswerEffectRecord,
  AnswerEffectReservationInput,
  AnswerEffectState,
  AnswerEffectStore,
  AnswerEffectStoreReservation,
} from "@discord-meeting/meeting-core/publishing";
import { createHash } from "node:crypto";
import type { Pool } from "pg";

interface AnswerEffectRow {
  readonly authorization_digest: string;
  readonly binding_hash: string;
  readonly claim_generation: number;
  readonly delivery_container_id: string | null;
  readonly effect_id: string;
  readonly external_receipt: string | null;
  readonly marker: string;
  readonly payload_bytes: string;
  readonly payload_hash: string;
  readonly projection_target_container_id: string;
  readonly reply_to_remote_message_id: string;
  readonly state: AnswerEffectState;
}

function toRecord(row: AnswerEffectRow): AnswerEffectRecord {
  if (row.delivery_container_id === null) {
    throw new Error("legacy answer effect has no recoverable delivery location and is safely terminal");
  }
  return Object.freeze({
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
    state: row.state,
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalValue(item)]));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function legacyPayloadUpgradesTo(
  row: AnswerEffectRow,
  input: AnswerEffectReservationInput,
): boolean {
  if (row.state !== "reserved" && row.state !== "claimed") {
    return false;
  }
  try {
    const payload = JSON.parse(row.payload_bytes) as Record<string, unknown>;
    const reference = payload.message_reference;
    if (reference === null || typeof reference !== "object" || Array.isArray(reference)) {
      return false;
    }
    const upgraded = {
      ...payload,
      message_reference: {
        ...(reference as Record<string, unknown>),
        channel_id: input.deliveryContainerId,
      },
    };
    return (reference as Record<string, unknown>).channel_id ===
        row.projection_target_container_id &&
      sha256(row.payload_bytes) === row.payload_hash &&
      canonicalJson(upgraded) === input.payloadBytes &&
      sha256(input.payloadBytes) === input.payloadHash;
  } catch {
    return false;
  }
}

function bindingHashMatches(
  row: AnswerEffectRow,
  input: AnswerEffectReservationInput,
): boolean {
  return row.binding_hash === input.bindingHash ||
    input.legacyBindingHash !== undefined && row.binding_hash === input.legacyBindingHash;
}

function immutableFieldsMatch(
  row: AnswerEffectRow,
  input: AnswerEffectReservationInput,
): boolean {
  const payloadMatches = row.payload_bytes === input.payloadBytes ||
    row.payload_bytes === "{}" && (
      row.state === "absent_unconfirmed" ||
      row.state === "cancelled" ||
      row.state === "delivered"
    );
  return row.effect_id === input.effectId &&
    row.delivery_container_id === input.deliveryContainerId &&
    row.projection_target_container_id === input.projectionTargetContainerId &&
    row.reply_to_remote_message_id === input.replyToRemoteMessageId &&
    row.marker === input.marker &&
    payloadMatches &&
    row.payload_hash === input.payloadHash &&
    bindingHashMatches(row, input) &&
    row.authorization_digest === input.authorizationDigest;
}

function legacyPreRequestFieldsMatch(
  row: AnswerEffectRow,
  input: AnswerEffectReservationInput,
): boolean {
  return row.effect_id === input.effectId &&
    row.delivery_container_id === input.deliveryContainerId &&
    row.projection_target_container_id === input.projectionTargetContainerId &&
    row.reply_to_remote_message_id === input.replyToRemoteMessageId &&
    row.marker === input.marker &&
    bindingHashMatches(row, input) &&
    row.authorization_digest === input.authorizationDigest &&
    legacyPayloadUpgradesTo(row, input);
}

export class PostgresAnswerEffectStore implements AnswerEffectStore {
  public constructor(private readonly pool: Pool) {}

  public async reserve(
    input: AnswerEffectReservationInput,
  ): Promise<AnswerEffectStoreReservation> {
    const inserted = await this.pool.query(
      `
        INSERT INTO meeting_core.answer_effects (
          effect_id, projection_target_container_id, delivery_container_id,
          reply_to_remote_message_id, marker, payload_bytes, payload_hash,
          binding_hash, authorization_digest
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (effect_id) DO NOTHING
        RETURNING effect_id
      `,
      [
        input.effectId,
        input.projectionTargetContainerId,
        input.deliveryContainerId,
        input.replyToRemoteMessageId,
        input.marker,
        input.payloadBytes,
        input.payloadHash,
        input.bindingHash,
        input.authorizationDigest,
      ],
    );
    if (inserted.rowCount === 1) {
      return { status: "reserved" };
    }
    let row = await this.findRow(input.effectId);
    if (row === null) {
      return { status: "conflict" };
    }
    if (!immutableFieldsMatch(row, input)) {
      if (!legacyPreRequestFieldsMatch(row, input)) {
        return { status: "conflict" };
      }
      const normalized = await this.pool.query(
        `
          UPDATE meeting_core.answer_effects
          SET payload_bytes = $2,
              payload_hash = $3,
              binding_hash = $4,
              updated_at = transaction_timestamp()
          WHERE effect_id = $1
            AND state IN ('reserved', 'claimed')
            AND payload_hash = $5
            AND binding_hash = $6
        `,
        [
          input.effectId,
          input.payloadBytes,
          input.payloadHash,
          input.bindingHash,
          row.payload_hash,
          row.binding_hash,
        ],
      );
      if (normalized.rowCount !== 1) {
        row = await this.findRow(input.effectId);
        if (row === null || !immutableFieldsMatch(row, input)) {
          return { status: "conflict" };
        }
      } else {
        row = { ...row,
          binding_hash: input.bindingHash,
          payload_bytes: input.payloadBytes,
          payload_hash: input.payloadHash,
        };
      }
    }
    return row.state === "delivered" && row.external_receipt !== null
      ? { externalReceipt: row.external_receipt, status: "delivered" }
      : { status: "existing" };
  }

  public async findById(effectId: string): Promise<AnswerEffectRecord | null> {
    const row = await this.findRow(effectId);
    return row === null ? null : toRecord(row);
  }

  public async claim(effectId: string, workerId: string): Promise<AnswerEffectClaim> {
    const result = await this.pool.query<{ readonly claim_generation: number }>(
      `
        UPDATE meeting_core.answer_effects
        SET state = 'claimed',
            claim_generation = claim_generation + 1,
            claim_owner = $2,
            claim_until = transaction_timestamp() + interval '60 seconds',
            updated_at = transaction_timestamp()
        WHERE effect_id = $1
          AND (
            state = 'reserved' OR
            state = 'claimed' AND claim_until <= transaction_timestamp()
          )
        RETURNING claim_generation::float8 AS claim_generation
      `,
      [effectId, workerId],
    );
    const row = result.rows[0];
    return row === undefined
      ? { status: "not_claimable" }
      : { generation: row.claim_generation, status: "claimed" };
  }

  public async startRequest(input: {
    readonly authorizationDigest: string;
    readonly effectId: string;
    readonly generation: number;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE meeting_core.answer_effects
        SET state = 'request_started',
            request_started_at = transaction_timestamp(),
            claim_until = NULL,
            updated_at = transaction_timestamp()
        WHERE effect_id = $1
          AND state = 'claimed'
          AND claim_generation = $2
          AND authorization_digest = $3
          AND claim_until > transaction_timestamp()
      `,
      [input.effectId, input.generation, input.authorizationDigest],
    );
    return result.rowCount === 1;
  }

  public async complete(input: {
    readonly effectId: string;
    readonly externalReceipt: string;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE meeting_core.answer_effects
        SET state = 'delivered',
            external_receipt = COALESCE(external_receipt, $2),
            payload_bytes = '{}',
            settled_at = COALESCE(settled_at, transaction_timestamp()),
            updated_at = transaction_timestamp()
        WHERE effect_id = $1
          AND state IN ('request_started', 'outcome_unknown', 'delivered')
          AND (external_receipt IS NULL OR external_receipt = $2)
      `,
      [input.effectId, input.externalReceipt],
    );
    return result.rowCount === 1;
  }

  public async markOutcomeUnknown(effectId: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE meeting_core.answer_effects
        SET state = 'outcome_unknown',
            updated_at = transaction_timestamp()
        WHERE effect_id = $1
          AND state IN ('request_started', 'outcome_unknown')
      `,
      [effectId],
    );
    return result.rowCount === 1;
  }

  public async listOutcomeUnknown(limit: number): Promise<readonly AnswerEffectRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("answer effect reconciliation limit must be between 1 and 1000");
    }
    await this.pool.query(
      `
        UPDATE meeting_core.answer_effects
        SET state = 'outcome_unknown',
            updated_at = transaction_timestamp()
        WHERE state = 'request_started'
          AND request_started_at <= transaction_timestamp() - interval '2 minutes'
      `,
    );
    const result = await this.pool.query<AnswerEffectRow>(
      `
        SELECT effect_id, state, projection_target_container_id,
               delivery_container_id,
               reply_to_remote_message_id, marker, payload_bytes, payload_hash,
               binding_hash, authorization_digest,
               claim_generation::float8 AS claim_generation, external_receipt
        FROM meeting_core.answer_effects
        WHERE state = 'outcome_unknown'
        ORDER BY request_started_at, effect_id
        LIMIT $1
      `,
      [limit],
    );
    return Object.freeze(result.rows.map(toRecord));
  }

  public async markAbsentUnconfirmed(effectId: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE meeting_core.answer_effects
        SET state = 'absent_unconfirmed',
            payload_bytes = '{}',
            settled_at = COALESCE(settled_at, transaction_timestamp()),
            updated_at = transaction_timestamp()
        WHERE effect_id = $1
          AND state = 'outcome_unknown'
      `,
      [effectId],
    );
    return result.rowCount === 1;
  }

  public async cancelBeforeRequest(effectId: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE meeting_core.answer_effects
        SET state = 'cancelled',
            payload_bytes = '{}',
            settled_at = COALESCE(settled_at, transaction_timestamp()),
            claim_until = NULL,
            updated_at = transaction_timestamp()
        WHERE effect_id = $1
          AND state IN ('reserved', 'claimed')
      `,
      [effectId],
    );
    return result.rowCount === 1;
  }

  private async findRow(effectId: string): Promise<AnswerEffectRow | null> {
    const result = await this.pool.query<AnswerEffectRow>(
      `
        SELECT effect_id, state, projection_target_container_id,
               delivery_container_id,
               reply_to_remote_message_id, marker, payload_bytes, payload_hash,
               binding_hash, authorization_digest,
               claim_generation::float8 AS claim_generation, external_receipt
        FROM meeting_core.answer_effects
        WHERE effect_id = $1
      `,
      [effectId],
    );
    return result.rows[0] ?? null;
  }
}
