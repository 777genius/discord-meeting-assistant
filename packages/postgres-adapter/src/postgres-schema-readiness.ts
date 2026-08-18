import type { Pool } from "pg";

import {
  loadPostgresMigrations,
  readMigrationLedger,
  requiredPostgresSchemaVersion,
  type PostgresMigration,
} from "./postgres-migrations.js";

const requiredRelations = [
  "meeting_core.schema_migration_ledger",
  "meeting_core.meetings",
  "meeting_core.post_call_outbox",
  "meeting_core.live_meetings",
  "meeting_core.live_meeting_turns",
  "meeting_core.live_meeting_summary_coverage",
  "meeting_core.live_meeting_generation_usage",
  "meeting_core.live_meeting_generation_telemetry",
  "meeting_core.post_call_dead_letters",
  "meeting_core.summary_publication_effects",
  "guild_configuration.guild_installations",
] as const;

const requiredIndexes = [
  "meeting_core.post_call_outbox_recoverable_idx",
  "meeting_core.post_call_outbox_binding_recoverable_idx",
  "meeting_core.post_call_dead_letters_recorded_idx",
  "meeting_core.live_meeting_turns_timeline_idx",
] as const;

const requiredColumns = [
  "meeting_core.schema_migration_ledger.version",
  "meeting_core.schema_migration_ledger.checksum_sha256",
  "meeting_core.schema_migration_ledger.applied_at",
  "meeting_core.meetings.meeting_id",
  "meeting_core.meetings.revision",
  "meeting_core.meetings.snapshot",
  "meeting_core.meetings.created_at",
  "meeting_core.meetings.updated_at",
  "meeting_core.post_call_outbox.meeting_id",
  "meeting_core.post_call_outbox.schema_version",
  "meeting_core.post_call_outbox.created_at",
  "meeting_core.post_call_outbox.dispatched_at",
  "meeting_core.post_call_outbox.last_enqueued_at",
  "meeting_core.post_call_outbox.processed_at",
  "meeting_core.post_call_outbox.dead_lettered_at",
  "meeting_core.post_call_outbox.dead_letter_source_job_ref",
  "meeting_core.post_call_outbox.recovery_generation",
  "meeting_core.post_call_outbox.recovery_after",
  "meeting_core.post_call_outbox.recovery_source_job_ref",
  "meeting_core.post_call_outbox.transcription_execution_binding",
  "meeting_core.post_call_outbox.transcription_execution_binding_required",
  "meeting_core.post_call_outbox.binding_recovery_after",
  "meeting_core.live_meetings.meeting_id",
  "meeting_core.live_meetings.revision",
  "meeting_core.live_meetings.snapshot",
  "meeting_core.live_meetings.created_at",
  "meeting_core.live_meetings.updated_at",
  "meeting_core.live_meeting_turns.meeting_id",
  "meeting_core.live_meeting_turns.turn_id",
  "meeting_core.live_meeting_turns.start_ms",
  "meeting_core.live_meeting_turns.end_ms",
  "meeting_core.live_meeting_turns.speaker_id",
  "meeting_core.live_meeting_turns.turn",
  "meeting_core.live_meeting_turns.created_at",
  "meeting_core.live_meeting_summary_coverage.meeting_id",
  "meeting_core.live_meeting_summary_coverage.turn_id",
  "meeting_core.live_meeting_summary_coverage.first_summary_revision",
  "meeting_core.live_meeting_summary_coverage.created_at",
  "meeting_core.live_meeting_generation_usage.meeting_id",
  "meeting_core.live_meeting_generation_usage.run_id",
  "meeting_core.live_meeting_generation_usage.payload",
  "meeting_core.live_meeting_generation_usage.created_at",
  "meeting_core.live_meeting_generation_telemetry.meeting_id",
  "meeting_core.live_meeting_generation_telemetry.run_id",
  "meeting_core.live_meeting_generation_telemetry.payload",
  "meeting_core.live_meeting_generation_telemetry.created_at",
  "meeting_core.post_call_dead_letters.source_job_ref",
  "meeting_core.post_call_dead_letters.schema_version",
  "meeting_core.post_call_dead_letters.meeting_id",
  "meeting_core.post_call_dead_letters.attempts_made",
  "meeting_core.post_call_dead_letters.failure_code",
  "meeting_core.post_call_dead_letters.retryable",
  "meeting_core.post_call_dead_letters.recorded_at",
  "meeting_core.summary_publication_effects.projection_key",
  "meeting_core.summary_publication_effects.publication_target_id",
  "meeting_core.summary_publication_effects.external_receipt",
  "meeting_core.summary_publication_effects.reserved_at",
  "meeting_core.summary_publication_effects.completed_at",
  "guild_configuration.guild_installations.guild_id",
  "guild_configuration.guild_installations.revision",
  "guild_configuration.guild_installations.snapshot",
  "guild_configuration.guild_installations.created_at",
  "guild_configuration.guild_installations.updated_at",
] as const;

const requiredCheckConstraints = [
  ["meeting_core", "schema_migration_ledger", "schema_migration_ledger_version_is_positive"],
  ["meeting_core", "schema_migration_ledger", "schema_migration_ledger_checksum_is_sha256"],
  ["meeting_core", "meetings", "meetings_snapshot_is_object"],
  ["meeting_core", "meetings", "meetings_snapshot_identity_matches"],
  ["meeting_core", "meetings", "meetings_snapshot_revision_matches"],
  ["meeting_core", "post_call_outbox", "post_call_outbox_schema_version_is_supported"],
  ["meeting_core", "post_call_outbox", "post_call_outbox_terminal_receipt_is_consistent"],
  ["meeting_core", "post_call_outbox", "post_call_outbox_terminal_receipt_is_exclusive"],
  ["meeting_core", "post_call_outbox", "post_call_outbox_recovery_generation_is_valid"],
  ["meeting_core", "post_call_outbox", "post_call_outbox_recovery_receipt_is_consistent"],
  ["meeting_core", "post_call_outbox", "post_call_outbox_transcription_execution_binding_is_bounded"],
  ["meeting_core", "post_call_outbox", "post_call_outbox_required_transcription_binding_is_present"],
  ["meeting_core", "post_call_outbox", "post_call_outbox_bound_work_is_hidden_from_legacy_recovery"],
  ["meeting_core", "live_meetings", "live_meetings_snapshot_is_object"],
  ["meeting_core", "live_meetings", "live_meetings_snapshot_identity_matches"],
  ["meeting_core", "live_meetings", "live_meetings_snapshot_revision_matches"],
  ["meeting_core", "live_meetings", "live_meetings_snapshot_excludes_legacy_records"],
  ["meeting_core", "live_meeting_turns", "live_meeting_turn_is_object"],
  ["meeting_core", "live_meeting_turns", "live_meeting_turn_identity_matches"],
  ["meeting_core", "live_meeting_turns", "live_meeting_turn_timing_matches"],
  ["meeting_core", "live_meeting_turns", "live_meeting_turn_speaker_matches"],
  ["meeting_core", "live_meeting_turns", "live_meeting_turn_text_is_string"],
  ["meeting_core", "live_meeting_summary_coverage", "live_meeting_summary_coverage_revision_is_positive"],
  ["meeting_core", "live_meeting_generation_usage", "live_meeting_generation_usage_payload_is_object"],
  ["meeting_core", "live_meeting_generation_usage", "live_meeting_generation_usage_identity_matches"],
  ["meeting_core", "live_meeting_generation_telemetry", "live_meeting_generation_telemetry_payload_is_object"],
  ["meeting_core", "live_meeting_generation_telemetry", "live_meeting_generation_telemetry_identity_matches"],
  ["meeting_core", "post_call_dead_letters", "post_call_dead_letters_schema_version_is_supported"],
  ["meeting_core", "post_call_dead_letters", "post_call_dead_letters_source_job_ref_is_sha256"],
  ["meeting_core", "post_call_dead_letters", "post_call_dead_letters_attempts_are_positive"],
  ["meeting_core", "post_call_dead_letters", "post_call_dead_letters_failure_code_is_valid"],
  ["meeting_core", "summary_publication_effects", "summary_publication_effects_key_is_valid"],
  ["meeting_core", "summary_publication_effects", "summary_publication_effects_target_is_valid"],
  ["meeting_core", "summary_publication_effects", "summary_publication_effects_receipt_is_consistent"],
  ["meeting_core", "summary_publication_effects", "summary_publication_effects_receipt_is_bounded"],
  ["guild_configuration", "guild_installations", "guild_installations_snapshot_is_object"],
  ["guild_configuration", "guild_installations", "guild_installations_snapshot_identity_matches"],
  ["guild_configuration", "guild_installations", "guild_installations_snapshot_revision_matches"],
] as const;

const requiredStructuralConstraints = [
  ["meeting_core", "schema_migration_ledger", "schema_migration_ledger_pkey", "p"],
  ["meeting_core", "meetings", "meetings_pkey", "p"],
  ["meeting_core", "post_call_outbox", "post_call_outbox_pkey", "p"],
  ["meeting_core", "post_call_outbox", "post_call_outbox_meeting_id_fkey", "f"],
  [
    "meeting_core",
    "post_call_outbox",
    "post_call_outbox_dead_letter_source_job_ref_fkey",
    "f",
  ],
  [
    "meeting_core",
    "post_call_outbox",
    "post_call_outbox_recovery_source_job_ref_fkey",
    "f",
  ],
  ["meeting_core", "live_meetings", "live_meetings_pkey", "p"],
  ["meeting_core", "live_meeting_turns", "live_meeting_turns_pkey", "p"],
  ["meeting_core", "live_meeting_turns", "live_meeting_turns_meeting_id_fkey", "f"],
  [
    "meeting_core",
    "live_meeting_summary_coverage",
    "live_meeting_summary_coverage_pkey",
    "p",
  ],
  [
    "meeting_core",
    "live_meeting_summary_coverage",
    "live_meeting_summary_coverage_meeting_id_turn_id_fkey",
    "f",
  ],
  ["meeting_core", "live_meeting_generation_usage", "live_meeting_generation_usage_pkey", "p"],
  [
    "meeting_core",
    "live_meeting_generation_usage",
    "live_meeting_generation_usage_meeting_id_fkey",
    "f",
  ],
  [
    "meeting_core",
    "live_meeting_generation_telemetry",
    "live_meeting_generation_telemetry_pkey",
    "p",
  ],
  [
    "meeting_core",
    "live_meeting_generation_telemetry",
    "live_meeting_generation_telemetry_meeting_id_fkey",
    "f",
  ],
  ["meeting_core", "post_call_dead_letters", "post_call_dead_letters_pkey", "p"],
  ["meeting_core", "summary_publication_effects", "summary_publication_effects_pkey", "p"],
  ["guild_configuration", "guild_installations", "guild_installations_pkey", "p"],
] as const;

interface ConstraintRow {
  readonly validated: boolean;
  readonly identifier: string;
  readonly type: string;
}

interface MissingNameRow {
  readonly name: string;
}

const requiredTriggers = [
  "meeting_core.post_call_outbox.post_call_outbox_transcription_execution_binding_is_immutable",
] as const;

export interface PostgresSchemaReadinessPort {
  assertReady(): Promise<void>;
}

export class PostgresSchemaReadinessError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PostgresSchemaReadinessError";
  }
}

/**
 * Startup-facing PostgreSQL schema contract. It deliberately verifies the
 * exact source checksums instead of relying on table existence alone.
 */
export class PostgresSchemaReadiness implements PostgresSchemaReadinessPort {
  public constructor(
    private readonly pool: Pool,
    private readonly options: {
      readonly migrations?: readonly PostgresMigration[];
      readonly requiredVersion?: number;
    } = {},
  ) {}

  public async assertReady(): Promise<void> {
    try {
      const migrations = await this.resolveMigrations();
      const requiredVersion = this.resolveRequiredVersion(migrations);
      const requiredMigrations = migrations.filter(({ version }) => version <= requiredVersion);
      await this.assertRelations();
      await this.assertColumns();
      await this.assertIndexes();
      await this.assertConstraints();
      await this.assertTriggers();
      const ledger = await readMigrationLedger(this.pool);
      if (ledger.length !== requiredMigrations.length) {
        throw new PostgresSchemaReadinessError(
          `migration ledger has ${ledger.length} receipts; expected ${requiredMigrations.length}`,
        );
      }
      for (const expected of requiredMigrations) {
        const actual = ledger.find(({ version }) => version === expected.version);
        if (actual === undefined) {
          throw new PostgresSchemaReadinessError(
            `migration ledger is missing required version ${expected.version}`,
          );
        }
        if (actual.checksumSha256 !== expected.checksumSha256) {
          throw new PostgresSchemaReadinessError(
            `migration ${expected.version} checksum does not match deployed source`,
          );
        }
      }
      const actualVersion = ledger.at(-1)?.version ?? 0;
      if (actualVersion !== requiredVersion) {
        throw new PostgresSchemaReadinessError(
          `schema version ${actualVersion} does not satisfy required version ${requiredVersion}`,
        );
      }
    } catch (error) {
      if (error instanceof PostgresSchemaReadinessError) {
        throw error;
      }
      throw new PostgresSchemaReadinessError("PostgreSQL schema readiness failed", { cause: error });
    }
  }

  private async assertRelations(): Promise<void> {
    const result = await this.pool.query<MissingNameRow>(
      `
        SELECT relation AS name
        FROM unnest($1::text[]) AS relation
        WHERE to_regclass(relation) IS NULL
      `,
      [requiredRelations],
    );
    if (result.rows.length > 0) {
      throw new PostgresSchemaReadinessError(
        `required PostgreSQL relation is missing: ${result.rows.map(({ name }) => name).join(", ")}`,
      );
    }
  }

  private async assertIndexes(): Promise<void> {
    const result = await this.pool.query<MissingNameRow>(
      `
        SELECT index_name AS name
        FROM unnest($1::text[]) AS index_name
        WHERE to_regclass(index_name) IS NULL
      `,
      [requiredIndexes],
    );
    if (result.rows.length > 0) {
      throw new PostgresSchemaReadinessError(
        `required PostgreSQL index is missing: ${result.rows.map(({ name }) => name).join(", ")}`,
      );
    }
  }

  private async assertColumns(): Promise<void> {
    const result = await this.pool.query<MissingNameRow>(
      `
        SELECT required_column.identifier AS name
        FROM unnest($1::text[]) AS required_column(identifier)
        WHERE NOT EXISTS (
          SELECT 1
          FROM pg_attribute AS attribute
          JOIN pg_class AS relation ON relation.oid = attribute.attrelid
          JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = split_part(required_column.identifier, '.', 1)
            AND relation.relname = split_part(required_column.identifier, '.', 2)
            AND attribute.attname = split_part(required_column.identifier, '.', 3)
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        )
      `,
      [requiredColumns],
    );
    if (result.rows.length > 0) {
      throw new PostgresSchemaReadinessError(
        `required PostgreSQL column is missing: ${result.rows.map(({ name }) => name).join(", ")}`,
      );
    }
  }

  private async assertConstraints(): Promise<void> {
    await this.assertConstraintsOfType(
      requiredCheckConstraints.map(([schema, table, constraint]) => [
        `${schema}.${table}.${constraint}`,
        "c",
      ]),
      "required PostgreSQL check constraint is missing or invalid",
    );
    await this.assertConstraintsOfType(
      requiredStructuralConstraints.map(([schema, table, constraint, type]) => [
        `${schema}.${table}.${constraint}`,
        type,
      ]),
      "required PostgreSQL structural constraint is missing or invalid",
    );
  }

  private async assertTriggers(): Promise<void> {
    const result = await this.pool.query<MissingNameRow>(
      `
        SELECT required_trigger.identifier AS name
        FROM unnest($1::text[]) AS required_trigger(identifier)
        WHERE NOT EXISTS (
          SELECT 1
          FROM pg_trigger AS trigger
          JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
          JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname || '.' || relation.relname || '.' || trigger.tgname =
            required_trigger.identifier
            AND NOT trigger.tgisinternal
            AND trigger.tgenabled <> 'D'
        )
      `,
      [requiredTriggers],
    );
    if (result.rows.length > 0) {
      throw new PostgresSchemaReadinessError(
        `required PostgreSQL trigger is missing or disabled: ${result.rows.map(({ name }) => name).join(", ")}`,
      );
    }
  }

  private async assertConstraintsOfType(
    expectedConstraints: readonly (readonly [string, string])[],
    errorPrefix: string,
  ): Promise<void> {
    const expected = expectedConstraints.map(([identifier]) => identifier);
    const expectedTypes = new Map(expectedConstraints);
    const result = await this.pool.query<ConstraintRow>(
      `
        SELECT n.nspname || '.' || relation.relname || '.' || check_constraint.conname AS identifier,
               check_constraint.contype AS type,
               check_constraint.convalidated AS validated
        FROM pg_constraint AS check_constraint
        JOIN pg_class AS relation ON relation.oid = check_constraint.conrelid
        JOIN pg_namespace AS n ON n.oid = relation.relnamespace
        WHERE n.nspname || '.' || relation.relname || '.' || check_constraint.conname = ANY($1::text[])
      `,
      [expected],
    );
    const actual = new Map(result.rows.map((row) => [row.identifier, row]));
    const missing = expected.filter((identifier) => {
      const constraint = actual.get(identifier);
      return constraint?.type !== expectedTypes.get(identifier) || constraint?.validated !== true;
    });
    if (missing.length > 0) {
      throw new PostgresSchemaReadinessError(
        `${errorPrefix}: ${missing.join(", ")}`,
      );
    }
  }

  private resolveMigrations(): Promise<readonly PostgresMigration[]> {
    return this.options.migrations === undefined
      ? loadPostgresMigrations()
      : Promise.resolve(this.options.migrations);
  }

  private resolveRequiredVersion(migrations: readonly PostgresMigration[]): number {
    const version = this.options.requiredVersion ?? requiredPostgresSchemaVersion;
    if (!Number.isSafeInteger(version) || version < 1 || version > migrations.length) {
      throw new RangeError("required PostgreSQL schema version is not represented by migrations");
    }
    return version;
  }
}
