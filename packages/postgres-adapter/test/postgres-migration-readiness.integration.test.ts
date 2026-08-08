import {
  describe,
  expect,
  it,
} from "vitest";

import {
  createIsolatedDatabase,
  databaseOrSkip,
  usePostgresIntegrationDatabase,
} from "./postgres-integration-fixtures.js";
import {
  PostgresMigrationRunner,
  PostgresSchemaReadiness,
  PostgresSchemaReadinessError,
  loadPostgresMigrations,
  requiredPostgresSchemaVersion,
  sha256,
} from "../src/index.js";

usePostgresIntegrationDatabase();

describe("PostgresMigrationRunner and PostgresSchemaReadiness", () => {
  it("rolls migration side effects and ledger receipts back as one transaction", async (context) => {
    databaseOrSkip(context);
    const isolated = await createIsolatedDatabase();
    const firstSql = "CREATE TABLE meeting_core.migration_atomicity_probe (id integer PRIMARY KEY);";
    const failingSql = "INSERT INTO meeting_core.migration_atomicity_probe (id) VALUES (1); SELECT missing_column FROM missing_table;";
    try {
      const runner = new PostgresMigrationRunner(isolated.pool, {
        migrations: [
          {
            checksumSha256: sha256(firstSql),
            fileName: "0001_atomicity_probe.sql",
            sql: firstSql,
            version: 1,
          },
          {
            checksumSha256: sha256(failingSql),
            fileName: "0002_atomicity_failure.sql",
            sql: failingSql,
            version: 2,
          },
        ],
      });

      await expect(runner.migrate()).rejects.toThrow("PostgreSQL migration failed");
      const result = await isolated.pool.query<{
        readonly ledger: string | null;
        readonly probe: string | null;
      }>(`
        SELECT to_regclass('meeting_core.schema_migration_ledger')::text AS ledger,
               to_regclass('meeting_core.migration_atomicity_probe')::text AS probe
      `);
      expect(result.rows).toEqual([{ ledger: null, probe: null }]);
    } finally {
      await isolated.dispose();
    }
  });

  it("runs an idempotent online migration outside a transaction", async (context) => {
    databaseOrSkip(context);
    const isolated = await createIsolatedDatabase();
    const tableSql = `
      CREATE TABLE meeting_core.online_migration_probe (
        id integer PRIMARY KEY,
        ready boolean NOT NULL DEFAULT false
      );
    `;
    const indexSql = `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS online_migration_probe_ready_idx
      ON meeting_core.online_migration_probe (id)
      WHERE ready IS FALSE;
    `;
    try {
      const runner = new PostgresMigrationRunner(isolated.pool, {
        migrations: [
          {
            checksumSha256: sha256(tableSql),
            fileName: "0001_online_probe.sql",
            sql: tableSql,
            version: 1,
          },
          {
            checksumSha256: sha256(indexSql),
            fileName: "0002_online_probe_index.sql",
            sql: indexSql,
            transactional: false,
            version: 2,
          },
        ],
      });

      await expect(runner.migrate()).resolves.toEqual({
        appliedVersions: [1, 2],
        version: 2,
      });
      await expect(runner.migrate()).resolves.toEqual({
        appliedVersions: [],
        version: 2,
      });
      const index = await isolated.pool.query<{
        readonly indisready: boolean;
        readonly indisvalid: boolean;
      }>(`
        SELECT indisready, indisvalid
        FROM pg_index
        WHERE indexrelid =
          'meeting_core.online_migration_probe_ready_idx'::regclass
      `);
      expect(index.rows).toEqual([{ indisready: true, indisvalid: true }]);
    } finally {
      await isolated.dispose();
    }
  });

  it("records the exact migration ledger and accepts a fully validated schema", async (context) => {
    const database = databaseOrSkip(context);

    expect(await new PostgresMigrationRunner(database).migrate()).toEqual({
      appliedVersions: [],
      version: requiredPostgresSchemaVersion,
    });
    await expect(new PostgresSchemaReadiness(database).assertReady()).resolves.toBeUndefined();
  });

  it("rejects checksum drift, ledger gaps, and a non-validated required check", async (context) => {
    const database = databaseOrSkip(context);
    const migrations = await loadPostgresMigrations();
    const first = migrations[0];
    const third = migrations[2];
    if (first === undefined || third === undefined) {
      throw new Error("required test migrations were not loaded");
    }

    await database.query(
      "UPDATE meeting_core.schema_migration_ledger SET checksum_sha256 = $1 WHERE version = $2",
      ["f".repeat(64), first.version],
    );
    try {
      await expect(new PostgresMigrationRunner(database).migrate()).rejects.toThrow(
        "checksum drift",
      );
      await expect(new PostgresSchemaReadiness(database).assertReady()).rejects.toBeInstanceOf(
        PostgresSchemaReadinessError,
      );
    } finally {
      await database.query(
        "UPDATE meeting_core.schema_migration_ledger SET checksum_sha256 = $1 WHERE version = $2",
        [first.checksumSha256, first.version],
      );
    }

    await database.query(
      "DELETE FROM meeting_core.schema_migration_ledger WHERE version = $1",
      [third.version],
    );
    try {
      await expect(new PostgresMigrationRunner(database).migrate()).rejects.toThrow(
        `ledger gap before version ${third.version + 1}`,
      );
    } finally {
      await database.query(
        "INSERT INTO meeting_core.schema_migration_ledger (version, checksum_sha256) VALUES ($1, $2)",
        [third.version, third.checksumSha256],
      );
    }

    await database.query(`
      ALTER TABLE meeting_core.post_call_dead_letters
      DROP CONSTRAINT post_call_dead_letters_schema_version_is_supported
    `);
    await database.query(`
      ALTER TABLE meeting_core.post_call_dead_letters
      ADD CONSTRAINT post_call_dead_letters_schema_version_is_supported
      CHECK ((schema_version = 1) IS TRUE) NOT VALID
    `);
    try {
      await expect(new PostgresSchemaReadiness(database).assertReady()).rejects.toThrow(
        "required PostgreSQL check constraint is missing or invalid",
      );
    } finally {
      await database.query(`
        ALTER TABLE meeting_core.post_call_dead_letters
        DROP CONSTRAINT post_call_dead_letters_schema_version_is_supported
      `);
      await database.query(`
        ALTER TABLE meeting_core.post_call_dead_letters
        ADD CONSTRAINT post_call_dead_letters_schema_version_is_supported
        CHECK ((schema_version = 1) IS TRUE)
      `);
    }

    await database.query(
      "ALTER TABLE meeting_core.post_call_outbox DROP COLUMN last_enqueued_at",
    );
    try {
      await expect(new PostgresSchemaReadiness(database).assertReady()).rejects.toThrow(
        "required PostgreSQL column is missing",
      );
    } finally {
      await database.query(
        "ALTER TABLE meeting_core.post_call_outbox ADD COLUMN last_enqueued_at timestamptz",
      );
    }
  });
});
