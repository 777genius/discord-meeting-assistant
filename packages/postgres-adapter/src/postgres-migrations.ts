import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";

const migrationFileNames = [
  "0001_create_meeting_core.sql",
  "0002_create_post_call_outbox.sql",
  "0003_create_live_meetings.sql",
  "0004_create_guild_installations.sql",
  "0005_live_meeting_append_only.sql",
  "0006_persistence_integrity.sql",
  "0007_post_call_terminal_settlement.sql",
  "0008_summary_publication_effect_ledger.sql",
] as const;

const migrationLockKey = "718330091620232601";

export const requiredPostgresSchemaVersion = migrationFileNames.length;

export interface PostgresMigration {
  readonly checksumSha256: string;
  readonly fileName: string;
  readonly sql: string;
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
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [migrationLockKey]);
      await ensureMigrationLedger(client);
      const ledger = await listMigrationLedger(client);
      assertLedgerIsKnownAndContiguous(ledger, migrations);

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
        await client.query(migration.sql);
        await client.query(
          `
            INSERT INTO meeting_core.schema_migration_ledger
              (version, checksum_sha256)
            VALUES ($1, $2)
          `,
          [migration.version, migration.checksumSha256],
        );
        appliedVersions.push(migration.version);
      }
      await client.query("COMMIT");
      return Object.freeze({
        appliedVersions: Object.freeze(appliedVersions),
        version: migrations.at(-1)?.version ?? 0,
      });
    } catch (error) {
      await rollback(client);
      if (error instanceof PostgresMigrationError) {
        throw error;
      }
      throw new PostgresMigrationError("PostgreSQL migration failed", { cause: error });
    } finally {
      client.release();
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
  const migrations = await Promise.all(migrationFileNames.map(async (fileName, index) => {
    const sql = await readFile(new URL(fileName, directory), "utf8");
    return Object.freeze({
      checksumSha256: sha256(sql),
      fileName,
      sql,
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

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original migration failure.
  }
}
