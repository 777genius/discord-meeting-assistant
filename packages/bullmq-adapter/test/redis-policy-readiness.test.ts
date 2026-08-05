import { describe, expect, it } from "vitest";

import {
  RedisPolicyReadinessError,
  assertRedisQueueDurabilityPolicy,
  createRedisPolicyReadiness,
  type RedisPolicyClient,
} from "../src/index.js";

class FakeRedisPolicyClient implements RedisPolicyClient {
  public constructor(
    private readonly settings: Readonly<Record<string, unknown>>,
  ) {}

  public async config(_command: "GET", setting: string): Promise<unknown> {
    const value = this.settings[setting];
    return value === undefined ? [] : [setting, value];
  }
}

function durableRedisSettings(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    appendfsync: "everysec",
    appendonly: "yes",
    maxmemory: "536870912",
    "maxmemory-policy": "noeviction",
    ...overrides,
  };
}

describe("Redis queue durability policy readiness", () => {
  it.each(["everysec", "always"])(
    "accepts AOF appendfsync=%s with noeviction",
    async (appendfsync) => {
      const readiness = createRedisPolicyReadiness({
        client: Promise.resolve(
          new FakeRedisPolicyClient(durableRedisSettings({ appendfsync })),
        ),
      });

      await expect(readiness.assertReady()).resolves.toBeUndefined();
    },
  );

  it("fails closed when Redis could evict queue records or AOF is disabled", async () => {
    await expect(
      assertRedisQueueDurabilityPolicy(
        new FakeRedisPolicyClient(
          durableRedisSettings({
            appendfsync: "no",
            appendonly: "no",
            maxmemory: "0",
            "maxmemory-policy": "allkeys-lru",
          }),
        ),
      ),
    ).rejects.toThrow(
      "maxmemory-policy must be noeviction; maxmemory must be a finite positive byte limit; appendonly must be yes; appendfsync must be everysec or always",
    );
  });

  it("fails closed when CONFIG GET does not return the requested setting", async () => {
    await expect(
      assertRedisQueueDurabilityPolicy(
        new FakeRedisPolicyClient({
          appendfsync: "everysec",
          appendonly: "yes",
        }),
      ),
    ).rejects.toBeInstanceOf(RedisPolicyReadinessError);
  });
});
