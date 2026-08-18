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
  it("commits each migration and its receipt before starting the next one", async (context) => {
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
      expect(result.rows).toEqual([{
        ledger: "meeting_core.schema_migration_ledger",
        probe: "meeting_core.migration_atomicity_probe",
      }]);
      const ledger = await isolated.pool.query<{
        readonly version: number;
      }>("SELECT version FROM meeting_core.schema_migration_ledger ORDER BY version");
      expect(ledger.rows).toEqual([{ version: 1 }]);
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

  it("fails immediately when another migration runner owns the advisory lock", async (context) => {
    databaseOrSkip(context);
    const isolated = await createIsolatedDatabase();
    const blocker = await isolated.pool.connect();
    const migrationLockKey = "718330091620232601";
    try {
      await blocker.query("SELECT pg_advisory_lock($1::bigint)", [migrationLockKey]);
      const startedAt = performance.now();
      await expect(new PostgresMigrationRunner(isolated.pool).migrate()).rejects.toThrow(
        "migration lock is already held",
      );
      expect(performance.now() - startedAt).toBeLessThan(2_000);
      const settings = await isolated.pool.query<{
        readonly lock_timeout: string;
        readonly statement_timeout: string;
      }>(`
        SELECT current_setting('lock_timeout') AS lock_timeout,
               current_setting('statement_timeout') AS statement_timeout
      `);
      expect(settings.rows).toEqual([{
        lock_timeout: "0",
        statement_timeout: "0",
      }]);
    } finally {
      await blocker.query("SELECT pg_advisory_unlock($1::bigint)", [migrationLockKey]);
      blocker.release();
      await isolated.dispose();
    }
  });

});

describe("Postgres concurrent index recovery", () => {
  it("repairs an invalid index left by a failed concurrent build", async (context) => {
    databaseOrSkip(context);
    const isolated = await createIsolatedDatabase();
    const indexSql = `
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS online_migration_repair_idx
      ON meeting_core.online_migration_repair_probe (duplicate_key);
    `;
    try {
      await isolated.pool.query("CREATE SCHEMA meeting_core");
      await isolated.pool.query(`
        CREATE TABLE meeting_core.online_migration_repair_probe (
          id integer PRIMARY KEY,
          duplicate_key integer NOT NULL
        )
      `);
      await isolated.pool.query(`
        INSERT INTO meeting_core.online_migration_repair_probe (id, duplicate_key)
        VALUES (1, 7), (2, 7)
      `);
      await expect(isolated.pool.query(indexSql)).rejects.toThrow();
      const invalid = await isolated.pool.query<{
        readonly indisready: boolean;
        readonly indisvalid: boolean;
      }>(`
        SELECT indisready, indisvalid
        FROM pg_index
        WHERE indexrelid = 'meeting_core.online_migration_repair_idx'::regclass
      `);
      expect(invalid.rows).toEqual([{ indisready: false, indisvalid: false }]);

      await isolated.pool.query(
        "DELETE FROM meeting_core.online_migration_repair_probe WHERE id = 2",
      );
      const runner = new PostgresMigrationRunner(isolated.pool, {
        migrations: [{
          checksumSha256: sha256(indexSql),
          fileName: "0001_online_migration_repair.sql",
          repairInvalidConcurrentIndex: "meeting_core.online_migration_repair_idx",
          sql: indexSql,
          transactional: false,
          version: 1,
        }],
      });

      await expect(runner.migrate()).resolves.toEqual({
        appliedVersions: [1],
        version: 1,
      });
      const repaired = await isolated.pool.query<{
        readonly indisready: boolean;
        readonly indisvalid: boolean;
      }>(`
        SELECT indisready, indisvalid
        FROM pg_index
        WHERE indexrelid = 'meeting_core.online_migration_repair_idx'::regclass
      `);
      expect(repaired.rows).toEqual([{ indisready: true, indisvalid: true }]);
      await expect(runner.migrate()).resolves.toEqual({
        appliedVersions: [],
        version: 1,
      });
    } finally {
      await isolated.dispose();
    }
  });

});

describe("PostgresMigrationRunner and PostgresSchemaReadiness validation", () => {
  it("records the exact migration ledger and accepts a fully validated schema", async (context) => {
    const database = databaseOrSkip(context);

    expect(await new PostgresMigrationRunner(database).migrate()).toEqual({
      appliedVersions: [],
      version: requiredPostgresSchemaVersion,
    });
    await expect(new PostgresSchemaReadiness(database).assertReady()).resolves.toBeUndefined();
  });

  it("rejects a replica-only immutable binding trigger", async (context) => {
    const database = databaseOrSkip(context);
    await database.query(`
      ALTER TABLE meeting_core.post_call_outbox
      ENABLE REPLICA TRIGGER post_call_outbox_transcription_execution_binding_is_immutable
    `);
    try {
      await expect(new PostgresSchemaReadiness(database).assertReady()).rejects.toThrow(
        "required PostgreSQL trigger is missing or disabled",
      );
    } finally {
      await database.query(`
        ALTER TABLE meeting_core.post_call_outbox
        ENABLE TRIGGER post_call_outbox_transcription_execution_binding_is_immutable
      `);
    }
  });

  it("treats a pre-binding binary after migration 0027 as a stop-only rollback boundary", async (context) => {
    const database = databaseOrSkip(context);
    const migrations = await loadPostgresMigrations();
    const bindingMigrationVersion = 27;
    expect(migrations.find(({ version }) => version === bindingMigrationVersion)?.fileName)
      .toBe("0027_add_transcription_execution_binding.sql");
    const preBindingMigrations = migrations.filter(
      ({ version }) => version < bindingMigrationVersion,
    );
    const preBindingVersion = preBindingMigrations.at(-1)?.version;
    if (preBindingVersion === undefined) {
      throw new Error("pre-binding migration fixture is missing");
    }

    await expect(new PostgresSchemaReadiness(database, {
      migrations: preBindingMigrations,
      requiredVersion: preBindingVersion,
    }).assertReady()).rejects.toThrow(
      `migration ledger has ${migrations.length} receipts; expected ${preBindingMigrations.length}`,
    );
  });

  it("rejects a required index that exists but is not valid and ready", async (context) => {
    const database = databaseOrSkip(context);
    const migrations = await loadPostgresMigrations();
    const reconciliationMigration = migrations.find(({ fileName }) =>
      fileName === "0023_answer_effect_reconciliation_schedule.sql"
    );
    if (reconciliationMigration?.version !== 23) {
      throw new Error("required reconciliation migration was not loaded");
    }

    await database.query(`
      INSERT INTO meeting_core.answer_effects (
        effect_id, state, projection_target_container_id,
        delivery_container_id, reply_to_remote_message_id, marker,
        payload_bytes, payload_hash, binding_hash, authorization_digest,
        source_meeting_ids, request_started_at
      )
      SELECT
        'meeting-knowledge-answer:v1:invalid-index-' || sequence,
        'outcome_unknown',
        'projection-invalid-index',
        'delivery-invalid-index',
        '66666666666666666' || sequence,
        'marker-invalid-index-' || sequence,
        '{}',
        repeat('a', 64),
        repeat('b', 64),
        repeat('c', 64),
        ARRAY['meeting-invalid-index']::text[],
        transaction_timestamp() - interval '3 minutes'
      FROM generate_series(1, 2) AS sequence
    `);
    await database.query(
      "DROP INDEX CONCURRENTLY meeting_core.answer_effects_unresolved_reconciliation_idx",
    );
    try {
      await expect(database.query(`
        CREATE UNIQUE INDEX CONCURRENTLY answer_effects_unresolved_reconciliation_idx
        ON meeting_core.answer_effects (state)
      `)).rejects.toThrow();
      const invalid = await database.query<{
        readonly indisready: boolean;
        readonly indisvalid: boolean;
      }>(`
        SELECT indisready, indisvalid
        FROM pg_index
        WHERE indexrelid =
          'meeting_core.answer_effects_unresolved_reconciliation_idx'::regclass
      `);
      expect(invalid.rows).toEqual([{ indisready: false, indisvalid: false }]);

      await expect(new PostgresSchemaReadiness(database).assertReady()).rejects.toThrow(
        "required PostgreSQL index is missing or invalid",
      );
    } finally {
      await database.query(
        "DROP INDEX CONCURRENTLY IF EXISTS meeting_core.answer_effects_unresolved_reconciliation_idx",
      );
      await database.query(reconciliationMigration.sql);
    }
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
