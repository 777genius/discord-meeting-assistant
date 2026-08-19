import type { Pool } from "pg";

import {
  loadPostgresMigrations,
  readMigrationLedger,
  requiredPostgresSchemaVersion,
  type PostgresMigration,
} from "./postgres-migrations.js";
import {
  requiredCheckConstraints,
  requiredColumns,
  requiredIndexes,
  requiredRelations,
  requiredStructuralConstraints,
} from "./postgres-core-schema-requirements.js";
import { PostgresSchemaReadinessError } from "./postgres-schema-readiness-error.js";
import { findMissingPostgresTriggers } from "./postgres-trigger-readiness.js";

export { PostgresSchemaReadinessError } from "./postgres-schema-readiness-error.js";

interface ConstraintRow { readonly validated: boolean; readonly identifier: string; readonly type: string; }

interface MissingNameRow { readonly name: string; }

export interface PostgresSchemaReadinessPort { assertReady(): Promise<void>; }

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
        WHERE NOT EXISTS (SELECT 1 FROM pg_index AS required_index
          WHERE required_index.indexrelid = to_regclass(index_name)
            AND required_index.indisvalid AND required_index.indisready)
      `,
      [requiredIndexes],
    );
    if (result.rows.length > 0) {
      throw new PostgresSchemaReadinessError(
        `required PostgreSQL index is missing or invalid: ${result.rows.map(({ name }) => name).join(", ")}`,
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
    const missing = await findMissingPostgresTriggers(this.pool, ["meeting_core.post_call_outbox.post_call_outbox_transcription_execution_binding_is_immutable"]);
    if (missing.length > 0) {
      throw new PostgresSchemaReadinessError(
        `required PostgreSQL trigger is missing or disabled: ${missing.join(", ")}`,
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
      throw new PostgresSchemaReadinessError(`${errorPrefix}: ${missing.join(", ")}`);
    }
  }

  private resolveMigrations(): Promise<readonly PostgresMigration[]> {
    return this.options.migrations === undefined ? loadPostgresMigrations() : Promise.resolve(this.options.migrations);
  }

  private resolveRequiredVersion(migrations: readonly PostgresMigration[]): number {
    const version = this.options.requiredVersion ?? requiredPostgresSchemaVersion;
    if (!Number.isSafeInteger(version) || version < 1 || version > migrations.length) {
      throw new RangeError("required PostgreSQL schema version is not represented by migrations");
    }
    return version;
  }
}
