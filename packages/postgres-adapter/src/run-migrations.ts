import { readFile } from "node:fs/promises";
import { Pool } from "pg";

import { PostgresMigrationRunner } from "./postgres-migrations.js";

const connectionString = await resolveConnectionString();

const pool = new Pool({ connectionString });
try {
  const result = await new PostgresMigrationRunner(pool).migrate();
  process.stdout.write(
    `PostgreSQL schema version ${result.version}; applied ${result.appliedVersions.join(",") || "none"}\n`,
  );
} finally {
  await pool.end();
}

async function resolveConnectionString(): Promise<string> {
  const direct = process.env.POSTGRES_URL?.trim();
  const file = process.env.POSTGRES_URL_FILE?.trim();
  if (direct !== undefined && direct.length > 0 && file !== undefined && file.length > 0) {
    throw new Error("set exactly one of POSTGRES_URL or POSTGRES_URL_FILE for the migration runner");
  }
  if (direct !== undefined && direct.length > 0) {
    return direct;
  }
  if (file !== undefined && file.length > 0) {
    const value = (await readFile(file, "utf8")).trim();
    if (value.length > 0) {
      return value;
    }
  }
  throw new Error("POSTGRES_URL or POSTGRES_URL_FILE is required for the migration runner");
}
