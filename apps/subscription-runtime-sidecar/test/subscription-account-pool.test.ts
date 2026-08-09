import { describe, expect, it } from "vitest";

import {
  SubscriptionAccountPool,
  type SubscriptionRuntimeAccount,
} from "../src/subscription-account-pool.js";

const accounts: readonly SubscriptionRuntimeAccount[] = [
  {
    authJsonPath: "/private/slot-1/auth.json",
    id: "slot-1",
    providerInstanceId: "provider-slot-1",
  },
  {
    authJsonPath: "/private/slot-2/auth.json",
    id: "slot-2",
    providerInstanceId: "provider-slot-2",
  },
];

describe("SubscriptionAccountPool", () => {
  it("leases accounts round-robin up to their configured concurrency", async () => {
    const pool = new SubscriptionAccountPool(accounts, 1);

    const first = await pool.acquire();
    const second = await pool.acquire();
    const queued = pool.acquire();

    expect(first?.account.id).toBe("slot-1");
    expect(second?.account.id).toBe("slot-2");
    let queuedSettled = false;
    void queued.then(() => {
      queuedSettled = true;
      return queuedSettled;
    });
    await Promise.resolve();
    expect(queuedSettled).toBe(false);

    first?.release();
    const third = await queued;
    expect(third?.account.id).toBe("slot-1");
    second?.release();
    third?.release();
  });

  it("runs several tasks concurrently on one account and queues only overflow", async () => {
    const pool = new SubscriptionAccountPool([accounts[0]!], 3);

    const active = await Promise.all([
      pool.acquire(),
      pool.acquire(),
      pool.acquire(),
    ]);
    const overflow = pool.acquire();
    let overflowSettled = false;
    void overflow.then(() => {
      overflowSettled = true;
      return overflowSettled;
    });
    await Promise.resolve();
    expect(active.map((lease) => lease?.account.id)).toEqual([
      "slot-1",
      "slot-1",
      "slot-1",
    ]);
    expect(overflowSettled).toBe(false);

    active[1]?.release();
    const admitted = await overflow;
    expect(admitted?.account.id).toBe("slot-1");
    active[0]?.release();
    active[2]?.release();
    admitted?.release();
  });

  it("skips accounts already attempted by one failover request", async () => {
    const pool = new SubscriptionAccountPool(accounts);
    const first = await pool.acquire();
    first?.release();

    const second = await pool.acquire(new Set(["slot-1"]));

    expect(second?.account.id).toBe("slot-2");
    second?.release();
    await expect(pool.acquire(new Set(accounts.map((account) => account.id))))
      .resolves.toBeUndefined();
  });

  it("removes an aborted waiter without consuming the released account", async () => {
    const pool = new SubscriptionAccountPool([accounts[0]!], 1);
    const active = await pool.acquire();
    const controller = new AbortController();
    const waiting = pool.acquire(new Set(), controller.signal);

    controller.abort();
    await expect(waiting).rejects.toThrow("acquisition was aborted");
    active?.release();

    const next = await pool.acquire();
    expect(next?.account.id).toBe("slot-1");
    next?.release();
  });
});
