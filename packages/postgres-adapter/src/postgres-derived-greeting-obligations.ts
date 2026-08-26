import type { Pool } from "pg";

import {
  greetingScopeIdentity,
  receiptIdentity,
} from "./postgres-conversation-one-shot-receipt-values.js";

export interface DerivedGreetingObligation {
  readonly eventId: string;
  readonly memoryHumanObservation?: {
    readonly actorId: string;
    readonly producerRevision: string;
  };
  readonly notAfterMilliseconds: number;
  readonly occurredAt: string;
  readonly participantId: string;
  readonly recordingId: string;
}

interface ObligationRow {
  readonly event_id: string;
  readonly memory_actor_id: string | null;
  readonly memory_producer_revision: string | null;
  readonly not_after_ms: string;
  readonly occurred_at: Date;
  readonly participant_id: string;
  readonly recording_id: string;
}

/** Durable derived-effect ledger; replay is safe because greeting receipts own audible idempotency. */
export class PostgresDerivedGreetingObligationStore {
  public constructor(private readonly pool: Pool) {}

  public async accept(input: DerivedGreetingObligation): Promise<void> {
    assertObligation(input);
    const result = await this.pool.query(
      `INSERT INTO meeting_core.derived_greeting_obligations (
         event_id, recording_id, participant_id, occurred_at, not_after,
         memory_actor_id, memory_producer_revision
       ) VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0), $6, $7)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        input.eventId,
        input.recordingId,
        input.participantId,
        input.occurredAt,
        input.notAfterMilliseconds,
        input.memoryHumanObservation?.actorId ?? null,
        input.memoryHumanObservation?.producerRevision ?? null,
      ],
    );
    if (result.rowCount === 1) {
      return;
    }
    const existing = await this.pool.query<ObligationRow>(
      `SELECT event_id, recording_id, participant_id, occurred_at,
         floor(EXTRACT(EPOCH FROM not_after) * 1000)::bigint::text AS not_after_ms,
         memory_actor_id, memory_producer_revision
       FROM meeting_core.derived_greeting_obligations WHERE event_id = $1`,
      [input.eventId],
    );
    if (!sameObligation(existing.rows[0], input)) {
      throw new Error("derived greeting obligation identity conflicted");
    }
  }

  public async listPending(limit = 100): Promise<readonly DerivedGreetingObligation[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("derived greeting obligation limit is invalid");
    }
    const result = await this.pool.query<ObligationRow>(
      `SELECT event_id, recording_id, participant_id, occurred_at,
         floor(EXTRACT(EPOCH FROM not_after) * 1000)::bigint::text AS not_after_ms,
         memory_actor_id, memory_producer_revision
       FROM meeting_core.derived_greeting_obligations
       WHERE state = 'pending'
       ORDER BY occurred_at, event_id
       LIMIT $1`,
      [limit],
    );
    return Object.freeze(result.rows.map(toObligation));
  }

  public async markDelivered(eventId: string): Promise<void> {
    await this.markTerminal(eventId, "delivered");
  }

  public async markExpired(eventId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const obligation = await client.query<{
        readonly participant_id: string;
        readonly recording_id: string;
        readonly state: string;
      }>(
        `SELECT recording_id, participant_id, state
         FROM meeting_core.derived_greeting_obligations
         WHERE event_id = $1 FOR UPDATE`,
        [eventId],
      );
      const row = obligation.rows[0];
      if (row === undefined) {
        throw new Error("derived greeting obligation does not exist");
      }
      if (row.state === "expired" || row.state === "delivered") {
        await client.query("COMMIT");
        return;
      }
      if (row.state !== "pending") {
        throw new Error("derived greeting obligation lost its expiry transition");
      }
      const receiptId = receiptIdentity({
        kind: "greeting",
        meetingId: row.recording_id,
        subjectId: row.participant_id,
      });
      await client.query(
        `INSERT INTO meeting_core.conversation_one_shot_receipts (
           receipt_id, cue_kind, state, suppression_reason, completed_at,
           provider_command_id
         ) VALUES ($1, 'greeting', 'suppressed', 'stale',
           transaction_timestamp(), $2)
         ON CONFLICT (receipt_id) DO UPDATE
         SET state = 'suppressed', suppression_reason = 'stale',
             completed_at = transaction_timestamp(), lease_token = NULL,
             lease_expires_at = NULL
         WHERE conversation_one_shot_receipts.cue_kind = 'greeting'
           AND conversation_one_shot_receipts.state IN ('reserved', 'commanded')`,
        [receiptId, `participant-greeting:${receiptId}`],
      );
      await client.query(
        `UPDATE meeting_core.derived_greeting_obligations
         SET state = 'expired', terminal_at = transaction_timestamp()
         WHERE event_id = $1 AND state = 'pending'`,
        [eventId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Purges only ended-meeting operational rows; provider-start receipts remain evidence. */
  public async purgeTerminal(input: {
    readonly limit: number;
    readonly terminalBeforeMilliseconds: number;
  }): Promise<{
    readonly capacityAdmissionsDeleted: number;
    readonly meetingsProcessed: number;
    readonly obligationsDeleted: number;
  }> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000 ||
      !Number.isSafeInteger(input.terminalBeforeMilliseconds) ||
      input.terminalBeforeMilliseconds < 0) {
      throw new RangeError("derived greeting terminal retention input is invalid");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const meetings = await client.query<{ readonly meeting_id: string }>(
        `SELECT meeting_id
         FROM meeting_core.live_meetings
         WHERE snapshot ->> 'status' = 'ended'
           AND updated_at < to_timestamp($1 / 1000.0)
           AND NOT EXISTS (
             SELECT 1
             FROM meeting_core.derived_greeting_obligations AS pending
             WHERE pending.recording_id = live_meetings.meeting_id
               AND pending.state = 'pending'
           )
         ORDER BY updated_at, meeting_id
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [input.terminalBeforeMilliseconds, input.limit],
      );
      const meetingIds = meetings.rows.map(({ meeting_id }) => meeting_id);
      if (meetingIds.length === 0) {
        await client.query("COMMIT");
        return {
          capacityAdmissionsDeleted: 0,
          meetingsProcessed: 0,
          obligationsDeleted: 0,
        };
      }
      const scopeIds = meetingIds.map(greetingScopeIdentity);
      const admissions = await client.query(
        `DELETE FROM meeting_core.conversation_greeting_capacity_admissions AS admission
         WHERE admission.scope_id = ANY($1::text[])
           AND NOT EXISTS (
             SELECT 1
             FROM meeting_core.conversation_greeting_capacity_admissions AS scoped
             LEFT JOIN meeting_core.conversation_one_shot_receipts AS receipt
               ON receipt.receipt_id = scoped.receipt_id
             WHERE scoped.scope_id = admission.scope_id
               AND (receipt.receipt_id IS NULL OR
                 receipt.state NOT IN ('played', 'suppressed'))
           )`,
        [scopeIds],
      );
      const obligations = await client.query(
        `DELETE FROM meeting_core.derived_greeting_obligations
         WHERE recording_id = ANY($1::text[])
           AND state IN ('delivered', 'expired')
           AND terminal_at < to_timestamp($2 / 1000.0)`,
        [meetingIds, input.terminalBeforeMilliseconds],
      );
      await client.query("COMMIT");
      return {
        capacityAdmissionsDeleted: admissions.rowCount ?? 0,
        meetingsProcessed: meetingIds.length,
        obligationsDeleted: obligations.rowCount ?? 0,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async markTerminal(eventId: string, state: "delivered" | "expired"): Promise<void> {
    const result = await this.pool.query(
      `UPDATE meeting_core.derived_greeting_obligations
       SET state = $2, terminal_at = transaction_timestamp()
       WHERE event_id = $1 AND state = 'pending'`,
      [eventId, state],
    );
    if (result.rowCount === 1) {
      return;
    }
    const existing = await this.pool.query<{ readonly state: string }>(
      `SELECT state FROM meeting_core.derived_greeting_obligations WHERE event_id = $1`,
      [eventId],
    );
    if (existing.rows[0]?.state !== state &&
      existing.rows[0]?.state !== "delivered" && existing.rows[0]?.state !== "expired") {
      throw new Error("derived greeting obligation lost its terminal transition");
    }
  }
}

function assertObligation(input: DerivedGreetingObligation): void {
  const occurredAtMilliseconds = Date.parse(input.occurredAt);
  if (input.eventId.length < 1 || input.eventId.length > 256 ||
    input.recordingId.length < 1 || input.recordingId.length > 256 ||
    input.participantId.length < 1 || input.participantId.length > 256 ||
    !Number.isSafeInteger(occurredAtMilliseconds) || occurredAtMilliseconds < 0 ||
    input.notAfterMilliseconds !== occurredAtMilliseconds + 5_000) {
    throw new RangeError("derived greeting obligation is invalid");
  }
}

function toObligation(row: ObligationRow): DerivedGreetingObligation {
  return Object.freeze({
    eventId: row.event_id,
    ...(row.memory_actor_id === null || row.memory_producer_revision === null
      ? {}
      : { memoryHumanObservation: Object.freeze({
          actorId: row.memory_actor_id,
          producerRevision: row.memory_producer_revision,
        }) }),
    notAfterMilliseconds: Number.parseInt(row.not_after_ms, 10),
    occurredAt: row.occurred_at.toISOString(),
    participantId: row.participant_id,
    recordingId: row.recording_id,
  });
}

function sameObligation(
  row: ObligationRow | undefined,
  input: DerivedGreetingObligation,
): boolean {
  return row !== undefined && row.recording_id === input.recordingId &&
    row.participant_id === input.participantId &&
    row.occurred_at.getTime() === Date.parse(input.occurredAt) &&
    Number.parseInt(row.not_after_ms, 10) === input.notAfterMilliseconds &&
    row.memory_actor_id === (input.memoryHumanObservation?.actorId ?? null) &&
    row.memory_producer_revision ===
      (input.memoryHumanObservation?.producerRevision ?? null);
}
