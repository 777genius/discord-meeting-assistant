import type {
  CanonicalEvidenceTurn,
  LiveFinalizedMemoryLeaseV1,
  LiveFinalizedMemorySyncStore,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { Pool, PoolClient } from "pg";

interface LeaseRow {
  readonly attempt_count: number;
  readonly identity_generation: number;
  readonly lease_fence: number;
  readonly meeting_id: string;
  readonly mutation_id: string;
  readonly source_generation: number;
  readonly turn_hash: string;
  readonly turn_id: string;
}

interface StoredTurnRow {
  readonly turn: CanonicalEvidenceTurn;
}

interface LockedApplyRow extends LeaseRow {
  readonly applied_generation: number;
  readonly human_actor_ids: unknown;
  readonly registration_identity_generation: number;
  readonly registration_source_generation: number;
  readonly registration_state: "active" | "ended" | "withdrawn";
  readonly speaker_id: string;
  readonly state: string;
}

function leaseFromRow(row: LeaseRow): LiveFinalizedMemoryLeaseV1 {
  return Object.freeze({
    attempt: row.attempt_count,
    fence: row.lease_fence,
    identityGeneration: row.identity_generation,
    meetingId: row.meeting_id,
    mutationId: row.mutation_id,
    sourceGeneration: row.source_generation,
    turnHash: row.turn_hash,
    turnId: row.turn_id,
  });
}

function actorIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error("live memory roster is corrupt");
  }
  const actors = value.filter((item): item is string => typeof item === "string");
  if (actors.length !== value.length) {
    throw new Error("live memory roster is corrupt");
  }
  return actors;
}

function validateLeaseDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 300_000) {
    throw new RangeError("live memory lease duration is outside its bounds");
  }
}

export class PostgresLiveFinalizedMemoryStore
  implements LiveFinalizedMemorySyncStore
{
  public constructor(private readonly pool: Pool) {}

  public async claimNext(input: {
    readonly leaseDurationMs: number;
    readonly meetingId?: string;
  }): Promise<LiveFinalizedMemoryLeaseV1 | null> {
    validateLeaseDuration(input.leaseDurationMs);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{ readonly mutation_id: string }>(
        `
          SELECT candidate.mutation_id
          FROM meeting_knowledge.live_memory_outbox AS candidate
          WHERE candidate.state IN ('pending', 'in_flight', 'retry_wait')
            AND ($1::text IS NULL OR candidate.meeting_id = $1)
            AND (candidate.retry_after IS NULL OR
                 candidate.retry_after <= transaction_timestamp())
            AND (candidate.state <> 'in_flight' OR
                 candidate.lease_expires_at <= transaction_timestamp())
            AND NOT EXISTS (
              SELECT 1
              FROM meeting_knowledge.live_memory_outbox AS prior
              WHERE prior.meeting_id = candidate.meeting_id
                AND prior.source_generation < candidate.source_generation
                AND prior.state <> 'applied'
            )
          ORDER BY candidate.created_at,
                   candidate.meeting_id,
                   candidate.source_generation
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `,
        [input.meetingId ?? null],
      );
      const mutationId = selected.rows[0]?.mutation_id;
      if (mutationId === undefined) {
        await client.query("COMMIT");
        return null;
      }
      const updated = await client.query<LeaseRow>(
        `
          UPDATE meeting_knowledge.live_memory_outbox
          SET state = 'in_flight',
              attempt_count = attempt_count + 1,
              lease_fence = lease_fence + 1,
              lease_expires_at = transaction_timestamp() +
                ($2::double precision * interval '1 millisecond'),
              retry_after = NULL,
              updated_at = transaction_timestamp()
          WHERE mutation_id = $1
          RETURNING mutation_id, meeting_id, turn_id,
                    source_generation::float8 AS source_generation,
                    identity_generation::float8 AS identity_generation,
                    turn_hash, attempt_count,
                    lease_fence::float8 AS lease_fence
        `,
        [mutationId, input.leaseDurationMs],
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
          AND outbox.state = 'in_flight'
      `,
      [lease.mutationId, lease.fence],
    );
    return result.rows[0]?.turn ?? null;
  }

  public async apply(
    lease: LiveFinalizedMemoryLeaseV1,
    input: { readonly maximumHotTailTurns: number },
  ): Promise<void> {
    if (
      !Number.isSafeInteger(input.maximumHotTailTurns) ||
      input.maximumHotTailTurns < 1 ||
      input.maximumHotTailTurns > 256
    ) {
      throw new RangeError("live memory hot-tail bound is invalid");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<LockedApplyRow>(
        `
          SELECT outbox.mutation_id, outbox.meeting_id, outbox.turn_id,
                 outbox.source_generation::float8 AS source_generation,
                 outbox.identity_generation::float8 AS identity_generation,
                 outbox.turn_hash, outbox.attempt_count,
                 outbox.lease_fence::float8 AS lease_fence,
                 outbox.state,
                 memory.source_generation::float8 AS registration_source_generation,
                 memory.applied_generation::float8 AS applied_generation,
                 memory.identity_generation::float8 AS registration_identity_generation,
                 memory.human_actor_ids,
                 memory.state AS registration_state,
                 turn.speaker_id
          FROM meeting_knowledge.live_memory_outbox AS outbox
          JOIN meeting_knowledge.live_memory_meetings AS memory
            ON memory.meeting_id = outbox.meeting_id
          JOIN meeting_core.live_meeting_turns AS turn
            ON turn.meeting_id = outbox.meeting_id
           AND turn.turn_id = outbox.turn_id
          WHERE outbox.mutation_id = $1
          FOR UPDATE OF outbox, memory
        `,
        [lease.mutationId],
      );
      const row = locked.rows[0];
      if (
        row === undefined ||
        row.state !== "in_flight" ||
        row.lease_fence !== lease.fence ||
        row.source_generation !== lease.sourceGeneration ||
        row.identity_generation !== lease.identityGeneration ||
        row.turn_hash !== lease.turnHash ||
        row.registration_state === "withdrawn" ||
        row.registration_source_generation < lease.sourceGeneration ||
        row.registration_identity_generation < lease.identityGeneration ||
        row.applied_generation !== lease.sourceGeneration - 1 ||
        !actorIds(row.human_actor_ids).includes(row.speaker_id)
      ) {
        throw new Error("live memory apply lost current authority or lease order");
      }
      await client.query(
        `
          INSERT INTO meeting_knowledge.live_memory_hot_tail (
            meeting_id, turn_id, source_generation,
            identity_generation, turn_hash
          ) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (meeting_id, turn_id) DO UPDATE
          SET source_generation = EXCLUDED.source_generation,
              identity_generation = EXCLUDED.identity_generation,
              turn_hash = EXCLUDED.turn_hash
          WHERE meeting_knowledge.live_memory_hot_tail.source_generation =
                  EXCLUDED.source_generation
            AND meeting_knowledge.live_memory_hot_tail.identity_generation =
                  EXCLUDED.identity_generation
            AND meeting_knowledge.live_memory_hot_tail.turn_hash =
                  EXCLUDED.turn_hash
        `,
        [
          lease.meetingId,
          lease.turnId,
          lease.sourceGeneration,
          lease.identityGeneration,
          lease.turnHash,
        ],
      );
      await client.query(
        `
          DELETE FROM meeting_knowledge.live_memory_hot_tail AS stale
          WHERE stale.meeting_id = $1
            AND stale.turn_id IN (
              SELECT tail.turn_id
              FROM meeting_knowledge.live_memory_hot_tail AS tail
              WHERE tail.meeting_id = $1
              ORDER BY tail.source_generation DESC
              OFFSET $2
            )
        `,
        [lease.meetingId, input.maximumHotTailTurns],
      );
      const applied = await client.query(
        `
          UPDATE meeting_knowledge.live_memory_outbox
          SET state = 'applied',
              lease_expires_at = NULL,
              retry_after = NULL,
              last_error_code = NULL,
              updated_at = transaction_timestamp()
          WHERE mutation_id = $1
            AND lease_fence = $2
            AND state = 'in_flight'
        `,
        [lease.mutationId, lease.fence],
      );
      const watermark = await client.query(
        `
          UPDATE meeting_knowledge.live_memory_meetings
          SET applied_generation = $2,
              updated_at = transaction_timestamp()
          WHERE meeting_id = $1
            AND applied_generation = $3
        `,
        [lease.meetingId, lease.sourceGeneration, lease.sourceGeneration - 1],
      );
      if (applied.rowCount !== 1 || watermark.rowCount !== 1) {
        throw new Error("live memory apply lost its generation fence");
      }
      await client.query("COMMIT");
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async recordDeadLetter(
    lease: LiveFinalizedMemoryLeaseV1,
    code: string,
  ): Promise<void> {
    await this.requireUpdated(await this.pool.query(
      `
        UPDATE meeting_knowledge.live_memory_outbox
        SET state = 'dead_letter',
            lease_expires_at = NULL,
            retry_after = NULL,
            last_error_code = $3,
            updated_at = transaction_timestamp()
        WHERE mutation_id = $1
          AND lease_fence = $2
          AND state = 'in_flight'
      `,
      [lease.mutationId, lease.fence, code.slice(0, 1000)],
    ));
  }

  public async recordRetry(
    lease: LiveFinalizedMemoryLeaseV1,
    input: { readonly code: string; readonly retryAfterMs: number },
  ): Promise<void> {
    await this.requireUpdated(await this.pool.query(
      `
        UPDATE meeting_knowledge.live_memory_outbox
        SET state = 'retry_wait',
            lease_expires_at = NULL,
            retry_after = transaction_timestamp() +
              ($3::double precision * interval '1 millisecond'),
            last_error_code = $4,
            updated_at = transaction_timestamp()
        WHERE mutation_id = $1
          AND lease_fence = $2
          AND state = 'in_flight'
      `,
      [
        lease.mutationId,
        lease.fence,
        input.retryAfterMs,
        input.code.slice(0, 1000),
      ],
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
