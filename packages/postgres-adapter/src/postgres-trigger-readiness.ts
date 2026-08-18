import type { Pool } from "pg";

interface MissingTriggerRow {
  readonly name: string;
}

export async function findMissingPostgresTriggers(
  pool: Pool,
  requiredTriggers: readonly string[],
): Promise<readonly string[]> {
  const result = await pool.query<MissingTriggerRow>(
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
          AND trigger.tgenabled IN ('O', 'A')
      )
    `,
    [requiredTriggers],
  );
  return result.rows.map(({ name }) => name);
}
