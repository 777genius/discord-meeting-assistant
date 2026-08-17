import { createHash, randomUUID } from "node:crypto";

import type { Pool } from "pg";

export interface ConversationOneShotReceiptInput {
  readonly kind: "farewell" | "greeting";
  readonly meetingId: string;
  readonly subjectId: string;
}

interface ReceiptRow {
  readonly lease_token: string | null;
  readonly state: "attempted" | "completed" | "played" | "reserved" | "suppressed";
  readonly suppression_reason: "ambiguous" | "stale" | null;
}

export type ConversationOneShotReceiptReservation =
  | { readonly status: "completed" | "in_flight" }
  | { readonly leaseToken: string; readonly status: "reserved" };

export interface ConversationGreetingSettlementInput extends ConversationOneShotReceiptInput {
  readonly kind: "greeting";
  readonly leaseToken: string;
  readonly outcome: "played" | "suppressed";
  readonly reason?: "ambiguous" | "stale";
}

/** Durable, opaque at-most-once receipt store used by live composition. */
export class PostgresConversationOneShotReceiptStore {
  public constructor(private readonly pool: Pool) {}

  public async reserve(
    input: ConversationOneShotReceiptInput & { readonly leaseSeconds: number },
  ): Promise<ConversationOneShotReceiptReservation> {
    assertLeaseSeconds(input.leaseSeconds);
    const receiptId = receiptIdentity(input);
    const leaseToken = randomUUID();
    const claimed = await this.pool.query<ReceiptRow>(
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
        RETURNING state, lease_token, suppression_reason
      `,
      [receiptId, input.kind, leaseToken, input.leaseSeconds],
    );
    if (claimed.rows[0]?.state === "reserved" &&
      claimed.rows[0].lease_token === leaseToken) {
      return { leaseToken, status: "reserved" };
    }
    const existing = await this.readReceipt(receiptId, input.kind);
    if (
      existing?.state === "attempted" ||
      existing?.state === "completed" ||
      existing?.state === "played" ||
      existing?.state === "suppressed"
    ) {
      return { status: "completed" };
    }
    if (existing?.state === "reserved") {
      return { status: "in_flight" };
    }
    throw new Error("conversation one-shot receipt could not be reconciled");
  }

  public async beginGreetingAttempt(
    input: ConversationOneShotReceiptInput & {
      readonly kind: "greeting";
      readonly leaseToken: string;
    },
  ): Promise<void> {
    const receiptId = receiptIdentity(input);
    const result = await this.pool.query(
      `
        UPDATE meeting_core.conversation_one_shot_receipts
        SET state = 'attempted', lease_expires_at = NULL
        WHERE receipt_id = $1 AND cue_kind = 'greeting' AND state = 'reserved'
          AND lease_token = $2
          AND lease_expires_at > transaction_timestamp()
      `,
      [receiptId, input.leaseToken],
    );
    if (result.rowCount === 1) {
      return;
    }
    const existing = await this.readReceipt(receiptId, input.kind);
    if (existing?.state !== "attempted" || existing.lease_token !== input.leaseToken) {
      throw new Error("greeting attempt lost its reservation");
    }
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
    const existing = await this.readReceipt(receiptIdentity(input), input.kind);
    if (existing?.state !== "completed") {
      throw new Error("conversation one-shot receipt completion lost its reservation");
    }
  }

  public async settleGreeting(input: ConversationGreetingSettlementInput): Promise<void> {
    assertGreetingSettlement(input);
    const receiptId = receiptIdentity(input);
    const state = input.outcome === "played" ? "played" : "suppressed";
    const result = await this.pool.query(
      `
        UPDATE meeting_core.conversation_one_shot_receipts
        SET state = $3, suppression_reason = $4,
            completed_at = transaction_timestamp(),
            lease_token = NULL, lease_expires_at = NULL
        WHERE receipt_id = $1 AND cue_kind = 'greeting' AND lease_token = $2
          AND (
            state = 'attempted'
            OR (state = 'reserved' AND $3 = 'suppressed' AND $4 = 'stale')
          )
      `,
      [
        receiptId,
        input.leaseToken,
        state,
        input.outcome === "suppressed" ? input.reason : null,
      ],
    );
    if (result.rowCount === 1) {
      return;
    }
    const existing = await this.readReceipt(receiptId, input.kind);
    if (
      existing?.state !== state ||
      existing.suppression_reason !==
        (input.outcome === "suppressed" ? input.reason : null)
    ) {
      throw new Error("greeting settlement lost its fenced attempt");
    }
  }

  public async release(
    input: ConversationOneShotReceiptInput & { readonly leaseToken: string },
  ): Promise<void> {
    await this.pool.query(
      `
        DELETE FROM meeting_core.conversation_one_shot_receipts
        WHERE receipt_id = $1 AND cue_kind = $2 AND lease_token = $3
          AND state = 'reserved'
      `,
      [receiptIdentity(input), input.kind, input.leaseToken],
    );
  }

  public async releaseGreetingAttempt(
    input: ConversationOneShotReceiptInput & {
      readonly evidence: "busy" | "unplayed";
      readonly kind: "greeting";
      readonly leaseToken: string;
    },
  ): Promise<void> {
    await this.pool.query(
      "DELETE FROM meeting_core.conversation_one_shot_receipts " +
        "WHERE receipt_id = $1 AND cue_kind = 'greeting' AND lease_token = $2 " +
        "AND state = 'attempted'",
      [receiptIdentity(input), input.leaseToken],
    );
  }

  private async readReceipt(
    receiptId: string,
    kind: ConversationOneShotReceiptInput["kind"],
  ): Promise<ReceiptRow | undefined> {
    const existing = await this.pool.query<ReceiptRow>(
      `
        SELECT state, lease_token, suppression_reason
        FROM meeting_core.conversation_one_shot_receipts
        WHERE receipt_id = $1 AND cue_kind = $2
      `,
      [receiptId, kind],
    );
    return existing.rows[0];
  }
}

function assertGreetingSettlement(input: ConversationGreetingSettlementInput): void {
  if (
    (input.outcome === "played" && input.reason !== undefined) ||
    (input.outcome === "suppressed" && input.reason === undefined)
  ) {
    throw new Error("greeting settlement outcome and reason are inconsistent");
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
