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
import { assertQuestionBindingFenceDefinition } from
  "./postgres-question-binding-fence-readiness.js";
import { assertReconciliationIndexDefinitions } from
  "./postgres-index-readiness.js";

export { PostgresSchemaReadinessError } from "./postgres-schema-readiness-error.js";

interface ConstraintRow { readonly validated: boolean; readonly identifier: string; readonly type: string; }

interface MissingNameRow { readonly name: string; }

interface AnswerPayloadFenceRow {
  readonly definition_matches: boolean;
  readonly wiring_matches: boolean;
}

const answerPayloadFenceV1Source = `
BEGIN
  IF (OLD.state IN (
        'request_started', 'delivered', 'outcome_unknown',
        'absent_unconfirmed', 'retraction_pending'
      ) OR NEW.state IN (
        'request_started', 'delivered', 'outcome_unknown',
        'absent_unconfirmed', 'retraction_pending'
      )) AND OLD.payload_hash IS DISTINCT FROM NEW.payload_hash THEN
    RAISE EXCEPTION 'unresolved answer reconciliation payload is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'answer_effects_unresolved_payload_is_immutable';
  END IF;
  IF NEW.state IN (
       'request_started', 'delivered', 'outcome_unknown',
       'absent_unconfirmed', 'retraction_pending'
     ) AND OLD.payload_bytes IS DISTINCT FROM NEW.payload_bytes THEN
    RAISE EXCEPTION 'unresolved answer reconciliation payload is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'answer_effects_unresolved_payload_is_immutable';
  END IF;
  IF OLD.state IN (
       'request_started', 'delivered', 'outcome_unknown',
       'absent_unconfirmed', 'retraction_pending'
     ) AND NEW.state NOT IN (
       'request_started', 'delivered', 'outcome_unknown',
       'absent_unconfirmed', 'retraction_pending', 'quarantined_unrecoverable'
     ) AND OLD.payload_bytes IS DISTINCT FROM NEW.payload_bytes AND NOT (
       OLD.state = 'retraction_pending' AND NEW.state = 'retracted' AND
       NEW.payload_bytes = '{}'
     ) THEN
    RAISE EXCEPTION 'unresolved answer reconciliation payload is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'answer_effects_unresolved_payload_is_immutable';
  END IF;
  IF NEW.state IN (
       'request_started', 'delivered', 'outcome_unknown',
       'absent_unconfirmed', 'retraction_pending'
     ) AND (
       octet_length(NEW.payload_bytes) <= 2 OR
       NEW.payload_bytes = '{}' OR
       NEW.payload_hash !~ '^[a-f0-9]{64}$'
     ) THEN
    RAISE EXCEPTION 'unresolved answer reconciliation payload is absent'
      USING ERRCODE = '23514',
            CONSTRAINT = 'answer_effects_unresolved_payload_is_retained';
  END IF;
  RETURN NEW;
END;
`;

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
      if (requiredVersion >= 40) {
        await assertQuestionBindingFenceDefinition(this.pool, migrations);
      }
      await this.assertAnswerPayloadFenceDefinition();
      await this.assertAnswerQuarantineBijection();
      await this.assertNoUnrecoverableAnswerEffects();
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
    await assertReconciliationIndexDefinitions(this.pool);
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
    const missing = await findMissingPostgresTriggers(this.pool, [
      "meeting_core.post_call_outbox.post_call_outbox_transcription_execution_binding_is_immutable",
      "meeting_knowledge.question_jobs.question_jobs_binding_is_immutable",
    ]);
    if (missing.length > 0) {
      throw new PostgresSchemaReadinessError(
        `required PostgreSQL trigger is missing or disabled: ${missing.join(", ")}`,
      );
    }
  }

  private async assertNoUnrecoverableAnswerEffects(): Promise<void> {
    const result = await this.pool.query<{ readonly effect_id: string }>(
      `SELECT effect_id
       FROM meeting_core.answer_effect_reconciliation_quarantine
       ORDER BY quarantined_at, effect_id
       LIMIT 11`,
    );
    if (result.rows.length > 0) {
      const visible = result.rows.slice(0, 10).map(({ effect_id: effectId }) => effectId);
      const suffix = result.rows.length > 10 ? ", ..." : "";
      throw new PostgresSchemaReadinessError(
        `unrecoverable answer reconciliation effects require operator quarantine: ${visible.join(", ")}${suffix}`,
      );
    }
  }

  private async assertAnswerPayloadFenceDefinition(): Promise<void> {
    const result = await this.pool.query<AnswerPayloadFenceRow>(
      `SELECT procedure.prosrc = $1
                AND procedure.provolatile = 'v'
                AND procedure.prorettype = 'trigger'::regtype
                AND pg_get_function_identity_arguments(procedure.oid) = ''
                AND procedure_namespace.nspname = 'meeting_core'
                AND procedure.proname = 'prevent_unresolved_answer_payload_mutation_v1'
                AND language.lanname = 'plpgsql'
                AND procedure.prokind = 'f'
                AND NOT procedure.prosecdef
                AND NOT procedure.proisstrict
                AND NOT procedure.proleakproof
                AND procedure.proparallel = 'u'
                AND procedure.proconfig IS NULL
              AS definition_matches
              , trigger.tgfoid = to_regprocedure(
                  'meeting_core.prevent_unresolved_answer_payload_mutation_v1()'
                )
                AND trigger.tgenabled = 'O'
                AND trigger.tgtype = 19
                AND (
                  SELECT array_agg(attribute.attname ORDER BY attribute.attname)
                  FROM unnest(trigger.tgattr::smallint[]) AS update_column(attnum)
                  JOIN pg_attribute AS attribute
                    ON attribute.attrelid = trigger.tgrelid
                   AND attribute.attnum = update_column.attnum
                   AND attribute.attnum > 0
                   AND NOT attribute.attisdropped
                ) = ARRAY['payload_bytes', 'payload_hash', 'state']::name[]
              AS wiring_matches
       FROM pg_trigger AS trigger
       JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       JOIN pg_proc AS procedure ON procedure.oid = trigger.tgfoid
       JOIN pg_namespace AS procedure_namespace
         ON procedure_namespace.oid = procedure.pronamespace
       JOIN pg_language AS language ON language.oid = procedure.prolang
       WHERE namespace.nspname = 'meeting_core'
         AND relation.relname = 'answer_effects'
         AND trigger.tgname = 'answer_effects_unresolved_payload_is_immutable'
         AND NOT trigger.tgisinternal`,
      [answerPayloadFenceV1Source],
    );
    const row = result.rows[0];
    if (result.rows.length !== 1 || row === undefined || !row.wiring_matches) {
      throw new PostgresSchemaReadinessError(
        "answer reconciliation payload trigger wiring does not match v1",
      );
    }
    if (!row.definition_matches) {
      throw new PostgresSchemaReadinessError(
        "answer reconciliation payload trigger function definition/version does not match v1",
      );
    }
  }

  private async assertAnswerQuarantineBijection(): Promise<void> {
    const result = await this.pool.query<{ readonly effect_id: string }>(
      `SELECT COALESCE(effect.effect_id, quarantine.effect_id) AS effect_id
       FROM meeting_core.answer_effects AS effect
       FULL OUTER JOIN meeting_core.answer_effect_reconciliation_quarantine AS quarantine
         ON quarantine.effect_id = effect.effect_id
       WHERE (effect.state = 'quarantined_unrecoverable')
          IS DISTINCT FROM (quarantine.effect_id IS NOT NULL)
          OR quarantine.effect_id IS NOT NULL AND (
            effect.state <> 'quarantined_unrecoverable' OR
            effect.payload_hash IS DISTINCT FROM quarantine.payload_hash OR
            quarantine.prior_state NOT IN (
              'request_started', 'delivered', 'outcome_unknown',
              'absent_unconfirmed', 'retraction_pending'
            ) OR quarantine.reason NOT IN (
              'legacy_payload_scrubbed_before_0035',
              'legacy_reconciliation_authority_absent_before_0035'
            )
          )
       ORDER BY effect_id
       LIMIT 11`,
    );
    if (result.rows.length > 0) {
      throw new PostgresSchemaReadinessError(
        `answer reconciliation quarantine is not bijective with quarantined effects: ${result.rows.map(({ effect_id: effectId }) => effectId).join(", ")}`,
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
