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
  it("leases accounts round-robin and never leases one slot concurrently", async () => {
    const pool = new SubscriptionAccountPool(accounts);

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
    const pool = new SubscriptionAccountPool([accounts[0]!]);
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
