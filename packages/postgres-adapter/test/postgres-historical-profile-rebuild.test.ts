import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { PostgresHistoricalMemoryStore } from "@discord-meeting/postgres-adapter";
import type { Pool, PoolClient } from "pg";

describe("historical index profile rebuild budget", () => {
  it("keeps a post-update profile rebuild pending until completion", async () => {
    const queries: string[] = [];
    let rebuildCompleted = false;
    const client = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        if (text.includes("WITH selected AS")) {
          return { rows: [{ enqueued: rebuildCompleted ? 0 : 1 }] };
        }
        if (text.includes("SELECT EXISTS")) {
          return { rows: [{ remaining: !rebuildCompleted }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    } as unknown as PoolClient;
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as Pool;

    await expect(new PostgresHistoricalMemoryStore(pool)
      .enqueueAppliedProfileRebuilds("qualified-profile", 1))
      .resolves.toEqual({ enqueued: 1, remaining: true });

    rebuildCompleted = true;
    await expect(new PostgresHistoricalMemoryStore(pool)
      .enqueueAppliedProfileRebuilds("qualified-profile", 1))
      .resolves.toEqual({ enqueued: 0, remaining: false });

    const rebuildQuery = queries.find((query) => query.includes("WITH selected AS"));
    expect(rebuildQuery).toContain("attempt_count = 0");
    const remainderQuery = queries.find((query) => query.includes("SELECT EXISTS"));
    expect(remainderQuery?.replace(/\s+/gu, " ").trim()).toBe(
      "SELECT EXISTS ( SELECT 1 FROM meeting_core.historical_memory_sync "
      + "WHERE is_current AND operation = 'index' AND ( "
      + "(state = 'applied' AND applied_index_profile_id IS DISTINCT FROM $1) "
      + "OR profile_rebuild_requested = true ) ) AS remaining",
    );
    expect(queries.filter((query) => query === "BEGIN")).toHaveLength(2);
    expect(queries.filter((query) => query === "COMMIT")).toHaveLength(2);
  });

  it("resets old max-attempt applied rows during migration 0027", () => {
    const migration = readFileSync(new URL(
      "../../../infra/postgres/migrations/0027_historical_memory_profile_rebuild.sql",
      import.meta.url,
    ), "utf8");
    expect(migration).toMatch(/state = 'pending',[\s\S]*attempt_count = 0/u);
    expect(migration).toMatch(/WHERE is_current AND operation = 'index' AND state = 'applied'/u);
    expect(migration).not.toMatch(/remote_document_ids\s*=/u);
  });
});
