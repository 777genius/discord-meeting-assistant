import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { PostgresHistoricalMemoryStore } from "@discord-meeting/postgres-adapter";
import type { Pool, PoolClient } from "pg";

describe("historical index profile rebuild budget", () => {
  it("resets exhausted attempts in the runtime enqueue transaction", async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        if (text.includes("WITH selected AS")) {
          return { rows: [{ enqueued: 1 }] };
        }
        if (text.includes("SELECT EXISTS")) {
          return { rows: [{ remaining: false }] };
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
      .resolves.toEqual({ enqueued: 1, remaining: false });

    const rebuildQuery = queries.find((query) => query.includes("WITH selected AS"));
    expect(rebuildQuery).toContain("attempt_count = 0");
    expect(queries.find((query) => query.includes("SELECT EXISTS")))
      .toContain("applied_index_profile_id IS DISTINCT FROM $1");
    expect(queries).toEqual(expect.arrayContaining(["BEGIN", "COMMIT"]));
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
