import { HealthAggregator } from "@discord-meeting/observability-adapter";
import { describe, expect, it } from "vitest";

import { createPostCallDurabilityHealthProbe } from "../src/composition/health.js";

describe("post-call durability health", () => {
  it("reports a retained dead-letter replica failure as degraded, not ready failure", async () => {
    const durabilityFailure = new AggregateError(
      [new Error("Redis DLQ replica failed")],
      "Post-call terminal durability effects failed",
    );
    const health = new HealthAggregator([
      createPostCallDurabilityHealthProbe({
        assertPostCallDurability: () => {
          throw durabilityFailure;
        },
      }),
    ]);

    await expect(health.snapshot()).resolves.toMatchObject({
      dependencies: [
        {
          code: "CHECK_FAILED",
          critical: false,
          name: "post-call-durability",
          status: "unhealthy",
        },
      ],
      ready: true,
      status: "degraded",
    });
  });
});
