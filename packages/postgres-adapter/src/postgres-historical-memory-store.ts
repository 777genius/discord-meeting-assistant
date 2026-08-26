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
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { Pool } from "pg";

import {
  historicalAppliedFromRow,
  historicalBindingFromRow,
  historicalLeaseFromRow,
  historicalSyncRowProjection,
  type HistoricalSyncRow,
} from "./postgres-historical-memory-row.js";
import { queryHistoricalPostgres, withHistoricalPostgresTransaction, type HistoricalPostgresCancellationPort } from "./postgres-historical-query.js";
import { recordHistoricalSyncRetry } from "./postgres-historical-sync-retry.js";
import {
  enqueueHistoricalProfileRebuilds,
  requireHistoricalIndexProfileId as requireIndexProfileId,
  requireHistoricalMaximumRows as requireMaximumRows,
} from
  "./postgres-historical-profile-rebuild.js";
import {
  requireHistoricalLeaseDuration as requireLeaseDuration,
  requireHistoricalRowUpdated as requireUpdated,
} from "./postgres-historical-store-guards.js";
import { requestAnswerSourceWithdrawal } from "./postgres-answer-source-withdrawal.js";
import { acceptHistoricalReleaseInTransaction } from
  "./postgres-historical-release-acceptance.js";
export { acceptHistoricalReleaseInTransaction } from
  "./postgres-historical-release-acceptance.js";

const constructedHistoricalMemoryStores = new WeakSet<object>();

/** Read-only nominal check; only this module's constructor can add instances. */
export function assertConstructedPostgresHistoricalMemoryStore(value: unknown): asserts value is PostgresHistoricalMemoryStore {
  if (typeof value !== "object" || value === null ||
    !constructedHistoricalMemoryStores.has(value)) {
    throw new Error("PostgreSQL historical memory store was not constructed by its adapter module");
  }
}

function recordCandidateOwnership(
  recordsByLocator: Map<string, HistoricalCandidateRecordV1>,
  locator: string,
  record: HistoricalCandidateRecordV1,
): void {
  if (recordsByLocator.has(locator)) {
    throw new Error("historical candidate locator has ambiguous current ownership");
  }
  recordsByLocator.set(locator, record);
}

export class PostgresHistoricalMemoryStore implements HistoricalSyncStore {
  public constructor(private readonly pool: Pool, private readonly cancellation?: HistoricalPostgresCancellationPort) {
    constructedHistoricalMemoryStores.add(this);
    Object.freeze(this);
  }

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
    return enqueueHistoricalProfileRebuilds(
      this.pool, this.cancellation, indexProfileId, maximumRows, options,
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
        SET plan = $3::jsonb, remote_document_ids = CASE WHEN profile_rebuild_requested
              THEN '{}'::jsonb ELSE remote_document_ids END, updated_at = transaction_timestamp()
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
        ORDER BY meeting_id, desired_generation
      `,
      values: [
        scopeId,
        roomId,
        JSON.stringify({ documents: [{ manifest: { candidateLocator } }] }),
      ],
    }, options.signal, this.cancellation);
    const recordsByLocator = new Map<string, HistoricalCandidateRecordV1>();
    for (const row of result.rows) {
      const applied = historicalAppliedFromRow(row);
      const document = applied.plan.documents.find(({ manifest }) =>
        manifest.candidateLocator === candidateLocator
      );
      if (document !== undefined) {
        recordCandidateOwnership(recordsByLocator, candidateLocator, Object.freeze({
          ...applied,
          ordinal: document.manifest.ordinal,
        }));
      }
    }
    return recordsByLocator.get(candidateLocator) ?? null;
  }

  public async findCurrentCandidates(
    scopeId: string,
    roomId: string,
    candidateLocators: readonly string[],
    options: HistoricalOperationOptionsV1 = {},
  ): Promise<readonly HistoricalCandidateRecordV1[]> {
    const locators = [...new Set(candidateLocators)];
    if (locators.length === 0) {
      return Object.freeze([]);
    }
    if (locators.length > 800 || locators.some((locator) => locator.trim() === "")) {
      throw new RangeError("historical candidate batch is outside its qualified bounds");
    }
    const result = await queryHistoricalPostgres<HistoricalSyncRow>(this.pool, {
      text: `
        SELECT ${historicalSyncRowProjection}
        FROM meeting_core.historical_memory_sync
        WHERE scope_id = $1 AND room_id = $2 AND is_current
          AND operation = 'index' AND state = 'applied'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(plan -> 'documents') AS document
            WHERE document -> 'manifest' ->> 'candidateLocator' = ANY($3::text[])
          )
        ORDER BY meeting_id, desired_generation
      `,
      values: [scopeId, roomId, locators],
    }, options.signal, this.cancellation);
    const requested = new Set(locators);
    const recordsByLocator = new Map<string, HistoricalCandidateRecordV1>();
    for (const row of result.rows) {
      const applied = historicalAppliedFromRow(row);
      for (const document of applied.plan.documents) {
        if (requested.has(document.manifest.candidateLocator)) {
          recordCandidateOwnership(recordsByLocator, document.manifest.candidateLocator,
            Object.freeze({
              ...applied,
              ordinal: document.manifest.ordinal,
            }));
        }
      }
    }
    return Object.freeze(locators.flatMap((locator) => {
      const record = recordsByLocator.get(locator);
      return record === undefined ? [] : [record];
    }));
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
