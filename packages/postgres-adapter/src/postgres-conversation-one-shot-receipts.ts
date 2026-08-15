import { createHash, randomUUID } from "node:crypto";

import type { Pool } from "pg";

export interface ConversationOneShotReceiptInput {
  readonly kind: "farewell" | "greeting";
  readonly meetingId: string;
  readonly subjectId: string;
}

interface ReceiptRow {
  readonly state: "completed" | "reserved";
}

export type ConversationOneShotReceiptReservation =
  | { readonly status: "completed" | "in_flight" }
  | { readonly leaseToken: string; readonly status: "reserved" };

/** Durable, opaque at-most-once receipt store used by live composition. */
export class PostgresConversationOneShotReceiptStore {
  public constructor(private readonly pool: Pool) {}

  public async reserve(
    input: ConversationOneShotReceiptInput & { readonly leaseSeconds: number },
  ): Promise<ConversationOneShotReceiptReservation> {
    assertLeaseSeconds(input.leaseSeconds);
    const receiptId = receiptIdentity(input);
    const leaseToken = randomUUID();
    const claimed = await this.pool.query<ReceiptRow & { readonly lease_token: string | null }>(
      `
        INSERT INTO meeting_core.conversation_one_shot_receipts AS receipt (
          receipt_id, cue_kind, state, lease_token, lease_expires_at
        ) VALUES (
          $1, $2, 'reserved', $3,
          transaction_timestamp() + ($4 * interval '1 second')
        )
        ON CONFLICT (receipt_id) DO UPDATE
        SET lease_token = EXCLUDED.lease_token,
            lease_expires_at = EXCLUDED.lease_expires_at
        WHERE receipt.cue_kind = EXCLUDED.cue_kind
          AND receipt.state = 'reserved'
          AND receipt.lease_expires_at <= transaction_timestamp()
        RETURNING state, lease_token
      `,
      [receiptId, input.kind, leaseToken, input.leaseSeconds],
    );
    if (claimed.rows[0]?.state === "reserved" &&
      claimed.rows[0].lease_token === leaseToken) {
      return { leaseToken, status: "reserved" };
    }
    const existing = await this.pool.query<ReceiptRow>(
      `
        SELECT state
        FROM meeting_core.conversation_one_shot_receipts
        WHERE receipt_id = $1 AND cue_kind = $2
      `,
      [receiptId, input.kind],
    );
    const state = existing.rows[0]?.state;
    if (state === "completed") {
      return { status: "completed" };
    }
    if (state === "reserved") {
      return { status: "in_flight" };
    }
    throw new Error("conversation one-shot receipt could not be reconciled");
  }

  public async complete(
    input: ConversationOneShotReceiptInput & { readonly leaseToken: string },
  ): Promise<void> {
    const result = await this.pool.query(
      `
        UPDATE meeting_core.conversation_one_shot_receipts
        SET state = 'completed', completed_at = transaction_timestamp(),
            lease_token = NULL, lease_expires_at = NULL
        WHERE receipt_id = $1 AND cue_kind = $2 AND state = 'reserved'
          AND lease_token = $3
          AND lease_expires_at > transaction_timestamp()
      `,
      [receiptIdentity(input), input.kind, input.leaseToken],
    );
    if (result.rowCount === 1) {
      return;
    }
    const existing = await this.pool.query<ReceiptRow>(
      `
        SELECT state
        FROM meeting_core.conversation_one_shot_receipts
        WHERE receipt_id = $1 AND cue_kind = $2
      `,
      [receiptIdentity(input), input.kind],
    );
    if (existing.rows[0]?.state !== "completed") {
      throw new Error("conversation one-shot receipt completion lost its reservation");
    }
  }

  public async release(
    input: ConversationOneShotReceiptInput & { readonly leaseToken: string },
  ): Promise<void> {
    await this.pool.query(
      `
        DELETE FROM meeting_core.conversation_one_shot_receipts
        WHERE receipt_id = $1 AND cue_kind = $2 AND state = 'reserved'
          AND lease_token = $3
      `,
      [receiptIdentity(input), input.kind, input.leaseToken],
    );
  }
}

function assertLeaseSeconds(value: number): void {
  if (!Number.isSafeInteger(value) || value < 5 || value > 300) {
    throw new RangeError("conversation one-shot receipt lease is outside its bounds");
  }
}

function receiptIdentity(input: ConversationOneShotReceiptInput): string {
  if (
    input.meetingId.length < 1 || input.meetingId.length > 1_024 ||
    input.subjectId.length < 1 || input.subjectId.length > 1_024
  ) {
    throw new RangeError("conversation one-shot receipt identity is outside its bounds");
  }
  return createHash("sha256").update(JSON.stringify({
    kind: input.kind,
    meetingId: input.meetingId,
    schemaVersion: 1,
    subjectId: input.subjectId,
  }), "utf8").digest("hex");
}
