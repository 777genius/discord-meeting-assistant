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
  it("selects accounts round-robin without waiting for earlier tasks", async () => {
    const pool = new SubscriptionAccountPool(accounts);

    const selected = Array.from(
      { length: 6 },
      () => pool.select(),
    );

    expect(selected.map((account) => account?.id)).toEqual([
      "slot-1",
      "slot-2",
      "slot-1",
      "slot-2",
      "slot-1",
      "slot-2",
    ]);
  });

  it("does not impose a task-count limit on one account", async () => {
    const pool = new SubscriptionAccountPool([accounts[0]!]);

    const selected = Array.from(
      { length: 1_024 },
      () => pool.select(),
    );

    expect(selected).toHaveLength(1_024);
    expect(selected.every((account) => account?.id === "slot-1")).toBe(true);
  });

  it("skips accounts already attempted by one failover request", async () => {
    const pool = new SubscriptionAccountPool(accounts);
    const first = pool.select();

    const second = pool.select(new Set(["slot-1"]));

    expect(first?.id).toBe("slot-1");
    expect(second?.id).toBe("slot-2");
    expect(pool.select(new Set(accounts.map((account) => account.id))))
      .toBeUndefined();
  });

  it("rejects a request that was cancelled before account selection", async () => {
    const pool = new SubscriptionAccountPool([accounts[0]!]);
    const controller = new AbortController();
    controller.abort();

    expect(() => pool.select(new Set(), controller.signal))
      .toThrow("selection was aborted");

    const next = pool.select();
    expect(next?.id).toBe("slot-1");
  });
});
