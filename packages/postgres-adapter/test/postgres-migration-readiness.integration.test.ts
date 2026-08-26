import {
  describe,
  expect,
  it,
} from "vitest";
import type { Pool } from "pg";

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

async function seedLegacyQuestionPolicyDrain(database: Pool): Promise<void> {
  await database.query(
    `INSERT INTO meeting_knowledge.current_question_policy (
       policy_key, policy_epoch, policy_version, authorization_policy_version
     ) VALUES (
       'local-final-reply', 2,
       'meeting-knowledge.focused-memory-final-reply.v3',
       'discord.participant-current-results.v2'
     );
     INSERT INTO meeting_knowledge.question_jobs (
       question_id, requester_subject, question_hash, scope_id,
       final_projection_receipt, authorization_principal_ref,
       authorization_digest, locale, question_text, binding, binding_hash,
       policy_epoch, expires_at
     ) VALUES (
       'legacy-policy-drain', repeat('a', 64), repeat('b', 64), 'scope-1',
       'receipt-1', 'principal-1', repeat('c', 64), 'en', 'Question?',
       '{"policyVersion":"meeting-knowledge.focused-memory-final-reply.v3","authorizationPolicyVersion":"discord.participant-current-results.v2"}'::jsonb,
       repeat('d', 64), 2, transaction_timestamp() + interval '10 minutes'
     );`,
  );
}

async function expectBindingAwareQuestionPolicy(database: Pool): Promise<void> {
  const questionPolicy = await database.query(
    `SELECT policy_epoch::int AS policy_epoch, policy_version,
            authorization_policy_version
     FROM meeting_knowledge.current_question_policy
     WHERE policy_key = 'local-final-reply'`,
  );
  expect(questionPolicy.rows).toEqual([{
    authorization_policy_version: "discord.participant-current-results.v2",
    policy_epoch: 3,
    policy_version: "meeting-knowledge.focused-memory-final-reply.v3",
  }]);
  await expect(database.query(
    `SELECT policy_epoch::int AS policy_epoch
     FROM meeting_knowledge.question_jobs
     WHERE question_id = 'legacy-policy-drain'`,
  )).resolves.toMatchObject({ rows: [{ policy_epoch: 3 }] });
}

async function waitForAnswerEffectMigrationFence(database: Pool): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await database.query<{ readonly waiting: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_locks
        WHERE locktype = 'relation'
          AND relation = 'meeting_core.answer_effects'::regclass
          AND mode = 'ShareRowExclusiveLock'
          AND NOT granted
      ) AS waiting
    `);
    if (result.rows[0]?.waiting === true) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("migration did not reach the pre-scan answer-effect fence");
}

const canonicalAnswerPayloadTrigger = `
  CREATE TRIGGER answer_effects_unresolved_payload_is_immutable
  BEFORE UPDATE OF state, payload_bytes, payload_hash
  ON meeting_core.answer_effects
  FOR EACH ROW
  EXECUTE FUNCTION meeting_core.prevent_unresolved_answer_payload_mutation_v1()
`;

async function expectAnswerPayloadTriggerWiringDrift(
  database: Pool,
  driftedTrigger: string,
): Promise<void> {
  await database.query(`
    DROP TRIGGER answer_effects_unresolved_payload_is_immutable
    ON meeting_core.answer_effects
  `);
  await database.query(driftedTrigger);
  try {
    await expect(new PostgresSchemaReadiness(database).assertReady()).rejects.toThrow(
      "answer reconciliation payload trigger wiring does not match v1",
    );
  } finally {
    await database.query(`
      DROP TRIGGER IF EXISTS answer_effects_unresolved_payload_is_immutable
      ON meeting_core.answer_effects;
      DROP TRIGGER IF EXISTS answer_effects_unresolved_payload_is_immutable
      ON meeting_core.answer_effect_reconciliation_quarantine;
    `);
    await database.query(canonicalAnswerPayloadTrigger);
  }
  await expect(new PostgresSchemaReadiness(database).assertReady()).resolves.toBeUndefined();
}

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

// oxlint-disable-next-line max-lines-per-function
describe("PostgresMigrationRunner and PostgresSchemaReadiness validation", () => {
  it("quarantines an old-worker scrub committed at the pre-scan fence", async (context) => {
    databaseOrSkip(context);
    const isolated = await createIsolatedDatabase();
    const migrations = await loadPostgresMigrations();
    const oldWorker = await isolated.pool.connect();
    try {
      await new PostgresMigrationRunner(isolated.pool, {
        migrations: migrations.slice(0, 34),
      }).migrate();
      await isolated.pool.query(`
        INSERT INTO meeting_knowledge.question_jobs (
          question_id, requester_subject, question_hash, scope_id,
          final_projection_receipt, authorization_principal_ref,
          authorization_digest, locale, question_text, binding, binding_hash,
          state, expires_at
        ) VALUES (
          'migration-race-effect', repeat('a', 64), repeat('b', 64),
          '77777777777777777', 'projection-race', 'opaque-race',
          repeat('c', 64), 'en', 'Question?', '{}'::jsonb, repeat('d', 64),
          'queued', transaction_timestamp() + interval '10 minutes'
        );
        INSERT INTO meeting_core.answer_effects (
          effect_id, state, projection_target_container_id,
          delivery_container_id, reply_to_remote_message_id, marker,
          payload_bytes, payload_hash, binding_hash, authorization_digest,
          source_meeting_ids, request_started_at
        ) VALUES (
          'meeting-knowledge-answer:v1:migration-race-effect',
          'outcome_unknown', '88888888888888888', '88888888888888888',
          '99999999999999999', 'migration-race-marker',
          '{"request":"immutable"}', repeat('e', 64), repeat('d', 64),
          repeat('c', 64), ARRAY['migration-race-source']::text[],
          transaction_timestamp()
        )
      `);
      await oldWorker.query("BEGIN");
      await oldWorker.query(`
        UPDATE meeting_core.answer_effects SET updated_at = updated_at
        WHERE effect_id = 'meeting-knowledge-answer:v1:migration-race-effect'
      `);
      const migration = new PostgresMigrationRunner(isolated.pool).migrate();
      await waitForAnswerEffectMigrationFence(isolated.pool);
      await oldWorker.query(`
        UPDATE meeting_core.answer_effects
        SET state = 'absent_unconfirmed', payload_bytes = '{}'
        WHERE effect_id = 'meeting-knowledge-answer:v1:migration-race-effect'
      `);
      await oldWorker.query("COMMIT");
      await expect(migration).resolves.toMatchObject({
        appliedVersions: [35, 36, 37, 38],
      });
      await expect(isolated.pool.query(`
        SELECT effect.state, quarantine.prior_state, quarantine.reason
        FROM meeting_core.answer_effects AS effect
        JOIN meeting_core.answer_effect_reconciliation_quarantine AS quarantine
          USING (effect_id)
        WHERE effect.effect_id = 'meeting-knowledge-answer:v1:migration-race-effect'
      `)).resolves.toMatchObject({ rows: [{
        prior_state: "absent_unconfirmed",
        reason: "legacy_payload_scrubbed_before_0035",
        state: "quarantined_unrecoverable",
      }] });
    } finally {
      await oldWorker.query("ROLLBACK").catch(() => {});
      oldWorker.release();
      await isolated.dispose();
    }
  }, 30_000);

  it("fails closed on legacy played greetings instead of fabricating provider start", async (context) => {
    databaseOrSkip(context);
    const isolated = await createIsolatedDatabase();
    const migrations = await loadPostgresMigrations();
    try {
      await new PostgresMigrationRunner(isolated.pool, {
        migrations: migrations.slice(0, 32),
      }).migrate();
      await isolated.pool.query(`
        INSERT INTO meeting_core.conversation_one_shot_receipts (
          receipt_id, cue_kind, state, completed_at
        ) VALUES (repeat('a', 64), 'greeting', 'played', transaction_timestamp())
      `);

      const failure = await new PostgresMigrationRunner(isolated.pool, { migrations }).migrate()
        .then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) {
        throw new TypeError("Expected migration failure");
      }
      expect(failure.message).toBe("PostgreSQL migration failed");
      expect(failure.cause).toBeInstanceOf(Error);
      if (!(failure.cause instanceof Error)) {
        throw new TypeError("Expected migration failure cause");
      }
      expect(failure.cause.message).toContain("ambiguous or unattested legacy receipts");
      await expect(isolated.pool.query(`
        SELECT provider_started_at
        FROM meeting_core.conversation_one_shot_receipts
      `)).rejects.toThrow("provider_started_at");
    } finally {
      await isolated.dispose();
    }
  });

  it("migrates existing Discord routing snapshots without changing route meaning", async (context) => {
    databaseOrSkip(context);
    const isolated = await createIsolatedDatabase();
    const migrations = await loadPostgresMigrations();
    try {
      await new PostgresMigrationRunner(isolated.pool, {
        migrations: migrations.slice(0, 29),
      }).migrate();
      await isolated.pool.query(
        `
          INSERT INTO guild_configuration.guild_installations
            (guild_id, revision, snapshot)
          VALUES ($1, $2, $3::jsonb)
        `,
        [
          "guild-1",
          4,
          {
            configuredByUserId: "user-1",
            guildId: "guild-1",
            resultsChannelId: "results-1",
            revision: 4,
            status: "active",
            voiceChannelId: "voice-1",
          },
        ],
      );
      await seedLegacyQuestionPolicyDrain(isolated.pool);

      await expect(new PostgresMigrationRunner(isolated.pool, {
        migrations,
      }).migrate()).resolves.toEqual({
        appliedVersions: [30, 31, 32, 33, 34, 35, 36, 37, 38],
        version: 38,
      });
      await expectBindingAwareQuestionPolicy(isolated.pool);
      const migrated = await isolated.pool.query(
        "SELECT source_id, revision::float8 AS revision, snapshot FROM meeting_routing.source_configurations",
      );
      expect(migrated.rows).toEqual([{
        revision: 4,
        snapshot: {
          configuredByActorId: "user-1",
          publicationTargetId: "results-1",
          revision: 4,
          roomId: "voice-1",
          sourceId: "guild-1",
          status: "active",
        },
        source_id: "guild-1",
      }]);
      await expect(new PostgresSchemaReadiness(isolated.pool).assertReady())
        .resolves.toBeUndefined();
    } finally {
      await isolated.dispose();
    }
  }, 30_000);

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

  it("rejects trigger-body drift even when the required trigger name remains enabled", async (context) => {
    const database = databaseOrSkip(context);
    const original = await database.query<{ readonly definition: string }>(`
      SELECT pg_get_functiondef(
        'meeting_core.prevent_unresolved_answer_payload_mutation_v1()'::regprocedure
      ) AS definition
    `);
    const definition = original.rows[0]?.definition;
    if (definition === undefined) {
      throw new Error("answer payload fence definition is unavailable");
    }
    await database.query(`
      CREATE OR REPLACE FUNCTION meeting_core.prevent_unresolved_answer_payload_mutation_v1()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$
    `);
    try {
      await expect(new PostgresSchemaReadiness(database).assertReady()).rejects.toThrow(
        "trigger function definition/version does not match v1",
      );
    } finally {
      await database.query(definition);
    }
    await expect(new PostgresSchemaReadiness(database).assertReady()).resolves.toBeUndefined();
  });

  it("rejects a retained-answer-payload trigger wired to the wrong function OID", async (context) => {
    const database = databaseOrSkip(context);
    await database.query(`
      CREATE OR REPLACE FUNCTION meeting_core.wrong_answer_payload_trigger_v1()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$
    `);
    try {
      await expectAnswerPayloadTriggerWiringDrift(database, `
        CREATE TRIGGER answer_effects_unresolved_payload_is_immutable
        BEFORE UPDATE OF state, payload_bytes, payload_hash
        ON meeting_core.answer_effects FOR EACH ROW
        EXECUTE FUNCTION meeting_core.wrong_answer_payload_trigger_v1()
      `);
    } finally {
      await database.query("DROP FUNCTION meeting_core.wrong_answer_payload_trigger_v1()");
    }
  });

  it("rejects a disabled retained-answer-payload trigger", async (context) => {
    const database = databaseOrSkip(context);
    await database.query(`
      ALTER TABLE meeting_core.answer_effects
      DISABLE TRIGGER answer_effects_unresolved_payload_is_immutable
    `);
    try {
      await expect(new PostgresSchemaReadiness(database).assertReady()).rejects.toThrow(
        "answer reconciliation payload trigger wiring does not match v1",
      );
    } finally {
      await database.query(`
        ALTER TABLE meeting_core.answer_effects
        ENABLE TRIGGER answer_effects_unresolved_payload_is_immutable
      `);
    }
  });

  it("rejects retained-answer-payload trigger timing, level, event, mask, and relation drift", async (context) => {
    const database = databaseOrSkip(context);
    const driftedTriggers = [
    ["AFTER timing", `
      CREATE TRIGGER answer_effects_unresolved_payload_is_immutable
      AFTER UPDATE OF state, payload_bytes, payload_hash
      ON meeting_core.answer_effects FOR EACH ROW
      EXECUTE FUNCTION meeting_core.prevent_unresolved_answer_payload_mutation_v1()
    `],
    ["FOR EACH STATEMENT level", `
      CREATE TRIGGER answer_effects_unresolved_payload_is_immutable
      BEFORE UPDATE OF state, payload_bytes, payload_hash
      ON meeting_core.answer_effects FOR EACH STATEMENT
      EXECUTE FUNCTION meeting_core.prevent_unresolved_answer_payload_mutation_v1()
    `],
    ["INSERT event", `
      CREATE TRIGGER answer_effects_unresolved_payload_is_immutable
      BEFORE INSERT ON meeting_core.answer_effects FOR EACH ROW
      EXECUTE FUNCTION meeting_core.prevent_unresolved_answer_payload_mutation_v1()
    `],
    ["missing UPDATE OF column", `
      CREATE TRIGGER answer_effects_unresolved_payload_is_immutable
      BEFORE UPDATE OF state, payload_bytes
      ON meeting_core.answer_effects FOR EACH ROW
      EXECUTE FUNCTION meeting_core.prevent_unresolved_answer_payload_mutation_v1()
    `],
    ["extra UPDATE OF column", `
      CREATE TRIGGER answer_effects_unresolved_payload_is_immutable
      BEFORE UPDATE OF state, payload_bytes, payload_hash, updated_at
      ON meeting_core.answer_effects FOR EACH ROW
      EXECUTE FUNCTION meeting_core.prevent_unresolved_answer_payload_mutation_v1()
    `],
    ["unmasked UPDATE event", `
      CREATE TRIGGER answer_effects_unresolved_payload_is_immutable
      BEFORE UPDATE ON meeting_core.answer_effects FOR EACH ROW
      EXECUTE FUNCTION meeting_core.prevent_unresolved_answer_payload_mutation_v1()
    `],
    ["wrong relation", `
      CREATE TRIGGER answer_effects_unresolved_payload_is_immutable
      BEFORE UPDATE OF prior_state, payload_hash
      ON meeting_core.answer_effect_reconciliation_quarantine FOR EACH ROW
      EXECUTE FUNCTION meeting_core.prevent_unresolved_answer_payload_mutation_v1()
    `],
    ] as const;
    for (const [_label, driftedTrigger] of driftedTriggers) {
      await expectAnswerPayloadTriggerWiringDrift(database, driftedTrigger);
    }
  });

  it("rejects trigger-function execution attribute drift", async (context) => {
    const database = databaseOrSkip(context);
    await database.query(`
      ALTER FUNCTION meeting_core.prevent_unresolved_answer_payload_mutation_v1()
      SECURITY DEFINER
    `);
    try {
      await expect(new PostgresSchemaReadiness(database).assertReady()).rejects.toThrow(
        "trigger function definition/version does not match v1",
      );
    } finally {
      await database.query(`
        ALTER FUNCTION meeting_core.prevent_unresolved_answer_payload_mutation_v1()
        SECURITY INVOKER
      `);
    }
    await expect(new PostgresSchemaReadiness(database).assertReady()).resolves.toBeUndefined();
  });

  it("rejects any non-bijective operator quarantine record", async (context) => {
    const database = databaseOrSkip(context);
    await database.query(`
      INSERT INTO meeting_core.answer_effect_reconciliation_quarantine (
        effect_id, prior_state, payload_hash, reason
      ) VALUES (
        'orphaned-operator-quarantine', 'outcome_unknown', repeat('a', 64),
        'legacy_payload_scrubbed_before_0035'
      )
    `);
    try {
      await expect(new PostgresSchemaReadiness(database).assertReady()).rejects.toThrow(
        "quarantine is not bijective with quarantined effects",
      );
    } finally {
      await database.query(`
        DELETE FROM meeting_core.answer_effect_reconciliation_quarantine
        WHERE effect_id = 'orphaned-operator-quarantine'
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
        effect_id, state, authority_scope_id, projection_target_container_id,
        delivery_container_id, reply_to_remote_message_id, marker,
        payload_bytes, payload_hash, binding_hash, authorization_digest,
        source_meeting_ids, request_started_at
      )
      SELECT
        'meeting-knowledge-answer:v1:invalid-index-' || sequence,
        'outcome_unknown',
        'scope-invalid-index',
        'projection-invalid-index',
        'delivery-invalid-index',
        '66666666666666666' || sequence,
        'marker-invalid-index-' || sequence,
        '{"request":"index-readiness"}',
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
