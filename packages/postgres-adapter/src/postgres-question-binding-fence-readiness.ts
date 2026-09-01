import type { Pool } from "pg";

import type { PostgresMigration } from "./postgres-migrations.js";
import { PostgresSchemaReadinessError } from
  "./postgres-schema-readiness-error.js";

interface BindingFenceRow {
  readonly dependency_matches: boolean;
  readonly definition_matches: boolean;
  readonly wiring_matches: boolean;
}

export async function assertQuestionBindingFenceDefinition(
  pool: Pool,
  migrations: readonly PostgresMigration[],
): Promise<void> {
  const expectedSource = questionBindingFenceSource(migrations);
  const expectedCanonicalSource = canonicalJsonSource(migrations);
  const result = await pool.query<BindingFenceRow>(
    `SELECT procedure.prosrc = $1
              AND procedure.provolatile = 'v'
              AND procedure.prorettype = 'trigger'::regtype
              AND pg_get_function_identity_arguments(procedure.oid) = ''
              AND procedure_namespace.nspname = 'meeting_knowledge'
              AND procedure.proname = 'prevent_question_binding_mutation'
              AND language.lanname = 'plpgsql'
              AND procedure.prokind = 'f'
              AND NOT procedure.prosecdef
              AND NOT procedure.proisstrict
              AND NOT procedure.proleakproof
              AND procedure.proparallel = 'u'
              AND procedure.proconfig = ARRAY[
                'search_path=pg_catalog, meeting_knowledge'
              ]::text[]
            AS definition_matches,
            canonical.prosrc = $2
              AND canonical.provolatile = 'i'
              AND canonical.prorettype = 'text'::regtype
              AND pg_get_function_identity_arguments(canonical.oid) = 'value jsonb'
              AND canonical_namespace.nspname = 'meeting_knowledge'
              AND canonical.proname = 'canonical_jsonb_text'
              AND canonical_language.lanname = 'plpgsql'
              AND canonical.prokind = 'f'
              AND NOT canonical.prosecdef
              AND canonical.proisstrict
              AND NOT canonical.proleakproof
              AND canonical.proparallel = 's'
              AND canonical.proconfig = ARRAY[
                'search_path=pg_catalog, meeting_knowledge'
              ]::text[]
              AND canonical.proowner = procedure.proowner
              AND procedure.proowner = procedure_namespace.nspowner
            AS dependency_matches,
            trigger.tgfoid = to_regprocedure(
              'meeting_knowledge.prevent_question_binding_mutation()'
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
              ) = ARRAY['binding', 'binding_hash']::name[]
            AS wiring_matches
     FROM pg_trigger AS trigger
     JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
     JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     JOIN pg_proc AS procedure ON procedure.oid = trigger.tgfoid
     JOIN pg_namespace AS procedure_namespace
       ON procedure_namespace.oid = procedure.pronamespace
     JOIN pg_language AS language ON language.oid = procedure.prolang
     JOIN pg_proc AS canonical ON canonical.oid = to_regprocedure(
       'meeting_knowledge.canonical_jsonb_text(jsonb)'
     )
     JOIN pg_namespace AS canonical_namespace
       ON canonical_namespace.oid = canonical.pronamespace
     JOIN pg_language AS canonical_language
       ON canonical_language.oid = canonical.prolang
     WHERE namespace.nspname = 'meeting_knowledge'
       AND relation.relname = 'question_jobs'
       AND trigger.tgname = 'question_jobs_binding_is_immutable'
       AND NOT trigger.tgisinternal`,
    [expectedSource, expectedCanonicalSource],
  );
  const row = result.rows[0];
  if (result.rows.length !== 1 || row === undefined || !row.wiring_matches) {
    throw new PostgresSchemaReadinessError(
      "question binding trigger wiring does not match the safe upgrade fence",
    );
  }
  if (!row.definition_matches) {
    throw new PostgresSchemaReadinessError(
      "question binding trigger definition does not match the safe upgrade fence",
    );
  }
  if (!row.dependency_matches) {
    throw new PostgresSchemaReadinessError(
      "question binding trigger canonical JSON dependency does not match",
    );
  }
}

function questionBindingFenceSource(
  migrations: readonly PostgresMigration[],
): string {
  const migration = migrations.find(({ fileName }) =>
    fileName === "0040_question_reconciliation_remediation.sql");
  const match = migration?.sql.match(
    /CREATE OR REPLACE FUNCTION meeting_knowledge\.prevent_question_binding_mutation\(\)\nRETURNS trigger\nLANGUAGE plpgsql\nSET search_path = pg_catalog, meeting_knowledge\nAS \$\$(\n[\s\S]*?\n)\$\$;/u,
  );
  const source = match?.[1];
  if (source === undefined) {
    throw new PostgresSchemaReadinessError(
      "question binding safe upgrade migration source is unavailable",
    );
  }
  return source;
}

function canonicalJsonSource(
  migrations: readonly PostgresMigration[],
): string {
  const migration = migrations.find(({ fileName }) =>
    fileName === "0040_question_reconciliation_remediation.sql");
  const match = migration?.sql.match(
    /CREATE OR REPLACE FUNCTION meeting_knowledge\.canonical_jsonb_text\(value jsonb\)\nRETURNS text\nLANGUAGE plpgsql\nIMMUTABLE\nSTRICT\nPARALLEL SAFE\nSET search_path = pg_catalog, meeting_knowledge\nAS \$\$(\n[\s\S]*?\n)\$\$;/u,
  );
  const source = match?.[1];
  if (source === undefined) {
    throw new PostgresSchemaReadinessError(
      "question binding canonical JSON migration source is unavailable",
    );
  }
  return source;
}
