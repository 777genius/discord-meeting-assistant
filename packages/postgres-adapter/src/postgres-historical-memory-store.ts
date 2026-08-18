import {
  decodeHistoricalIndexPlanV1,
  validateHistoricalReleaseBinding,
  type HistoricalAppliedPlanV1,
  type HistoricalCandidateRecordV1,
  type HistoricalIndexPlanV1,
  type HistoricalOperationOptionsV1,
  type HistoricalReleaseBindingV1,
  type HistoricalSyncClaimOptionsV1,
  type HistoricalSyncLeaseV1,
  type HistoricalSyncRetryV1,
  type HistoricalSyncStore,
  MAXIMUM_HISTORICAL_SYNC_LEASE_DURATION_MS,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { Pool, PoolClient } from "pg";

import {
  historicalAppliedFromRow,
  historicalBindingFromRow,
  historicalBindingsEqual,
  historicalLeaseFromRow,
  historicalSyncRowProjection,
  type HistoricalSyncRow,
} from "./postgres-historical-memory-row.js";
import { queryHistoricalPostgres, withHistoricalPostgresTransaction, type HistoricalPostgresCancellationPort } from "./postgres-historical-query.js";
import { recordHistoricalSyncRetry } from "./postgres-historical-sync-retry.js";
import {
  lockMeetingKnowledgeSource,
  requestAnswerSourceWithdrawal,
} from "./postgres-answer-source-withdrawal.js";

interface HistoricalMeetingMutationRow {
  readonly desired_generation: number;
  readonly operation: "delete_meeting" | "delete_release" | "index";
}
function requireLeaseDuration(options: HistoricalSyncClaimOptionsV1): void {
  if (
    !Number.isSafeInteger(options.leaseDurationMs) ||
    options.leaseDurationMs < 1_000 ||
    options.leaseDurationMs > MAXIMUM_HISTORICAL_SYNC_LEASE_DURATION_MS
  ) {
    throw new RangeError("historical sync lease duration is outside its bounds");
  }
}

function requireMaximumRows(maximumRows: number): void {
  if (!Number.isSafeInteger(maximumRows) || maximumRows < 1 || maximumRows > 4_096) {
    throw new RangeError("historical room read bound is outside its qualified range");
  }
}

function requireIndexProfileId(indexProfileId: string): void {
  if (
    indexProfileId.trim().length === 0 ||
    new TextEncoder().encode(indexProfileId).byteLength > 1_000
  ) {
    throw new RangeError("historical index profile identity is outside its bounds");
  }
}

async function requireUpdated(result: { readonly rowCount: number | null }, operation: string): Promise<void> {
  if (result.rowCount !== 1) {
    throw new Error(`historical sync ${operation} lost its lease fence`);
  }
}

/** Shared mutation used by both the repository's acceptance transaction and the public store port. */
export async function acceptHistoricalReleaseInTransaction(
  client: PoolClient,
  candidate: HistoricalReleaseBindingV1,
): Promise<"accepted" | "replayed"> {
  const binding = validateHistoricalReleaseBinding(candidate);
  await lockMeetingKnowledgeSource(client, binding.meetingId);
  const withdrawn = await client.query(
    `SELECT 1 FROM meeting_knowledge.withdrawn_meeting_sources
     WHERE meeting_id = $1`,
    [binding.meetingId],
  );
  if (withdrawn.rowCount === 1) {
    throw new Error("withdrawn meeting cannot accept a new historical release");
  }
  const existing = await client.query<HistoricalSyncRow>(
    `SELECT ${historicalSyncRowProjection} FROM meeting_core.historical_memory_sync WHERE release_id = $1 FOR UPDATE`,
    [binding.releaseId],
  );
  if (existing.rows[0] !== undefined) {
    const stored = historicalBindingFromRow(existing.rows[0]);
    if (!historicalBindingsEqual(stored, binding)) {
      throw new Error("historical release replay conflicts with its accepted binding");
    }
    return "replayed";
  }
  const meetingMutations = await client.query<HistoricalMeetingMutationRow>(
    `
      SELECT desired_generation::float8 AS desired_generation, operation
      FROM meeting_core.historical_memory_sync
      WHERE meeting_id = $1
      FOR UPDATE
    `,
    [binding.meetingId],
  );
  if (meetingMutations.rows.some(({ operation }) => operation === "delete_meeting")) {
    throw new Error("withdrawn meeting cannot accept a new historical release");
  }
  const previousGeneration = meetingMutations.rows.reduce(
    (maximum, row) => Math.max(maximum, row.desired_generation),
    0,
  );
  if (binding.desiredGeneration !== previousGeneration + 1) {
    throw new Error("historical release generation is not the next monotonic generation");
  }
  await client.query(
    `
      UPDATE meeting_core.historical_memory_sync
      SET is_current = false,
          operation = 'delete_release',
          state = CASE
            WHEN state = 'deleted' THEN 'deleted'
            WHEN state = 'in_flight' THEN 'in_flight'
            ELSE 'deleting'
          END,
          retry_after = NULL,
          lease_expires_at = CASE
            WHEN state = 'in_flight' THEN lease_expires_at
            ELSE NULL
          END,
          superseded_by_release_id = $2,
          updated_at = transaction_timestamp()
      WHERE meeting_id = $1 AND is_current
    `,
    [binding.meetingId, binding.releaseId],
  );
  await client.query(
    `
      INSERT INTO meeting_core.historical_memory_sync (
        release_id, meeting_id, schema_version, accepted_meeting_revision,
        desired_generation, transcript_id, transcript_version,
        evidence_policy_version, scope_id, room_id
      ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9)
    `,
    [
      binding.releaseId,
      binding.meetingId,
      binding.acceptedMeetingRevision,
      binding.desiredGeneration,
      binding.transcriptId,
      binding.transcriptVersion,
      binding.evidencePolicyVersion,
      binding.scopeId,
      binding.roomId,
    ],
  );
  return "accepted";
}

export class PostgresHistoricalMemoryStore implements HistoricalSyncStore {
  public constructor(private readonly pool: Pool, private readonly cancellation?: HistoricalPostgresCancellationPort) {}

  public acceptRelease(
    candidate: HistoricalReleaseBindingV1,
  ): Promise<"accepted" | "replayed"> {
    return withHistoricalPostgresTransaction(
      this.pool,
      undefined,
      async (client) => await acceptHistoricalReleaseInTransaction(client, candidate),
      this.cancellation,
    );
  }

  public async enqueueAppliedProfileRebuilds(
    indexProfileId: string,
    maximumRows: number,
    options: HistoricalOperationOptionsV1 = {},
  ): Promise<{ readonly enqueued: number; readonly remaining: boolean }> {
    requireIndexProfileId(indexProfileId);
    requireMaximumRows(maximumRows);
    return withHistoricalPostgresTransaction(
      this.pool,
      options.signal,
      async (client) => {
        const result = await client.query<{ readonly enqueued: number; readonly remaining: boolean }>(
          `
            WITH selected AS (
              SELECT release_id
              FROM meeting_core.historical_memory_sync
              WHERE is_current AND operation = 'index' AND state = 'applied'
                AND applied_index_profile_id IS DISTINCT FROM $1
              ORDER BY meeting_id, desired_generation, release_id
              LIMIT $2
              FOR UPDATE SKIP LOCKED
            ), rebuilt AS (
              UPDATE meeting_core.historical_memory_sync AS historical
              SET state = 'pending', profile_rebuild_requested = true,
                  retry_after = NULL, lease_expires_at = NULL,
                  last_error_code = NULL, updated_at = transaction_timestamp()
              FROM selected
              WHERE historical.release_id = selected.release_id
              RETURNING 1
            )
            SELECT count(*)::float8 AS enqueued,
              EXISTS (
                SELECT 1 FROM meeting_core.historical_memory_sync
                WHERE is_current AND operation = 'index' AND state = 'applied'
                  AND applied_index_profile_id IS DISTINCT FROM $1
              ) AS remaining
            FROM rebuilt
          `,
          [indexProfileId, maximumRows],
        );
        const row = result.rows[0];
        if (row === undefined || !Number.isSafeInteger(row.enqueued)) {
          throw new Error("historical profile rebuild query returned an invalid result");
        }
        return Object.freeze({ enqueued: row.enqueued, remaining: row.remaining });
      },
      this.cancellation,
    );
  }

  public async claimNext(
    options: HistoricalSyncClaimOptionsV1,
    operationOptions: HistoricalOperationOptionsV1 = {},
  ): Promise<HistoricalSyncLeaseV1 | null> {
    requireLeaseDuration(options);
    return withHistoricalPostgresTransaction(
      this.pool,
      operationOptions.signal,
      async (client) => {
      const selected = await client.query<{ readonly release_id: string }>(
        `
          SELECT release_id
          FROM meeting_core.historical_memory_sync
          WHERE state IN ('pending', 'retry_wait', 'deleting', 'in_flight')
            AND ($1::boolean OR operation <> 'index')
            AND (retry_after IS NULL OR retry_after <= transaction_timestamp())
            AND (state <> 'in_flight' OR lease_expires_at <= transaction_timestamp())
          ORDER BY CASE WHEN operation <> 'index' THEN 0 ELSE 1 END,
                   COALESCE(retry_after, lease_expires_at, created_at), release_id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `,
        [options.allowIndex],
      );
      const releaseId = selected.rows[0]?.release_id;
      if (releaseId === undefined) {
        return null;
      }
      const updated = await client.query<HistoricalSyncRow>(
        `
          UPDATE meeting_core.historical_memory_sync
          SET state = 'in_flight',
              attempt_count = attempt_count + 1,
              lease_fence = lease_fence + 1,
              lease_expires_at = transaction_timestamp() + ($2::double precision * interval '1 millisecond'),
              updated_at = transaction_timestamp()
          WHERE release_id = $1
          RETURNING ${historicalSyncRowProjection}
        `,
        [releaseId, options.leaseDurationMs],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        throw new Error("historical sync claim disappeared");
      }
      return historicalLeaseFromRow(row);
      },
      this.cancellation,
    );
  }
  public async recordPlan(
    lease: HistoricalSyncLeaseV1,
    plan: HistoricalIndexPlanV1,
    options: HistoricalOperationOptionsV1 = {},
  ): Promise<void> {
    await requireUpdated(await queryHistoricalPostgres(this.pool, {
      text: `
        UPDATE meeting_core.historical_memory_sync
        SET plan = $3::jsonb, updated_at = transaction_timestamp()
        WHERE release_id = $1 AND lease_fence = $2
          AND state = 'in_flight' AND operation = 'index' AND is_current
      `,
      values: [lease.binding.releaseId, lease.fence, plan],
    }, options.signal, this.cancellation), "plan checkpoint");
  }
  public async recordApplied(
    lease: HistoricalSyncLeaseV1,
    plan: HistoricalIndexPlanV1,
    documentIds: Readonly<Record<string, string>>,
    indexProfileId: string,
    options: HistoricalOperationOptionsV1 = {},
  ): Promise<void> {
    requireIndexProfileId(indexProfileId);
    await requireUpdated(await queryHistoricalPostgres(this.pool, {
      text: `
        UPDATE meeting_core.historical_memory_sync
        SET state = 'applied', plan = $3::jsonb,
            remote_document_ids = $4::jsonb, lease_expires_at = NULL,
            retry_after = NULL, last_error_code = NULL,
            applied_index_profile_id = $5,
            profile_rebuild_requested = false,
            updated_at = transaction_timestamp()
        WHERE release_id = $1 AND lease_fence = $2
          AND state = 'in_flight' AND operation = 'index' AND is_current
      `,
      values: [lease.binding.releaseId, lease.fence, plan, documentIds, indexProfileId],
    }, options.signal, this.cancellation), "apply");
  }

  public async recordRetry(
    lease: HistoricalSyncLeaseV1,
    failure: HistoricalSyncRetryV1,
    options: HistoricalOperationOptionsV1 = {},
  ): Promise<void> {
    await requireUpdated(
      await recordHistoricalSyncRetry(this.pool, this.cancellation, lease, failure, options),
      "retry",
    );
  }

  public async recordDeadLetter(
    lease: HistoricalSyncLeaseV1,
    code: string,
    options: HistoricalOperationOptionsV1 = {},
  ): Promise<void> {
    await requireUpdated(await queryHistoricalPostgres(this.pool, {
      text: `
        UPDATE meeting_core.historical_memory_sync
        SET state = 'dead_letter', lease_expires_at = NULL,
            retry_after = NULL, last_error_code = $3,
            updated_at = transaction_timestamp()
        WHERE release_id = $1 AND lease_fence = $2
          AND state = 'in_flight' AND operation = 'index'
      `,
      values: [lease.binding.releaseId, lease.fence, code],
    }, options.signal, this.cancellation), "dead letter");
  }

  public async recordDeleted(
    lease: HistoricalSyncLeaseV1,
    options: HistoricalOperationOptionsV1 = {},
  ): Promise<void> {
    await requireUpdated(await queryHistoricalPostgres(this.pool, {
      text: `
        UPDATE meeting_core.historical_memory_sync
        SET state = 'deleted', lease_expires_at = NULL,
            retry_after = NULL, last_error_code = NULL,
            updated_at = transaction_timestamp()
        WHERE release_id = $1 AND lease_fence = $2
          AND state = 'in_flight' AND operation <> 'index'
      `,
      values: [lease.binding.releaseId, lease.fence],
    }, options.signal, this.cancellation), "delete");
  }

  public async requestMeetingDeletion(
    meetingId: string,
    options: HistoricalOperationOptionsV1 = {},
  ): Promise<void> {
    await withHistoricalPostgresTransaction(
      this.pool,
      options.signal,
      async (client) => {
        await requestAnswerSourceWithdrawal(client, meetingId);
      },
      this.cancellation,
    );
  }

  public async findCurrentCandidate(
    scopeId: string,
    roomId: string,
    candidateLocator: string,
    options: HistoricalOperationOptionsV1 = {},
  ): Promise<HistoricalCandidateRecordV1 | null> {
    const result = await queryHistoricalPostgres<HistoricalSyncRow>(this.pool, {
      text: `
        SELECT ${historicalSyncRowProjection}
        FROM meeting_core.historical_memory_sync
        WHERE scope_id = $1 AND room_id = $2 AND is_current
          AND operation = 'index' AND state = 'applied'
          AND plan @> $3::jsonb
        LIMIT 1
      `,
      values: [
        scopeId,
        roomId,
        JSON.stringify({ documents: [{ manifest: { candidateLocator } }] }),
      ],
    }, options.signal, this.cancellation);
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    const applied = historicalAppliedFromRow(row);
    const document = applied.plan.documents.find(({ manifest }) =>
      manifest.candidateLocator === candidateLocator
    );
    return document === undefined
      ? null
      : Object.freeze({ ...applied, ordinal: document.manifest.ordinal });
  }

  public async listCurrentRoomPlans(
    scopeId: string,
    roomId: string,
    maximumRows: number,
    options: HistoricalOperationOptionsV1 = {},
  ): Promise<readonly HistoricalAppliedPlanV1[]> {
    requireMaximumRows(maximumRows);
    const result = await queryHistoricalPostgres<HistoricalSyncRow>(this.pool, {
      text: `
        SELECT ${historicalSyncRowProjection}
        FROM meeting_core.historical_memory_sync
        WHERE scope_id = $1 AND room_id = $2 AND is_current
          AND operation = 'index' AND state = 'applied'
        ORDER BY meeting_id, desired_generation
        LIMIT $3
      `,
      values: [scopeId, roomId, maximumRows],
    }, options.signal, this.cancellation);
    return Object.freeze(result.rows.map(historicalAppliedFromRow));
  }

  public async listDesiredRoomBindings(
    scopeId: string,
    roomId: string,
    maximumRows: number,
    options: HistoricalOperationOptionsV1 = {},
  ): Promise<readonly HistoricalReleaseBindingV1[]> {
    requireMaximumRows(maximumRows);
    const result = await queryHistoricalPostgres<HistoricalSyncRow>(this.pool, {
      text: `
        SELECT ${historicalSyncRowProjection}
        FROM meeting_core.historical_memory_sync
        WHERE scope_id = $1 AND room_id = $2 AND is_current
          AND operation = 'index' AND state <> 'deleted'
        ORDER BY meeting_id, desired_generation
        LIMIT $3
      `,
      values: [scopeId, roomId, maximumRows],
    }, options.signal, this.cancellation);
    return Object.freeze(result.rows.map(historicalBindingFromRow));
  }

  public async isCurrentGeneration(
    candidate: HistoricalReleaseBindingV1,
    indexGeneration: string,
    options: HistoricalOperationOptionsV1 = {},
  ): Promise<boolean> {
    const binding = validateHistoricalReleaseBinding(candidate);
    const result = await queryHistoricalPostgres<HistoricalSyncRow>(this.pool, {
      text: `
        SELECT ${historicalSyncRowProjection}
        FROM meeting_core.historical_memory_sync
        WHERE release_id = $1 AND is_current AND operation = 'index'
          AND state = 'applied' AND plan IS NOT NULL
      `,
      values: [binding.releaseId],
    }, options.signal, this.cancellation);
    const row = result.rows[0];
    if (row === undefined) {
      return false;
    }
    const stored = historicalBindingFromRow(row);
    return stored.releaseId === binding.releaseId &&
      stored.desiredGeneration === binding.desiredGeneration &&
      stored.acceptedMeetingRevision === binding.acceptedMeetingRevision &&
      stored.scopeId === binding.scopeId &&
      stored.roomId === binding.roomId &&
      stored.meetingId === binding.meetingId &&
      stored.transcriptId === binding.transcriptId &&
      stored.transcriptVersion === binding.transcriptVersion &&
      row.plan !== null &&
      decodeHistoricalIndexPlanV1(row.plan).topology.indexGeneration === indexGeneration;
  }
}
