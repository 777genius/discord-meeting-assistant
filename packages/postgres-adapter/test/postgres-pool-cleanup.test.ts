import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { closePostgresPool } from "./postgres-pool-cleanup.js";

class EarlyResolvingPool extends EventEmitter {
  readonly end = vi.fn(async (): Promise<void> => {});

  constructor(readonly totalCount: number) {
    super();
  }
}

describe("PostgreSQL integration pool cleanup", () => {
  it("waits for every client socket removal after Pool.end resolves", async () => {
    const pool = new EarlyResolvingPool(2);
    let settled = false;
    const cleanup = closePostgresPool(pool).then(() => {
      settled = true;
      return settled;
    });

    await vi.waitFor(() => {
      expect(pool.end).toHaveBeenCalledOnce();
    });
    pool.emit("remove");
    await Promise.resolve();
    expect(settled).toBe(false);

    pool.emit("remove");
    await cleanup;

    expect(settled).toBe(true);
    expect(pool.listenerCount("remove")).toBe(0);
  });

  it("ends immediately when the pool has no clients", async () => {
    const pool = new EarlyResolvingPool(0);

    await closePostgresPool(pool);

    expect(pool.end).toHaveBeenCalledOnce();
    expect(pool.listenerCount("remove")).toBe(0);
  });
});
