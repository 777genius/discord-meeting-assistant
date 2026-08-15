import { describe, expect, it } from "vitest";

import {
  queryHistoricalPostgres,
} from "../src/postgres-historical-query.js";
import {
  databaseOrSkip,
  usePostgresIntegrationDatabase,
} from "./postgres-integration-fixtures.js";

const probeMarker = "meeting_knowledge_server_cancellation_probe_v1";

usePostgresIntegrationDatabase();

async function waitForSleepingBackend(
  database: ReturnType<typeof databaseOrSkip>,
): Promise<number> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await database.query<{ readonly pid: number }>(`
      SELECT pid::float8 AS pid
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND state = 'active'
        AND wait_event = 'PgSleep'
        AND query LIKE $1
      ORDER BY pid
      LIMIT 1
    `, [`%${probeMarker}%`]);
    const pid = result.rows[0]?.pid;
    if (pid !== undefined) {
      return pid;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("PostgreSQL cancellation probe did not reach pg_sleep");
}

async function backendIsActive(
  database: ReturnType<typeof databaseOrSkip>,
  backendPid: number,
): Promise<boolean> {
  const result = await database.query<{ readonly active: boolean }>(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_stat_activity
      WHERE pid = $1 AND state = 'active'
    ) AS active
  `, [backendPid]);
  return result.rows[0]?.active === true;
}

describe("PostgreSQL historical pg-native cancellation probe", () => {
  it("returns the abort reason only after the sleeping backend is inactive", async (context) => {
    const database = databaseOrSkip(context);
    const controller = new AbortController();
    const cancellation = new Error("synthetic pg_sleep cancellation");
    const operation = queryHistoricalPostgres(database, {
      text: `SELECT /* ${probeMarker} */ pg_sleep(30)`,
    }, controller.signal);
    let backendPid: number | undefined;
    try {
      backendPid = await waitForSleepingBackend(database);

      controller.abort(cancellation);

      await expect(operation).rejects.toBe(cancellation);
      await expect(backendIsActive(database, backendPid)).resolves.toBe(false);
    } finally {
      if (!controller.signal.aborted) {
        controller.abort(new Error("synthetic probe cleanup"));
      }
      await operation.catch(() => {});
      if (backendPid !== undefined) {
        await database.query(
          "SELECT pg_terminate_backend($1) FROM pg_stat_activity WHERE pid = $1",
          [backendPid],
        );
      }
    }
  }, 15_000);
});
