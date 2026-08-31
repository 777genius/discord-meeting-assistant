import type { Pool } from "pg";

import { PostgresSchemaReadinessError } from "./postgres-schema-readiness-error.js";

interface IncorrectIndexRow { readonly name: string; }

/** Exact bounded-reconciliation index shapes; names alone are not readiness. */
export async function assertReconciliationIndexDefinitions(pool: Pool): Promise<void> {
  const exact = await pool.query<IncorrectIndexRow>(
    `WITH expected(index_name, relation_name, columns, predicate) AS (VALUES
       ('meeting_core.answer_effects_unknown_idx', 'meeting_core.answer_effects',
        ARRAY['request_started_at', 'effect_id']::text[],
        '(state = ANY (ARRAY[''request_started''::text, ''outcome_unknown''::text]))'),
       ('meeting_core.answer_effects_unresolved_reconciliation_idx',
        'meeting_core.answer_effects',
        ARRAY['updated_at', 'request_started_at', 'effect_id']::text[],
        '(state = ANY (ARRAY[''outcome_unknown''::text, ''absent_unconfirmed''::text]))'),
       ('meeting_core.answer_effects_retraction_pending_idx',
        'meeting_core.answer_effects', ARRAY['updated_at', 'effect_id']::text[],
        '(state = ''retraction_pending''::text)'),
       ('meeting_knowledge.question_message_tombstones_expiry_idx',
        'meeting_knowledge.question_message_tombstones',
        ARRAY['expires_at', 'question_id']::text[], NULL::text),
       ('meeting_knowledge.question_jobs_reconciliation_active_idx',
        'meeting_knowledge.question_jobs', ARRAY['question_id']::text[],
        '((state <> ''terminal''::text) OR (reconciliation_disposition = ''reconcile''::text))'),
       ('meeting_core.answer_effects_question_reconciliation_idx',
        'meeting_core.answer_effects', ARRAY['effect_id']::text[],
        '(state = ANY (ARRAY[''request_started''::text, ''outcome_unknown''::text, ''absent_unconfirmed''::text, ''delivered''::text, ''retraction_pending''::text]))')
     ), observed AS (
       SELECT expected.index_name,
              indexed_relation.oid = to_regclass(expected.relation_name)
                AND access_method.amname = 'btree' AND NOT catalog_index.indisunique
                AND catalog_index.indexprs IS NULL
                AND catalog_index.indnkeyatts = cardinality(expected.columns)
                AND NOT EXISTS (
                  SELECT 1 FROM unnest(catalog_index.indoption::smallint[])
                    AS key_option(value)
                  WHERE key_option.value <> 0
                )
                AND (SELECT array_agg(attribute.attname::text ORDER BY key.ordinality)
                     FROM unnest(catalog_index.indkey::smallint[])
                       WITH ORDINALITY AS key(attnum, ordinality)
                     JOIN pg_attribute AS attribute
                       ON attribute.attrelid = indexed_relation.oid
                      AND attribute.attnum = key.attnum) = expected.columns
                AND pg_get_expr(catalog_index.indpred, catalog_index.indrelid)
                  IS NOT DISTINCT FROM expected.predicate AS matches
       FROM expected
       LEFT JOIN pg_class AS index_relation
         ON index_relation.oid = to_regclass(expected.index_name)
       LEFT JOIN pg_index AS catalog_index
         ON catalog_index.indexrelid = index_relation.oid
       LEFT JOIN pg_class AS indexed_relation
         ON indexed_relation.oid = catalog_index.indrelid
       LEFT JOIN pg_am AS access_method ON access_method.oid = index_relation.relam
     )
     SELECT index_name AS name FROM observed WHERE matches IS NOT TRUE`,
  );
  if (exact.rows.length > 0) {
    throw new PostgresSchemaReadinessError(
      `required PostgreSQL index definition is incorrect: ${exact.rows
        .map(({ name }) => name).join(", ")}`,
    );
  }
}
