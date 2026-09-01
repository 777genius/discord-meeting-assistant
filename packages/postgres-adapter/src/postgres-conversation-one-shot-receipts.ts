import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import {
  assertGreetingCommandPrompt,
  assertLeaseSeconds,
  type ConversationFarewellSettlementInput,
  type ConversationGreetingSettlementInput,
  type ConversationOneShotReceiptInput,
  greetingProviderRecoveryWindowSeconds,
  greetingScopeIdentity,
  maximumGreetingCohortReceiptCount,
  parseRecoveryRemainingMilliseconds,
  type ReceiptRow,
  receiptIdentity,
} from "./postgres-conversation-one-shot-receipt-values.js";

export type ConversationOneShotReceiptReservation =
  | { readonly status: "completed" | "in_flight" }
  | {
      readonly providerCommandId?: string;
      readonly providerCommand?: { readonly locale: "en" | "ru"; readonly prompt: string };
      readonly providerRecoveryRemainingMilliseconds?: number;
      readonly leaseToken: string;
      readonly status: "reserved";
    };

export interface ConversationGreetingCapacityReconciliation {
  readonly commandedSubjectIds: readonly string[];
  readonly suppressedSubjectIds: readonly string[];
  readonly terminalSubjectIds: readonly string[];
}
/** Durable one-shot store. Greeting commands are retriable until provider-attested start. */
export class PostgresConversationOneShotReceiptStore {
  public constructor(private readonly pool: Pool) {}

  // oxlint-disable-next-line complexity
  public async reserve(
    input: ConversationOneShotReceiptInput & {
      readonly leaseSeconds: number;
      readonly reclaimActive?: boolean;
    },
  ): Promise<ConversationOneShotReceiptReservation> {
    assertLeaseSeconds(input.leaseSeconds);
    const receiptId = receiptIdentity(input);
    const providerCommandId = input.kind === "greeting"
      ? `participant-greeting:${receiptId}`
      : null;
    const leaseToken = randomUUID();
    const claimed = await this.pool.query<ReceiptRow>(
      `
        INSERT INTO meeting_core.conversation_one_shot_receipts AS receipt (
          receipt_id, cue_kind, state, lease_token, lease_expires_at, provider_command_id
        ) VALUES (
          $1, $2, 'reserved', $3,
          transaction_timestamp() + ($4 * interval '1 second'), $5
        )
        ON CONFLICT (receipt_id) DO UPDATE
        SET state = CASE
              WHEN receipt.state = 'commanded' AND
                receipt.provider_recovery_expires_at <= transaction_timestamp()
                THEN 'suppressed'
              ELSE receipt.state
            END,
            suppression_reason = CASE
              WHEN receipt.state = 'commanded' AND
                receipt.provider_recovery_expires_at <= transaction_timestamp()
                THEN 'ambiguous'
              ELSE receipt.suppression_reason
            END,
            completed_at = CASE
              WHEN receipt.state = 'commanded' AND
                receipt.provider_recovery_expires_at <= transaction_timestamp()
                THEN transaction_timestamp()
              ELSE receipt.completed_at
            END,
            lease_token = CASE
              WHEN receipt.state = 'commanded' AND
                receipt.provider_recovery_expires_at <= transaction_timestamp()
                THEN NULL
              ELSE EXCLUDED.lease_token
            END,
            lease_expires_at = CASE
              WHEN receipt.state = 'commanded' AND
                receipt.provider_recovery_expires_at <= transaction_timestamp()
                THEN NULL
              ELSE EXCLUDED.lease_expires_at
            END
        WHERE receipt.cue_kind = EXCLUDED.cue_kind
          AND (
            (receipt.state = 'commanded' AND
              receipt.provider_recovery_expires_at <= transaction_timestamp())
            OR (receipt.state IN ('reserved', 'commanded') AND (
              receipt.lease_expires_at <= transaction_timestamp()
              OR ($6 = TRUE AND receipt.cue_kind = 'greeting')
            ))
          )
        RETURNING state, lease_token, suppression_reason, provider_command_id,
          provider_command_locale, provider_command_prompt,
          floor(GREATEST(
            EXTRACT(EPOCH FROM (provider_recovery_expires_at - transaction_timestamp())) * 1000,
            0
          ))::bigint::text AS provider_recovery_remaining_ms
      `,
      [
        receiptId, input.kind, leaseToken, input.leaseSeconds, providerCommandId,
        input.reclaimActive === true,
      ],
    );
    if ((claimed.rows[0]?.state === "reserved" || claimed.rows[0]?.state === "commanded") &&
      claimed.rows[0].lease_token === leaseToken) {
      return {
        ...(claimed.rows[0].provider_command_locale === null ||
          claimed.rows[0].provider_command_prompt === null
          ? {}
          : { providerCommand: {
              locale: claimed.rows[0].provider_command_locale,
              prompt: claimed.rows[0].provider_command_prompt,
            } }),
        ...(claimed.rows[0].provider_command_id === null
          ? {}
          : { providerCommandId: claimed.rows[0].provider_command_id }),
        ...(claimed.rows[0].provider_recovery_remaining_ms === null
          ? {}
          : { providerRecoveryRemainingMilliseconds:
              parseRecoveryRemainingMilliseconds(
                claimed.rows[0].provider_recovery_remaining_ms,
              ) }),
        leaseToken,
        status: "reserved",
      };
    }
    const existing = await this.readReceipt(receiptId, input.kind);
    if (
      existing?.state === "attempted" ||
      existing?.state === "completed" ||
      existing?.state === "played" ||
      existing?.state === "started" ||
      existing?.state === "suppressed"
    ) {
      return { status: "completed" };
    }
    if (existing?.state === "reserved" || existing?.state === "commanded") {
      return { status: "in_flight" };
    }
    throw new Error("conversation one-shot receipt could not be reconciled");
  }

  public async beginGreetingAttempt(
    input: ConversationOneShotReceiptInput & {
      readonly kind: "greeting";
      readonly leaseToken: string;
      readonly locale: "en" | "ru";
      readonly prompt: string;
      readonly providerCommandId: string;
    },
  ): Promise<void> {
    assertGreetingCommandPrompt(input.prompt);
    const receiptId = receiptIdentity(input);
    const result = await this.pool.query(
      `
        UPDATE meeting_core.conversation_one_shot_receipts
        SET state = 'commanded', provider_command_id = $3,
            provider_command_locale = $4, provider_command_prompt = $5,
            provider_recovery_expires_at = transaction_timestamp() +
              (${greetingProviderRecoveryWindowSeconds} * interval '1 second')
        WHERE receipt_id = $1 AND cue_kind = 'greeting' AND state = 'reserved'
          AND lease_token = $2
          AND lease_expires_at > transaction_timestamp()
      `,
      [receiptId, input.leaseToken, input.providerCommandId, input.locale, input.prompt],
    );
    if (result.rowCount === 1) {
      return;
    }
    const existing = await this.readReceipt(receiptId, input.kind);
    if (existing?.state !== "commanded" || existing.lease_token !== input.leaseToken ||
      existing.provider_command_id !== input.providerCommandId ||
      existing.provider_command_locale !== input.locale ||
      existing.provider_command_prompt !== input.prompt) {
      throw new Error("greeting attempt lost its reservation");
    }
  }

  public async beginGreetingCohortAttempt(input: {
    readonly kind: "greeting";
    readonly locale: "en" | "ru";
    readonly meetingId: string;
    readonly prompt: string;
    readonly providerCommandId: string;
    readonly receipts: readonly {
      readonly leaseToken: string;
      readonly subjectId: string;
    }[];
  }): Promise<void> {
    assertGreetingCommandPrompt(input.prompt);
    if (input.receipts.length < 2 ||
      input.receipts.length > maximumGreetingCohortReceiptCount ||
      new Set(input.receipts.map(({ subjectId }) => subjectId)).size !== input.receipts.length) {
      throw new RangeError("greeting cohort receipt batch is invalid");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const receipt of input.receipts) {
        const receiptId = receiptIdentity({
          kind: "greeting",
          meetingId: input.meetingId,
          subjectId: receipt.subjectId,
        });
        const result = await client.query(
          `UPDATE meeting_core.conversation_one_shot_receipts
           SET state = 'commanded', provider_command_id = $3,
               provider_command_locale = $4, provider_command_prompt = $5,
               provider_recovery_expires_at = transaction_timestamp() +
                 (${greetingProviderRecoveryWindowSeconds} * interval '1 second')
           WHERE receipt_id = $1 AND cue_kind = 'greeting' AND state = 'reserved'
             AND lease_token = $2 AND lease_expires_at > transaction_timestamp()`,
          [receiptId, receipt.leaseToken, input.providerCommandId, input.locale, input.prompt],
        );
        if (result.rowCount !== 1) {
          const existing = await client.query<ReceiptRow>(
            `SELECT state, lease_token, suppression_reason, provider_command_id,
               provider_command_locale, provider_command_prompt
             FROM meeting_core.conversation_one_shot_receipts
             WHERE receipt_id = $1 AND cue_kind = 'greeting'`,
            [receiptId],
          );
          const row = existing.rows[0];
          if (row?.state !== "commanded" || row.lease_token !== receipt.leaseToken ||
            row.provider_command_id !== input.providerCommandId ||
            row.provider_command_locale !== input.locale ||
            row.provider_command_prompt !== input.prompt) {
            throw new Error("greeting cohort command lost a reserved member");
          }
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async confirmGreetingStarted(
    input: ConversationOneShotReceiptInput & {
      readonly kind: "greeting";
      readonly leaseToken: string;
      readonly providerCommandId: string;
      readonly startedAtMilliseconds: number;
    },
  ): Promise<void> {
    if (!Number.isSafeInteger(input.startedAtMilliseconds) || input.startedAtMilliseconds < 0) {
      throw new RangeError("greeting provider start timestamp is invalid");
    }
    const receiptId = receiptIdentity(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = await client.query<ReceiptRow>(
        `SELECT state, lease_token, suppression_reason, provider_command_id,
           provider_command_locale, provider_command_prompt
         FROM meeting_core.conversation_one_shot_receipts
         WHERE receipt_id = $1 AND cue_kind = 'greeting' FOR UPDATE`,
        [receiptId],
      );
      const row = owner.rows[0];
      if (row?.provider_command_id !== input.providerCommandId ||
        (row.state === "commanded" && row.lease_token !== input.leaseToken) ||
        (row.state !== "commanded" && row.state !== "started")) {
        throw new Error("greeting start attestation lost its commanded attempt");
      }
      await client.query(
        `UPDATE meeting_core.conversation_one_shot_receipts
         SET state = 'started', provider_started_at = to_timestamp($2 / 1000.0),
             lease_expires_at = NULL
         WHERE cue_kind = 'greeting' AND provider_command_id = $1
           AND state = 'commanded'`,
        [input.providerCommandId, input.startedAtMilliseconds],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async confirmGreetingCohortStarted(
    input: {
      readonly kind: "greeting";
      readonly meetingId: string;
      readonly providerCommandId: string;
      readonly receipts: readonly {
        readonly leaseToken: string;
        readonly subjectId: string;
      }[];
      readonly startedAtMilliseconds: number;
    },
  ): Promise<void> {
    if (!Number.isSafeInteger(input.startedAtMilliseconds) || input.startedAtMilliseconds < 0) {
      throw new RangeError("greeting provider start timestamp is invalid");
    }
    if (input.receipts.length < 2 ||
      input.receipts.length > maximumGreetingCohortReceiptCount ||
      new Set(input.receipts.map(({ subjectId }) => subjectId)).size !== input.receipts.length) {
      throw new RangeError("greeting cohort receipt batch is invalid");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const receipt of input.receipts) {
        const receiptId = receiptIdentity({
          kind: "greeting",
          meetingId: input.meetingId,
          subjectId: receipt.subjectId,
        });
        const result = await client.query(
          `UPDATE meeting_core.conversation_one_shot_receipts
           SET state = 'started', provider_started_at = to_timestamp($4 / 1000.0),
               lease_expires_at = NULL
           WHERE receipt_id = $1 AND cue_kind = 'greeting' AND state = 'commanded'
             AND lease_token = $2 AND provider_command_id = $3`,
          [receiptId, receipt.leaseToken, input.providerCommandId, input.startedAtMilliseconds],
        );
        if (result.rowCount !== 1) {
          const existing = await client.query<ReceiptRow>(
            `SELECT state, lease_token, suppression_reason, provider_command_id
             FROM meeting_core.conversation_one_shot_receipts
             WHERE receipt_id = $1 AND cue_kind = 'greeting'`,
            [receiptId],
          );
          if (existing.rows[0]?.state !== "started" ||
            existing.rows[0].provider_command_id !== input.providerCommandId) {
            throw new Error("greeting cohort start attestation lost a commanded member");
          }
        }
      }
      await client.query(
        `UPDATE meeting_core.conversation_one_shot_receipts
         SET state = 'started', provider_started_at = to_timestamp($2 / 1000.0),
             lease_expires_at = NULL
         WHERE cue_kind = 'greeting' AND provider_command_id = $1
           AND state = 'commanded'`,
        [input.providerCommandId, input.startedAtMilliseconds],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async beginFarewellAttempt(
    input: ConversationOneShotReceiptInput & {
      readonly kind: "farewell";
      readonly leaseToken: string;
    },
  ): Promise<void> {
    await this.beginAttempt(input);
  }

  public async complete(
    input: ConversationOneShotReceiptInput & {
      readonly kind: "farewell";
      readonly leaseToken: string;
    },
  ): Promise<void> {
    const result = await this.pool.query(
      `
        UPDATE meeting_core.conversation_one_shot_receipts
        SET state = 'completed', completed_at = transaction_timestamp(),
            lease_token = NULL, lease_expires_at = NULL
        WHERE receipt_id = $1 AND cue_kind = 'farewell' AND state = 'reserved'
          AND lease_token = $2
          AND lease_expires_at > transaction_timestamp()
      `,
      [receiptIdentity(input), input.leaseToken],
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
        WITH owned AS (
          SELECT provider_command_id, state
          FROM meeting_core.conversation_one_shot_receipts
          WHERE receipt_id = $1 AND cue_kind = 'greeting' AND lease_token = $2
            AND (
              (state = 'started' AND $3 IN ('played', 'suppressed'))
              OR (state = 'commanded' AND $3 = 'suppressed')
              OR (state = 'reserved' AND $3 = 'suppressed' AND $4 IN ('stale', 'capacity'))
            )
        )
        UPDATE meeting_core.conversation_one_shot_receipts AS receipt
        SET state = $3, suppression_reason = $4,
            completed_at = transaction_timestamp(),
            lease_token = NULL, lease_expires_at = NULL
        FROM owned
        WHERE receipt.cue_kind = 'greeting' AND (
          (owned.state IN ('commanded', 'started') AND
            receipt.provider_command_id = owned.provider_command_id AND
            receipt.state = owned.state) OR
          (owned.state = 'reserved' AND receipt.receipt_id = $1 AND
            receipt.lease_token = $2)
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

  public async reconcileGreetingCapacity(input: {
    readonly capacity: number;
    readonly kind: "greeting";
    readonly meetingId: string;
    readonly orderedSubjectIds: readonly string[];
  }): Promise<ConversationGreetingCapacityReconciliation> {
    if (!Number.isSafeInteger(input.capacity) || input.capacity < 1 ||
      input.capacity > maximumGreetingCohortReceiptCount ||
      input.orderedSubjectIds.length > 256 ||
      new Set(input.orderedSubjectIds).size !== input.orderedSubjectIds.length) {
      throw new RangeError("greeting capacity reconciliation batch is invalid");
    }
    const scopeId = greetingScopeIdentity(input.meetingId);
    const commandedSubjectIds: string[] = [];
    const suppressedSubjectIds: string[] = [];
    const terminalSubjectIds: string[] = [];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [scopeId],
      );
      const admitted = await client.query<{ readonly receipt_id: string }>(
        `SELECT receipt_id
         FROM meeting_core.conversation_greeting_capacity_admissions
         WHERE scope_id = $1 FOR UPDATE`,
        [scopeId],
      );
      const admittedReceiptIds = new Set(admitted.rows.map(({ receipt_id }) => receipt_id));
      for (const subjectId of input.orderedSubjectIds) {
        const receiptId = receiptIdentity({
          kind: "greeting",
          meetingId: input.meetingId,
          subjectId,
        });
        const existing = await client.query<ReceiptRow>(
          `SELECT state, lease_token, suppression_reason, provider_command_id,
             provider_command_locale, provider_command_prompt
           FROM meeting_core.conversation_one_shot_receipts
           WHERE receipt_id = $1 AND cue_kind = 'greeting' FOR UPDATE`,
          [receiptId],
        );
        const row = existing.rows[0];
        if (row?.state === "commanded") {
          commandedSubjectIds.push(subjectId);
          continue;
        }
        if (row !== undefined && row.state !== "reserved") {
          if (row.state === "suppressed" && row.suppression_reason === "capacity") {
            suppressedSubjectIds.push(subjectId);
          } else {
            terminalSubjectIds.push(subjectId);
          }
          continue;
        }
        if (admittedReceiptIds.has(receiptId)) {
          continue;
        }
        if (admittedReceiptIds.size < input.capacity) {
          const admission = await client.query(
            `INSERT INTO meeting_core.conversation_greeting_capacity_admissions (
               scope_id, receipt_id
             ) VALUES ($1, $2)
             ON CONFLICT (receipt_id) DO NOTHING`,
            [scopeId, receiptId],
          );
          if (admission.rowCount !== 1) {
            throw new Error("greeting capacity admission identity conflicted");
          }
          admittedReceiptIds.add(receiptId);
          continue;
        }
        const providerCommandId = `participant-greeting:${receiptId}`;
        const result = row === undefined
          ? await client.query(
              `INSERT INTO meeting_core.conversation_one_shot_receipts (
                 receipt_id, cue_kind, state, completed_at, suppression_reason,
                 provider_command_id
               ) VALUES (
                 $1, 'greeting', 'suppressed', transaction_timestamp(), 'capacity', $2
               )`,
              [receiptId, providerCommandId],
            )
          : await client.query(
              `UPDATE meeting_core.conversation_one_shot_receipts
               SET state = 'suppressed', completed_at = transaction_timestamp(),
                   suppression_reason = 'capacity', lease_token = NULL,
                   lease_expires_at = NULL
               WHERE receipt_id = $1 AND cue_kind = 'greeting' AND state = 'reserved'`,
              [receiptId],
            );
        if (result.rowCount !== 1) {
          throw new Error("greeting capacity reconciliation lost a due receipt");
        }
        suppressedSubjectIds.push(subjectId);
      }
      await client.query("COMMIT");
      return { commandedSubjectIds, suppressedSubjectIds, terminalSubjectIds };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async settleFarewell(input: ConversationFarewellSettlementInput): Promise<void> {
    assertFarewellSettlement(input);
    const receiptId = receiptIdentity(input);
    const state = input.outcome === "played" ? "played" : "suppressed";
    const result = await this.pool.query(
      `
        UPDATE meeting_core.conversation_one_shot_receipts
        SET state = $3, suppression_reason = $4,
            completed_at = transaction_timestamp(),
            lease_token = NULL, lease_expires_at = NULL
        WHERE receipt_id = $1 AND cue_kind = 'farewell' AND lease_token = $2
          AND state = 'attempted'
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
      throw new Error("farewell settlement lost its fenced attempt");
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
        "AND state = 'commanded'",
      [receiptIdentity(input), input.leaseToken],
    );
  }

  public async releaseFarewellAttempt(
    input: ConversationOneShotReceiptInput & {
      readonly evidence: "busy" | "unplayed";
      readonly kind: "farewell";
      readonly leaseToken: string;
    },
  ): Promise<void> {
    await this.releaseAttempt(input);
  }

  private async beginAttempt(
    input: ConversationOneShotReceiptInput & { readonly leaseToken: string },
  ): Promise<void> {
    const receiptId = receiptIdentity(input);
    const result = await this.pool.query(
      `
        UPDATE meeting_core.conversation_one_shot_receipts
        SET state = 'attempted', lease_expires_at = NULL
        WHERE receipt_id = $1 AND cue_kind = $2 AND state = 'reserved'
          AND lease_token = $3
          AND lease_expires_at > transaction_timestamp()
      `,
      [receiptId, input.kind, input.leaseToken],
    );
    if (result.rowCount === 1) {
      return;
    }
    const existing = await this.readReceipt(receiptId, input.kind);
    if (existing?.state !== "attempted" || existing.lease_token !== input.leaseToken) {
      throw new Error(`${input.kind} attempt lost its reservation`);
    }
  }

  private async releaseAttempt(
    input: ConversationOneShotReceiptInput & { readonly leaseToken: string },
  ): Promise<void> {
    await this.pool.query(
      `
        DELETE FROM meeting_core.conversation_one_shot_receipts
        WHERE receipt_id = $1 AND cue_kind = $2 AND lease_token = $3
          AND state = 'attempted'
      `,
      [receiptIdentity(input), input.kind, input.leaseToken],
    );
  }

  private async readReceipt(
    receiptId: string,
    kind: ConversationOneShotReceiptInput["kind"],
  ): Promise<ReceiptRow | undefined> {
    const existing = await this.pool.query<ReceiptRow>(
      `
        SELECT state, lease_token, suppression_reason, provider_command_id,
          provider_command_locale, provider_command_prompt
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

function assertFarewellSettlement(input: ConversationFarewellSettlementInput): void {
  if (
    (input.outcome === "played" && input.reason !== undefined) ||
    (input.outcome === "suppressed" && input.reason !== "ambiguous")
  ) {
    throw new Error("farewell settlement outcome and reason are inconsistent");
  }
}
