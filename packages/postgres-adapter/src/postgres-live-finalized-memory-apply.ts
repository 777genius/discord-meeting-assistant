import type { LiveFinalizedMemoryLeaseV1 } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import type { Pool, PoolClient } from "pg";

interface LockedApplyRow {
  readonly applied_generation: number;
  readonly human_actor_ids: unknown;
  readonly identity_generation: number;
  readonly lease_fence: number;
  readonly registration_identity_generation: number;
  readonly registration_source_generation: number;
  readonly registration_state: "active" | "ended" | "withdrawn";
  readonly source_generation: number;
  readonly speaker_id: string;
  readonly state: string;
  readonly turn_hash: string;
}

export async function applyLiveFinalizedMemory(
  pool: Pool,
  lease: LiveFinalizedMemoryLeaseV1,
  maximumHotTailTurns: number,
): Promise<{ readonly appliedAtMs: number }> {
  if (!Number.isSafeInteger(maximumHotTailTurns) ||
    maximumHotTailTurns < 1 || maximumHotTailTurns > 256) {
    throw new RangeError("live memory hot-tail bound is invalid");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await requireCurrentApplyAuthority(client, lease);
    await upsertHotTail(client, lease);
    await trimHotTail(client, lease.meetingId, maximumHotTailTurns);
    const appliedAtMs = await settleAppliedMutation(client, lease);
    await client.query("COMMIT");
    return { appliedAtMs };
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

async function requireCurrentApplyAuthority(
  client: PoolClient,
  lease: LiveFinalizedMemoryLeaseV1,
): Promise<void> {
  const locked = await client.query<LockedApplyRow>(
    `SELECT outbox.source_generation::float8 AS source_generation,
            outbox.identity_generation::float8 AS identity_generation,
            outbox.turn_hash, outbox.lease_fence::float8 AS lease_fence,
            outbox.state,
            memory.source_generation::float8 AS registration_source_generation,
            memory.applied_generation::float8 AS applied_generation,
            memory.identity_generation::float8 AS registration_identity_generation,
            memory.human_actor_ids, memory.state AS registration_state,
            turn.speaker_id
     FROM meeting_knowledge.live_memory_outbox AS outbox
     JOIN meeting_knowledge.live_memory_meetings AS memory
       ON memory.meeting_id = outbox.meeting_id
     JOIN meeting_core.live_meeting_turns AS turn
       ON turn.meeting_id = outbox.meeting_id AND turn.turn_id = outbox.turn_id
     WHERE outbox.mutation_id = $1
     FOR UPDATE OF outbox, memory`,
    [lease.mutationId],
  );
  const row = locked.rows[0];
  const actors = actorIds(row?.human_actor_ids);
  if (row === undefined || actors === null ||
    row.state !== "in_flight" || row.lease_fence !== lease.fence ||
    row.source_generation !== lease.sourceGeneration ||
    row.identity_generation !== lease.identityGeneration ||
    row.turn_hash !== lease.turnHash || row.registration_state === "withdrawn" ||
    row.registration_source_generation < lease.sourceGeneration ||
    row.registration_identity_generation < lease.identityGeneration ||
    row.applied_generation !== lease.sourceGeneration - 1 ||
    !actors.includes(row.speaker_id)) {
    throw new Error("live memory apply lost current authority or lease order");
  }
}

function actorIds(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }
  return value as readonly string[];
}

async function upsertHotTail(
  client: PoolClient,
  lease: LiveFinalizedMemoryLeaseV1,
): Promise<void> {
  await client.query(
    `INSERT INTO meeting_knowledge.live_memory_hot_tail (
       meeting_id, turn_id, source_generation, identity_generation, turn_hash
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (meeting_id, turn_id) DO UPDATE
     SET source_generation = EXCLUDED.source_generation,
         identity_generation = EXCLUDED.identity_generation,
         turn_hash = EXCLUDED.turn_hash
     WHERE meeting_knowledge.live_memory_hot_tail.source_generation =
             EXCLUDED.source_generation
       AND meeting_knowledge.live_memory_hot_tail.identity_generation =
             EXCLUDED.identity_generation
       AND meeting_knowledge.live_memory_hot_tail.turn_hash = EXCLUDED.turn_hash`,
    [lease.meetingId, lease.turnId, lease.sourceGeneration,
      lease.identityGeneration, lease.turnHash],
  );
}

async function trimHotTail(
  client: PoolClient,
  meetingId: string,
  maximumHotTailTurns: number,
): Promise<void> {
  await client.query(
    `DELETE FROM meeting_knowledge.live_memory_hot_tail AS stale
     WHERE stale.meeting_id = $1 AND stale.turn_id IN (
       SELECT tail.turn_id FROM meeting_knowledge.live_memory_hot_tail AS tail
       WHERE tail.meeting_id = $1 ORDER BY tail.source_generation DESC OFFSET $2
     )`,
    [meetingId, maximumHotTailTurns],
  );
}

async function settleAppliedMutation(
  client: PoolClient,
  lease: LiveFinalizedMemoryLeaseV1,
): Promise<number> {
  const applied = await client.query<{ readonly applied_at_ms: number }>(
    `UPDATE meeting_knowledge.live_memory_outbox
     SET state = 'applied', lease_expires_at = NULL, retry_after = NULL,
         last_error_code = NULL, updated_at = transaction_timestamp()
     WHERE mutation_id = $1 AND lease_fence = $2 AND state = 'in_flight'
     RETURNING (extract(epoch FROM updated_at) * 1000)::float8 AS applied_at_ms`,
    [lease.mutationId, lease.fence],
  );
  const watermark = await client.query(
    `UPDATE meeting_knowledge.live_memory_meetings
     SET applied_generation = $2, updated_at = transaction_timestamp()
     WHERE meeting_id = $1 AND applied_generation = $3`,
    [lease.meetingId, lease.sourceGeneration, lease.sourceGeneration - 1],
  );
  const appliedAtMs = applied.rows[0]?.applied_at_ms;
  if (applied.rowCount !== 1 || watermark.rowCount !== 1 ||
    typeof appliedAtMs !== "number" || !Number.isFinite(appliedAtMs)) {
    throw new Error("live memory apply lost its generation fence or timestamp");
  }
  return appliedAtMs;
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query("ROLLBACK"); } catch { /* Preserve original error. */ }
}
