import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";

const migrationDefinitions = [
  { fileName: "0001_create_meeting_core.sql" },
  { fileName: "0002_create_post_call_outbox.sql" },
  { fileName: "0003_create_live_meetings.sql" },
  { fileName: "0004_create_guild_installations.sql" },
  { fileName: "0005_live_meeting_append_only.sql" },
  { fileName: "0006_persistence_integrity.sql" },
  { fileName: "0007_post_call_terminal_settlement.sql" },
  { fileName: "0008_summary_publication_effect_ledger.sql" },
  { fileName: "0009_post_call_retryable_recovery.sql" },
  { fileName: "0010_validate_post_call_retryable_recovery.sql" },
  {
    fileName: "0011_create_post_call_recoverable_index.sql",
    transactional: false,
  },
  {
    fileName: "0012_drop_legacy_post_call_recoverable_index.sql",
    transactional: false,
  },
  { fileName: "0013_rename_post_call_recoverable_index.sql" },
  { fileName: "0014_meeting_knowledge_local_final_reply.sql" },
  { fileName: "0015_historical_memory_projection.sql" },
  { fileName: "0016_live_finalized_memory.sql" },
  { fileName: "0017_conversation_one_shot_receipts.sql" },
  { fileName: "0018_answer_delivery_container.sql" },
  { fileName: "0019_greeting_receipt_state_machine.sql" },
  { fileName: "0020_answer_retraction_lifecycle.sql" },
  { fileName: "0021_farewell_receipt_state_machine.sql" },
  { fileName: "0022_meeting_knowledge_withdrawal_tombstones.sql" },
  {
    fileName: "0023_answer_effect_reconciliation_schedule.sql",
    repairInvalidConcurrentIndex: "meeting_core.answer_effects_unresolved_reconciliation_idx",
    transactional: false,
  },
  { fileName: "0024_question_policy_fence.sql" },
  { fileName: "0025_question_provider_attempt_accounting.sql" },
  { fileName: "0026_answer_effect_duplicate_containment.sql" },
  { fileName: "0027_add_transcription_execution_binding.sql" },
  { fileName: "0028_validate_transcription_execution_binding_constraints.sql" },
  {
    fileName: "0029_create_post_call_binding_recoverable_index.sql",
    repairInvalidConcurrentIndex: "meeting_core.post_call_outbox_binding_recoverable_idx",
    transactional: false,
  },
  { fileName: "0030_provider_neutral_meeting_source_routing.sql" },
  { fileName: "0031_historical_memory_profile_rebuild.sql" },
  { fileName: "0032_question_retrieval_binding_worker_fence.sql" },
  { fileName: "0033_greeting_provider_start_fence.sql" },
  { fileName: "0034_recording_publication_reconciliation.sql" },
  { fileName: "0035_retain_answer_reconciliation_payload.sql" },
  { fileName: "0036_validate_answer_reconciliation_payload.sql" },
  { fileName: "0037_live_memory_ambiguous_outcomes.sql" },
  { fileName: "0038_derived_greeting_obligations.sql" },
] as const;

const migrationLockKey = "718330091620232601";
const migrationLockTimeoutMilliseconds = 5_000;
const migrationStatementTimeoutMilliseconds = 300_000;

export const requiredPostgresSchemaVersion = migrationDefinitions.length;

export interface PostgresMigration {
  readonly checksumSha256: string;
  readonly fileName: string;
  readonly sql: string;
  /** Qualified index to drop outside a transaction when a prior concurrent build is invalid. */
  readonly repairInvalidConcurrentIndex?: string;
  /** False only for one-statement, idempotent operations forbidden in a transaction. */
  readonly transactional?: boolean;
  readonly version: number;
}

export interface AppliedPostgresMigrations {
  readonly appliedVersions: readonly number[];
  readonly version: number;
}

interface MigrationLedgerRow {
  readonly checksum_sha256: string;
  readonly version: number;
}

export class PostgresMigrationError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PostgresMigrationError";
  }
}

export class PostgresMigrationRunner {
  public constructor(
    private readonly pool: Pool,
    private readonly options: { readonly migrations?: readonly PostgresMigration[] } = {},
  ) {}

  public async migrate(): Promise<AppliedPostgresMigrations> {
    const migrations = await this.resolveMigrations();
    const client = await this.pool.connect();
    let migrationLockAcquired = false;
    let migrationTimeoutsConfigured = false;
    let transactionActive = false;
    try {
      await configureMigrationTimeouts(client);
      migrationTimeoutsConfigured = true;
      migrationLockAcquired = await tryAcquireMigrationLock(client);
      if (!migrationLockAcquired) {
        throw new PostgresMigrationError(
          "PostgreSQL migration lock is already held; retry the rollout later",
        );
      }
      await client.query("BEGIN");
      transactionActive = true;
      await ensureMigrationLedger(client);
      const ledger = await listMigrationLedger(client);
      assertLedgerIsKnownAndContiguous(ledger, migrations);
      // The session advisory lock remains held, but the ledger transaction must
      // not span multiple migrations. In particular, metadata DDL must commit
      // before a following validation scan starts so ACCESS EXCLUSIVE locks are
      // released at the intended online-migration boundary.
      await client.query("COMMIT");
      transactionActive = false;

      const appliedVersions: number[] = [];
      const ledgerByVersion = new Map(ledger.map((entry) => [entry.version, entry]));
      for (const migration of migrations) {
        const existing = ledgerByVersion.get(migration.version);
        if (existing !== undefined) {
          if (existing.checksum_sha256 !== migration.checksumSha256) {
            throw new PostgresMigrationError(
              `migration ${migration.version} checksum drift: database=${existing.checksum_sha256} source=${migration.checksumSha256}`,
            );
          }
          continue;
        }
        if (migration.transactional === false) {
          if (migration.repairInvalidConcurrentIndex !== undefined) {
            await dropInvalidConcurrentIndex(
              client,
              migration.repairInvalidConcurrentIndex,
            );
          }
          await client.query(migration.sql);
        } else {
          await client.query("BEGIN");
          transactionActive = true;
          await client.query(migration.sql);
        }
        if (!transactionActive) {
          await client.query("BEGIN");
          transactionActive = true;
        }
        await client.query(
          `
            INSERT INTO meeting_core.schema_migration_ledger
              (version, checksum_sha256)
            VALUES ($1, $2)
          `,
          [migration.version, migration.checksumSha256],
        );
        await client.query("COMMIT");
        transactionActive = false;
        appliedVersions.push(migration.version);
      }
      return Object.freeze({
        appliedVersions: Object.freeze(appliedVersions),
        version: migrations.at(-1)?.version ?? 0,
      });
    } catch (error) {
      if (transactionActive) {
        await rollback(client);
      }
      if (error instanceof PostgresMigrationError) {
        throw error;
      }
      throw new PostgresMigrationError("PostgreSQL migration failed", { cause: error });
    } finally {
      const migrationLockReleased = !migrationLockAcquired
        || await releaseMigrationLock(client);
      const migrationTimeoutsReset = !migrationTimeoutsConfigured
        || await resetMigrationTimeouts(client);
      client.release(!(migrationLockReleased && migrationTimeoutsReset));
    }
  }

  private resolveMigrations(): Promise<readonly PostgresMigration[]> {
    return this.options.migrations === undefined
      ? loadPostgresMigrations()
      : Promise.resolve(validateMigrations(this.options.migrations));
  }
}

export async function loadPostgresMigrations(): Promise<readonly PostgresMigration[]> {
  const directory = new URL("../../../infra/postgres/migrations/", import.meta.url);
  const migrations = await Promise.all(migrationDefinitions.map(async (definition, index) => {
    const sql = await readFile(new URL(definition.fileName, directory), "utf8");
    return Object.freeze({
      checksumSha256: sha256(sql),
      fileName: definition.fileName,
      sql,
      ...("repairInvalidConcurrentIndex" in definition
        ? { repairInvalidConcurrentIndex: definition.repairInvalidConcurrentIndex }
        : {}),
      transactional: "transactional" in definition
        ? definition.transactional
        : true,
      version: index + 1,
    });
  }));
  return validateMigrations(migrations);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateMigrations(
  candidate: readonly PostgresMigration[],
): readonly PostgresMigration[] {
  const migrations = candidate.toSorted((left, right) => left.version - right.version);
  for (const [index, migration] of migrations.entries()) {
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new PostgresMigrationError(
        `migration versions must start at 1 without gaps; expected ${expectedVersion}, received ${migration.version}`,
      );
    }
    if (!/^[a-f0-9]{64}$/u.test(migration.checksumSha256)) {
      throw new PostgresMigrationError(
        `migration ${migration.version} has an invalid SHA-256 checksum`,
      );
    }
    if (containsTransactionControl(migration.sql)) {
      throw new PostgresMigrationError(
        `migration ${migration.version} must not contain transaction control; the runner owns atomicity`,
      );
    }
    if (
      migration.repairInvalidConcurrentIndex !== undefined
      && (
        migration.transactional !== false
        || !/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/u.test(
          migration.repairInvalidConcurrentIndex,
        )
      )
    ) {
      throw new PostgresMigrationError(
        `migration ${migration.version} has an invalid concurrent-index repair target`,
      );
    }
  }
  return Object.freeze(migrations);
}

export async function readMigrationLedger(
  pool: Pick<Pool, "query">,
): Promise<readonly { readonly checksumSha256: string; readonly version: number }[]> {
  const result = await pool.query<MigrationLedgerRow>(
    `
      SELECT version, checksum_sha256
      FROM meeting_core.schema_migration_ledger
      ORDER BY version
    `,
  );
  return Object.freeze(result.rows.map((row) => Object.freeze({
    checksumSha256: row.checksum_sha256,
    version: row.version,
  })));
}

async function ensureMigrationLedger(client: PoolClient): Promise<void> {
  await client.query("CREATE SCHEMA IF NOT EXISTS meeting_core");
  await client.query(`
    CREATE TABLE IF NOT EXISTS meeting_core.schema_migration_ledger (
      version integer PRIMARY KEY,
      checksum_sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      CONSTRAINT schema_migration_ledger_version_is_positive
        CHECK ((version > 0) IS TRUE),
      CONSTRAINT schema_migration_ledger_checksum_is_sha256
        CHECK ((checksum_sha256 ~ '^[a-f0-9]{64}$') IS TRUE)
    )
  `);
}

async function listMigrationLedger(client: PoolClient): Promise<readonly MigrationLedgerRow[]> {
  const result = await client.query<MigrationLedgerRow>(`
    SELECT version, checksum_sha256
    FROM meeting_core.schema_migration_ledger
    ORDER BY version
    FOR UPDATE
  `);
  return result.rows;
}

function assertLedgerIsKnownAndContiguous(
  ledger: readonly MigrationLedgerRow[],
  migrations: readonly PostgresMigration[],
): void {
  const expectedVersions = new Set(migrations.map(({ version }) => version));
  let previousVersion = 0;
  for (const entry of ledger) {
    if (!expectedVersions.has(entry.version)) {
      throw new PostgresMigrationError(
        `migration ledger contains unsupported version ${entry.version}`,
      );
    }
    if (entry.version !== previousVersion + 1) {
      throw new PostgresMigrationError(
        `migration ledger gap before version ${entry.version}`,
      );
    }
    previousVersion = entry.version;
  }
}

function containsTransactionControl(sql: string): boolean {
  return /^\s*(?:BEGIN|COMMIT|ROLLBACK)(?:\s+(?:WORK|TRANSACTION))?\s*;/imu.test(sql);
}

async function dropInvalidConcurrentIndex(
  client: PoolClient,
  qualifiedIndexName: string,
): Promise<void> {
  const [schemaName, indexName] = qualifiedIndexName.split(".");
  if (schemaName === undefined || indexName === undefined) {
    throw new PostgresMigrationError("invalid concurrent-index repair target");
  }
  const result = await client.query<{ readonly invalid: boolean }>(
    `
      SELECT NOT (target_index.indisvalid AND target_index.indisready) AS invalid
      FROM pg_index AS target_index
      JOIN pg_class AS relation ON relation.oid = target_index.indexrelid
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
        AND relation.relname = $2
    `,
    [schemaName, indexName],
  );
  if (result.rows[0]?.invalid === true) {
    await client.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "${schemaName}"."${indexName}"`,
    );
  }
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original migration failure.
  }
}

async function configureMigrationTimeouts(client: PoolClient): Promise<void> {
  await client.query(
    `
      SELECT set_config('lock_timeout', $1, false),
             set_config('statement_timeout', $2, false)
    `,
    [
      `${migrationLockTimeoutMilliseconds}ms`,
      `${migrationStatementTimeoutMilliseconds}ms`,
    ],
  );
}

async function tryAcquireMigrationLock(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ readonly acquired: boolean }>(
    "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
    [migrationLockKey],
  );
  return result.rows[0]?.acquired === true;
}

async function releaseMigrationLock(client: PoolClient): Promise<boolean> {
  try {
    const result = await client.query<{ readonly unlocked: boolean }>(
      "SELECT pg_advisory_unlock($1::bigint) AS unlocked",
      [migrationLockKey],
    );
    return result.rows[0]?.unlocked === true;
  } catch {
    return false;
  }
}

async function resetMigrationTimeouts(client: PoolClient): Promise<boolean> {
  try {
    await client.query("RESET lock_timeout");
    await client.query("RESET statement_timeout");
    return true;
  } catch {
    return false;
  }
}
