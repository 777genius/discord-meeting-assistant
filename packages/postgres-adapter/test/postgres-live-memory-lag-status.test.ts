import { liveMemoryLagStatus } from "@discord-meeting/postgres-adapter";
import { describe, expect, it } from "vitest";

describe("live memory lag status", () => {
  it("exposes the exact five-second qualification boundary", () => {
    expect(liveMemoryLagStatus({ oldestPendingAgeMs: 4_999, pendingCount: 1 }))
      .toBe("pending");
    expect(liveMemoryLagStatus({ oldestPendingAgeMs: 5_000, pendingCount: 1 }))
      .toBe("degraded");
  });

  it("reports deterministic bounded backlog before age degradation", () => {
    expect(liveMemoryLagStatus({ oldestPendingAgeMs: 1, pendingCount: 128 }))
      .toBe("pending");
    expect(liveMemoryLagStatus({ oldestPendingAgeMs: 99_000, pendingCount: 129 }))
      .toBe("backpressured");
  });
});
