import {
  decodeCoverageExtractV1,
  decodeCoverageReductionV1,
  decodeHistoricalReleaseBindingV1,
  type CoverageCheckpointLeaseV1,
  type CoverageExtractV1,
  type CoverageReductionV1,
  type ExhaustiveCoverageStore,
  type HistoricalReleaseBindingV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { Pool } from "pg";

import {
  queryHistoricalPostgres,
  withHistoricalPostgresTransaction,
  type HistoricalPostgresCancellationPort,
} from "./postgres-historical-query.js";

interface CoverageRow {
  readonly attempt_count: number;
  readonly block_locators: unknown;
  readonly checkpoint_id: string;
  readonly coverage_bitmap: unknown;
  readonly extracts: unknown;
  readonly lease_fence: number;
  readonly plan_digest: string;
  readonly question_hash: string;
  readonly release_bindings: unknown;
  readonly reduction: unknown;
  readonly state: "active" | "completed" | "failed" | "invalidated";
  readonly terminal_reason: string | null;
}

const coverageProjection = `
  checkpoint_id, question_hash, plan_digest, release_bindings,
  block_locators, coverage_bitmap, extracts, state,
  reduction, terminal_reason,
  attempt_count::float8 AS attempt_count,
  lease_fence::float8 AS lease_fence
`;

function strings(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`stored exhaustive coverage ${field} is corrupt`);
  }
  return Object.freeze(value as string[]);
}

function bitmap(value: unknown): readonly boolean[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "boolean")) {
    throw new Error("stored exhaustive coverage bitmap is corrupt");
  }
  return Object.freeze(value as boolean[]);
}

function extractRecord(value: unknown): Readonly<Record<string, CoverageExtractV1>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("stored exhaustive coverage extracts are corrupt");
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, extract]) => [key, decodeCoverageExtractV1(extract)]),
  ));
}

function lease(row: CoverageRow): CoverageCheckpointLeaseV1 {
  return Object.freeze({
    attempt: row.attempt_count,
    bitmap: bitmap(row.coverage_bitmap),
    checkpointId: row.checkpoint_id,
    extracts: extractRecord(row.extracts),
    fence: row.lease_fence,
    planDigest: row.plan_digest,
    reduction: row.reduction === null
      ? null
      : decodeCoverageReductionV1(row.reduction),
    state: row.state,
    terminalReason: row.terminal_reason,
  });
}

function releaseBindings(value: unknown): readonly HistoricalReleaseBindingV1[] {
  if (!Array.isArray(value)) {
    throw new Error("stored exhaustive coverage release bindings are corrupt");
  }
  return Object.freeze(value.map(decodeHistoricalReleaseBindingV1));
}

function sameReleaseBindings(
  stored: unknown,
  requested: readonly HistoricalReleaseBindingV1[],
): boolean {
  const left = releaseBindings(stored);
  return left.length === requested.length && left.every((binding, index) => {
    const candidate = requested[index];
    return candidate !== undefined &&
      binding.releaseId === candidate.releaseId &&
      binding.desiredGeneration === candidate.desiredGeneration &&
      binding.acceptedMeetingRevision === candidate.acceptedMeetingRevision &&
      binding.meetingId === candidate.meetingId &&
      binding.scopeId === candidate.scopeId &&
      binding.roomId === candidate.roomId &&
      binding.transcriptId === candidate.transcriptId &&
      binding.transcriptVersion === candidate.transcriptVersion;
  });
}

export class PostgresExhaustiveCoverageStore implements ExhaustiveCoverageStore {
  public constructor(
    private readonly pool: Pool,
    private readonly cancellation?: HistoricalPostgresCancellationPort,
  ) {}

  public async open(input: {
    readonly blockLocators: readonly string[];
    readonly checkpointId: string;
    readonly planDigest: string;
    readonly questionHash: string;
    readonly releaseBindings: readonly HistoricalReleaseBindingV1[];
    readonly retentionSeconds: number;
    readonly signal?: AbortSignal;
  }): Promise<CoverageCheckpointLeaseV1> {
    if (
      !Number.isSafeInteger(input.retentionSeconds) ||
      input.retentionSeconds < 60 ||
      input.retentionSeconds > 604_800
    ) {
      throw new RangeError("exhaustive coverage retention is outside its bound");
    }
    return withHistoricalPostgresTransaction(this.pool, input.signal, async (client) => {
      const selected = await client.query<CoverageRow>(
        `
          SELECT ${coverageProjection}
          FROM meeting_core.historical_coverage_checkpoints
          WHERE checkpoint_id = $1
          FOR UPDATE
        `,
        [input.checkpointId],
      );
      const existing = selected.rows[0];
      if (existing === undefined) {
        const inserted = await client.query<CoverageRow>(
          `
            INSERT INTO meeting_core.historical_coverage_checkpoints (
              checkpoint_id, schema_version, question_hash, plan_digest,
              release_bindings, block_locators, coverage_bitmap,
              retention_expires_at
            ) VALUES (
              $1, 1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb,
              transaction_timestamp() + ($7::double precision * interval '1 second')
            )
            RETURNING ${coverageProjection}
          `,
          [
            input.checkpointId,
            input.questionHash,
            input.planDigest,
            JSON.stringify(input.releaseBindings),
            JSON.stringify(input.blockLocators),
            JSON.stringify(input.blockLocators.map(() => false)),
            input.retentionSeconds,
          ],
        );
        const row = inserted.rows[0];
        if (row === undefined) {
          throw new Error("exhaustive coverage checkpoint was not inserted");
        }
        return lease(row);
      }
      if (
        existing.question_hash !== input.questionHash ||
        existing.plan_digest !== input.planDigest
      ) {
        throw new Error("exhaustive coverage checkpoint identity conflict");
      }
      if (existing.state === "failed" || existing.state === "invalidated") {
        return lease(existing);
      }
      if (
        !sameStringSequence(existing.block_locators, input.blockLocators) ||
        !sameReleaseBindings(existing.release_bindings, input.releaseBindings)
      ) {
        throw new Error("exhaustive coverage checkpoint identity conflict");
      }
      if (existing.state === "completed") {
        return lease(existing);
      }
      const updated = await client.query<CoverageRow>(
        `
          UPDATE meeting_core.historical_coverage_checkpoints
          SET attempt_count = attempt_count + 1,
              lease_fence = lease_fence + 1,
              state = 'active', completed_at = NULL,
              updated_at = transaction_timestamp()
          WHERE checkpoint_id = $1
          RETURNING ${coverageProjection}
        `,
        [input.checkpointId],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        throw new Error("exhaustive coverage checkpoint disappeared");
      }
      return lease(row);
    }, this.cancellation);
  }

  public async recordExtract(input: {
    readonly blockOrdinal: number;
    readonly checkpointId: string;
    readonly extract: CoverageExtractV1;
    readonly fence: number;
    readonly signal?: AbortSignal;
  }): Promise<CoverageCheckpointLeaseV1> {
    return withHistoricalPostgresTransaction(this.pool, input.signal, async (client) => {
      const selected = await client.query<CoverageRow>(
        `
          SELECT ${coverageProjection}
          FROM meeting_core.historical_coverage_checkpoints
          WHERE checkpoint_id = $1 AND lease_fence = $2 AND state = 'active'
          FOR UPDATE
        `,
        [input.checkpointId, input.fence],
      );
      const row = selected.rows[0];
      if (row === undefined) {
        throw new Error("exhaustive coverage extract lost its lease fence");
      }
      const locators = strings(row.block_locators, "block locators");
      if (locators[input.blockOrdinal] !== input.extract.blockLocator) {
        throw new Error("exhaustive coverage extract does not match its block ordinal");
      }
      const nextBitmap = [...bitmap(row.coverage_bitmap)];
      nextBitmap[input.blockOrdinal] = true;
      const nextExtracts = {
        ...extractRecord(row.extracts),
        [input.extract.blockLocator]: input.extract,
      };
      const updated = await client.query<CoverageRow>(
        `
          UPDATE meeting_core.historical_coverage_checkpoints
          SET coverage_bitmap = $3::jsonb, extracts = $4::jsonb,
              updated_at = transaction_timestamp()
          WHERE checkpoint_id = $1 AND lease_fence = $2 AND state = 'active'
          RETURNING ${coverageProjection}
        `,
        [
          input.checkpointId,
          input.fence,
          JSON.stringify(nextBitmap),
          JSON.stringify(nextExtracts),
        ],
      );
      const updatedRow = updated.rows[0];
      if (updatedRow === undefined) {
        throw new Error("exhaustive coverage extract update lost its lease fence");
      }
      return lease(updatedRow);
    }, this.cancellation);
  }

  public async recordReduction(input: {
    readonly checkpointId: string;
    readonly fence: number;
    readonly reduction: CoverageReductionV1;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    const result = await queryHistoricalPostgres(this.pool, {
      text: `
        UPDATE meeting_core.historical_coverage_checkpoints
        SET reduction = $3::jsonb, updated_at = transaction_timestamp()
        WHERE checkpoint_id = $1 AND lease_fence = $2 AND state = 'active'
      `,
      values: [
        input.checkpointId,
        input.fence,
        JSON.stringify(input.reduction),
      ],
    }, input.signal, this.cancellation);
    if (result.rowCount !== 1) {
      throw new Error("exhaustive coverage reduction lost its lease fence");
    }
  }

  public async complete(input: {
    readonly checkpointId: string;
    readonly fence: number;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    const result = await queryHistoricalPostgres(this.pool, {
      text: `
        UPDATE meeting_core.historical_coverage_checkpoints
        SET state = 'completed', completed_at = transaction_timestamp(),
            terminal_at = transaction_timestamp(), extracts = '{}'::jsonb,
            updated_at = transaction_timestamp()
        WHERE checkpoint_id = $1 AND lease_fence = $2 AND state = 'active'
          AND reduction IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(coverage_bitmap) AS bit
            WHERE bit <> 'true'::jsonb
          )
      `,
      values: [input.checkpointId, input.fence],
    }, input.signal, this.cancellation);
    if (result.rowCount !== 1) {
      throw new Error("exhaustive coverage completion is missing coverage or lost its fence");
    }
  }

  public async terminate(input: {
    readonly checkpointId: string;
    readonly fence: number;
    readonly reason: string;
    readonly signal?: AbortSignal;
    readonly state: "failed" | "invalidated";
  }): Promise<void> {
    if (input.reason.trim().length === 0 || input.reason.length > 500) {
      throw new RangeError("exhaustive coverage terminal reason is invalid");
    }
    const result = await queryHistoricalPostgres(this.pool, {
      text: `
        UPDATE meeting_core.historical_coverage_checkpoints
        SET state = $3, terminal_at = transaction_timestamp(),
            terminal_reason = $4, completed_at = NULL,
            release_bindings = '[]'::jsonb,
            block_locators = '[]'::jsonb,
            coverage_bitmap = '[]'::jsonb,
            extracts = '{}'::jsonb, reduction = NULL,
            updated_at = transaction_timestamp()
        WHERE checkpoint_id = $1 AND lease_fence = $2 AND state = 'active'
      `,
      values: [input.checkpointId, input.fence, input.state, input.reason],
    }, input.signal, this.cancellation);
    if (result.rowCount !== 1) {
      throw new Error("exhaustive coverage termination lost its lease fence");
    }
  }

  public async scrubExpired(
    maximumRows: number,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<number> {
    if (!Number.isSafeInteger(maximumRows) || maximumRows < 1 || maximumRows > 1_000) {
      throw new RangeError("exhaustive coverage scrub bound is invalid");
    }
    const result = await queryHistoricalPostgres(this.pool, {
      text: `
        WITH expired AS (
          SELECT checkpoint_id
          FROM meeting_core.historical_coverage_checkpoints
          WHERE state IN ('active', 'completed')
            AND retention_expires_at <= transaction_timestamp()
          ORDER BY retention_expires_at, checkpoint_id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE meeting_core.historical_coverage_checkpoints AS checkpoint
        SET state = 'invalidated', terminal_at = transaction_timestamp(),
            terminal_reason = 'retention_expired', completed_at = NULL,
            release_bindings = '[]'::jsonb,
            block_locators = '[]'::jsonb,
            coverage_bitmap = '[]'::jsonb,
            extracts = '{}'::jsonb, reduction = NULL,
            updated_at = transaction_timestamp()
        FROM expired
        WHERE checkpoint.checkpoint_id = expired.checkpoint_id
      `,
      values: [maximumRows],
    }, options.signal, this.cancellation);
    return result.rowCount ?? 0;
  }
}

function sameStringSequence(stored: unknown, requested: readonly string[]): boolean {
  const left = strings(stored, "block locators");
  return left.length === requested.length && left.every((value, index) =>
    value === requested[index]
  );
}
