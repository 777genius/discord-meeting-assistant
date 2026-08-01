import { describe, expect, it } from "vitest";

import { HealthAggregator, type HealthProbe } from "../src/index.js";

const NOW = new Date("2026-08-02T10:00:00.000Z");

function probe(
  name: string,
  critical: boolean,
  check: HealthProbe["check"],
): HealthProbe {
  return { check, critical, name };
}

async function healthyCheck() {
  return { status: "healthy" as const };
}

describe("HealthAggregator", () => {
  it("fails readiness closed when a critical dependency is not healthy", async () => {
    const health = new HealthAggregator(
      [
        probe("stt", true, async () => ({
          code: "RATE_LIMITED",
          status: "degraded",
        })),
        probe("database", true, async () => ({ status: "healthy" })),
      ],
      { now: () => NOW },
    );

    await expect(health.snapshot()).resolves.toEqual({
      checkedAt: NOW.toISOString(),
      dependencies: [
        { critical: true, name: "database", status: "healthy" },
        {
          code: "RATE_LIMITED",
          critical: true,
          name: "stt",
          status: "degraded",
        },
      ],
      ready: false,
      status: "unhealthy",
    });
  });

  it("reports non-critical failure as degraded without blocking readiness", async () => {
    const health = new HealthAggregator(
      [
        probe("discord", false, async () => ({ status: "unhealthy" })),
        probe("queue", true, async () => ({ status: "healthy" })),
      ],
      { now: () => NOW },
    );

    await expect(health.snapshot()).resolves.toMatchObject({
      ready: true,
      status: "degraded",
    });
  });

  it("converts thrown probe errors to a safe failure without leaking details", async () => {
    const health = new HealthAggregator(
      [
        probe("summary-provider", true, async () => {
          throw new Error("token=provider-secret-payload");
        }),
      ],
      { now: () => NOW },
    );

    const snapshot = await health.snapshot();
    expect(snapshot).toMatchObject({ ready: false, status: "unhealthy" });
    expect(snapshot.dependencies[0]).toEqual({
      code: "CHECK_FAILED",
      critical: true,
      name: "summary-provider",
      status: "unhealthy",
    });
    expect(JSON.stringify(snapshot)).not.toContain("provider-secret-payload");
  });

  it("times out a stuck critical probe and aborts its signal", async () => {
    let observedSignal: AbortSignal | undefined;
    const health = new HealthAggregator(
      [
        probe("database", true, (signal) => {
          observedSignal = signal;
          return new Promise(() => {});
        }),
      ],
      { now: () => NOW, timeoutMs: 1 },
    );

    const snapshot = await health.snapshot();
    expect(observedSignal?.aborted).toBe(true);
    expect(snapshot.dependencies[0]).toMatchObject({
      code: "CHECK_TIMEOUT",
      status: "unhealthy",
    });
    expect(snapshot.ready).toBe(false);
  });

  it("rejects duplicate or unbounded probe names", () => {
    expect(
      () =>
        new HealthAggregator([
          probe("queue", true, healthyCheck),
          probe("queue", false, healthyCheck),
        ]),
    ).toThrow(/duplicate/u);
    expect(
      () => new HealthAggregator([probe("meeting:42", true, healthyCheck)]),
    ).toThrow(/bounded/u);
  });
});
