import type {
  CanonicalEvidenceTurn,
  HistoricalOpaqueIdPort,
  LiveFinalizedMemoryLeaseV1,
  LiveFinalizedMemoryProjectionV1,
  LiveFinalizedMemorySyncStore,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { Pool, PoolClient } from "pg";

import { applyLiveFinalizedMemory } from "./postgres-live-finalized-memory-apply.js";

interface LeaseRow {
  readonly attempt_count: number;
  readonly enqueued_at_ms: number;
  readonly identity_generation: number;
  readonly lease_fence: number;
  readonly meeting_id: string;
  readonly mutation_id: string;
  readonly operation: "delete" | "upsert";
  readonly requires_reconciliation: boolean;
  readonly source_generation: number;
  readonly turn_hash: string;
  readonly turn_id: string;
}

interface ProjectionRow {
  readonly identity_generation: number;
  readonly meeting_id: string;
  readonly mutation_id: string;
  readonly room_id: string;
  readonly scope_id: string;
  readonly source_generation: number;
  readonly turn: CanonicalEvidenceTurn;
  readonly turn_hash: string;
}

interface StoredTurnRow {
  readonly turn: CanonicalEvidenceTurn;
}


function leaseFromRow(row: LeaseRow): LiveFinalizedMemoryLeaseV1 {
  return Object.freeze({
    attempt: row.attempt_count,
    enqueuedAtMs: row.enqueued_at_ms,
    fence: row.lease_fence,
    identityGeneration: row.identity_generation,
    meetingId: row.meeting_id,
    mutationId: row.mutation_id,
    operation: row.operation,
    requiresReconciliation: row.requires_reconciliation,
    sourceGeneration: row.source_generation,
    turnHash: row.turn_hash,
    turnId: row.turn_id,
  });
}


function validateLeaseDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 300_000) {
    throw new RangeError("live memory lease duration is outside its bounds");
  }
}

export class PostgresLiveFinalizedMemoryStore
  implements LiveFinalizedMemorySyncStore
{
  public constructor(
    private readonly pool: Pool,
    private readonly ids?: HistoricalOpaqueIdPort,
  ) {}

  public async claimNext(input: {
    readonly leaseDurationMs: number;
    readonly meetingId?: string;
  }): Promise<LiveFinalizedMemoryLeaseV1 | null> {
    validateLeaseDuration(input.leaseDurationMs);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{
        readonly mutation_id: string;
        readonly state: string;
      }>(
        `
          SELECT candidate.mutation_id, candidate.state
          FROM meeting_knowledge.live_memory_outbox AS candidate
          WHERE candidate.state IN (
            'pending', 'in_flight', 'retry_wait', 'outcome_unknown',
            'retire_pending', 'retire_in_flight', 'retire_outcome_unknown'
          )
            AND ($1::text IS NULL OR candidate.meeting_id = $1)
            AND (candidate.retry_after IS NULL OR
                 candidate.retry_after <= transaction_timestamp())
            AND (candidate.state NOT IN ('in_flight', 'retire_in_flight') OR
                 candidate.lease_expires_at <= transaction_timestamp())
            AND (candidate.state LIKE 'retire_%' OR NOT EXISTS (
              SELECT 1
              FROM meeting_knowledge.live_memory_outbox AS prior
              WHERE prior.meeting_id = candidate.meeting_id
                AND prior.source_generation < candidate.source_generation
                AND prior.state <> 'applied'
            ))
          ORDER BY candidate.created_at,
                   candidate.meeting_id,
                   candidate.source_generation
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `,
        [input.meetingId ?? null],
      );
      const selectedRow = selected.rows[0];
      const mutationId = selectedRow?.mutation_id;
      if (mutationId === undefined) {
        await client.query("COMMIT");
        return null;
      }
      const updated = await client.query<LeaseRow>(
        `
          UPDATE meeting_knowledge.live_memory_outbox AS outbox
          SET state = CASE WHEN $4::boolean THEN 'retire_in_flight' ELSE 'in_flight' END,
              attempt_count = attempt_count + 1,
              lease_fence = lease_fence + 1,
              lease_expires_at = transaction_timestamp() +
                ($2::double precision * interval '1 millisecond'),
              retry_after = NULL,
              updated_at = transaction_timestamp()
          WHERE outbox.mutation_id = $1
          RETURNING mutation_id, meeting_id, turn_id,
                    source_generation::float8 AS source_generation,
                    identity_generation::float8 AS identity_generation,
                    turn_hash, attempt_count,
                    lease_fence::float8 AS lease_fence,
                    (extract(epoch FROM created_at) * 1000)::float8 AS enqueued_at_ms,
                    $3::boolean AS requires_reconciliation,
                    CASE WHEN $4::boolean THEN 'delete' ELSE 'upsert' END AS operation
        `,
        [
          mutationId,
          input.leaseDurationMs,
          selectedRow?.state === "in_flight" ||
            selectedRow?.state === "outcome_unknown" ||
            selectedRow?.state === "retire_in_flight" ||
            selectedRow?.state === "retire_outcome_unknown",
          selectedRow?.state.startsWith("retire_"),
        ],
      );
      await client.query("COMMIT");
      const row = updated.rows[0];
      if (row === undefined) {
        throw new Error("live memory claim disappeared");
      }
      return leaseFromRow(row);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async loadCanonicalTurn(
    lease: LiveFinalizedMemoryLeaseV1,
  ): Promise<CanonicalEvidenceTurn | null> {
    const result = await this.pool.query<StoredTurnRow>(
      `
        SELECT turn.turn
        FROM meeting_knowledge.live_memory_outbox AS outbox
        JOIN meeting_core.live_meeting_turns AS turn
          ON turn.meeting_id = outbox.meeting_id
         AND turn.turn_id = outbox.turn_id
        WHERE outbox.mutation_id = $1
          AND outbox.lease_fence = $2
          AND outbox.state IN ('in_flight', 'retire_in_flight')
      `,
      [lease.mutationId, lease.fence],
    );
    return result.rows[0]?.turn ?? null;
  }

  public async loadProjection(
    lease: LiveFinalizedMemoryLeaseV1,
  ): Promise<LiveFinalizedMemoryProjectionV1 | null> {
    const result = await this.pool.query<ProjectionRow>(
      `
        SELECT outbox.mutation_id, outbox.meeting_id, outbox.turn_hash,
               outbox.identity_generation::float8 AS identity_generation,
               outbox.source_generation::float8 AS source_generation,
               memory.scope_id, memory.room_id, turn.turn
        FROM meeting_knowledge.live_memory_outbox AS outbox
        JOIN meeting_knowledge.live_memory_meetings AS memory
          ON memory.meeting_id = outbox.meeting_id
        JOIN meeting_core.live_meeting_turns AS turn
          ON turn.meeting_id = outbox.meeting_id
         AND turn.turn_id = outbox.turn_id
        WHERE outbox.mutation_id = $1
          AND outbox.lease_fence = $2
          AND outbox.state IN ('in_flight', 'retire_in_flight')
      `,
      [lease.mutationId, lease.fence],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    const documentId = this.ids?.keyedId("live-finalized-turn-document.v1", [
      row.scope_id,
      row.room_id,
      row.meeting_id,
      row.turn.turnId,
    ]);
    if (documentId === undefined) {
      throw new Error("live memory opaque document authority is unavailable");
    }
    return Object.freeze({
      documentId,
      generation: row.identity_generation,
      meetingId: row.meeting_id,
      mutationId: row.mutation_id,
      ordinal: row.source_generation,
      roomId: row.room_id,
      scopeId: row.scope_id,
      turn: row.turn,
      turnHash: row.turn_hash,
    });
  }

  public async apply(
    lease: LiveFinalizedMemoryLeaseV1,
    input: { readonly maximumHotTailTurns: number },
  ): Promise<{ readonly appliedAtMs: number }> {
    return applyLiveFinalizedMemory(this.pool, lease, input.maximumHotTailTurns);
  }

  public async recordDeadLetter(
    lease: LiveFinalizedMemoryLeaseV1,
    code: string,
  ): Promise<void> {
    await this.requireUpdated(await this.pool.query(
      `
        UPDATE meeting_knowledge.live_memory_outbox
        SET state = $3,
            lease_expires_at = NULL,
            retry_after = NULL,
            last_error_code = $4,
            updated_at = transaction_timestamp()
        WHERE mutation_id = $1
          AND lease_fence = $2
          AND state = $5
      `,
      [
        lease.mutationId,
        lease.fence,
        lease.operation === "delete" ? "retire_dead_letter" : "dead_letter",
        code.slice(0, 1000),
        lease.operation === "delete" ? "retire_in_flight" : "in_flight",
      ],
    ));
  }

  public async recordRetry(
    lease: LiveFinalizedMemoryLeaseV1,
    input: { readonly code: string; readonly retryAfterMs: number },
  ): Promise<void> {
    await this.requireUpdated(await this.pool.query(
      `
        UPDATE meeting_knowledge.live_memory_outbox
        SET state = $3,
            lease_expires_at = NULL,
            retry_after = transaction_timestamp() +
              ($4::double precision * interval '1 millisecond'),
            last_error_code = $5,
            updated_at = transaction_timestamp()
        WHERE mutation_id = $1
          AND lease_fence = $2
          AND state = $6
      `,
      [
        lease.mutationId,
        lease.fence,
        lease.operation === "delete" ? "retire_pending" : "retry_wait",
        input.retryAfterMs,
        input.code.slice(0, 1000),
        lease.operation === "delete" ? "retire_in_flight" : "in_flight",
      ],
    ));
  }

  public async recordOutcomeUnknown(
    lease: LiveFinalizedMemoryLeaseV1,
    input: { readonly code: string; readonly retryAfterMs: number },
  ): Promise<void> {
    await this.requireUpdated(await this.pool.query(
      `
        UPDATE meeting_knowledge.live_memory_outbox
        SET state = $3,
            lease_expires_at = NULL,
            retry_after = transaction_timestamp() +
              ($4::double precision * interval '1 millisecond'),
            last_error_code = $5,
            updated_at = transaction_timestamp()
        WHERE mutation_id = $1
          AND lease_fence = $2
          AND state = $6
      `,
      [
        lease.mutationId,
        lease.fence,
        lease.operation === "delete" ? "retire_outcome_unknown" : "outcome_unknown",
        input.retryAfterMs,
        input.code.slice(0, 1000),
        lease.operation === "delete" ? "retire_in_flight" : "in_flight",
      ],
    ));
  }

  public async settleRemoval(lease: LiveFinalizedMemoryLeaseV1): Promise<void> {
    await this.requireUpdated(await this.pool.query(
      `
        UPDATE meeting_knowledge.live_memory_outbox
        SET state = 'retired',
            lease_expires_at = NULL,
            retry_after = NULL,
            last_error_code = NULL,
            updated_at = transaction_timestamp()
        WHERE mutation_id = $1
          AND lease_fence = $2
          AND state = 'retire_in_flight'
      `,
      [lease.mutationId, lease.fence],
    ));
  }

  private async requireUpdated(
    result: { readonly rowCount: number | null },
  ): Promise<void> {
    if (result.rowCount !== 1) {
      throw new Error("live memory update lost its lease fence");
    }
  }
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original transaction error.
  }
}
