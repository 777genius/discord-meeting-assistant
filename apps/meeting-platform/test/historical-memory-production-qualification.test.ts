import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { startDisposableInfinityHttpService } from
  "@discord-meeting/infinity-context-adapter/test-support";
import { INFINITY_CONTEXT_SDK_PROVENANCE } from
  "@discord-meeting/infinity-context-adapter";

import {
  platformConfig,
  requiredHistoricalRuntime,
  retainedProductionEmbeddingProfileAttestation,
  silentLogger,
  syntheticCoverageRuntime,
  testProductionQualificationPolicy,
} from
  "./meeting-knowledge-production-composition-fixtures.js";
import {
  createPlatformHistoricalMemory,
  historicalSyncLeaseDurationMs,
} from "../src/composition/historical-memory.js";
import {
  assertAggregateStageBudget,
  runQualificationStage,
} from "./meeting-knowledge-production-composition-diagnostics.js";

describe("Infinity production semantic qualification composition", () => {
  it("derives every durable lease above the separately bounded operation deadline", () => {
    expect(historicalSyncLeaseDurationMs(1_000)).toBe(31_000);
    expect(historicalSyncLeaseDurationMs(300_000)).toBe(330_000);
    expect(historicalSyncLeaseDurationMs(600_000)).toBe(630_000);
    expect(() => historicalSyncLeaseDurationMs(600_001)).toThrow(RangeError);
  });

  it("keeps aggregate stage ceilings below the outer timeout and aborts timed-out cleanup", async () => {
    expect(() => {
      assertAggregateStageBudget(600_000, [40_000, 160_000, 160_000, 100_000, 100_000]);
    })
      .not.toThrow();
    expect(() => {
      assertAggregateStageBudget(600_000, [300_000, 300_000]);
    })
      .toThrow(RangeError);

    vi.useFakeTimers();
    let aborted = false;
    try {
      const pending = runQualificationStage(
        "synthetic_cancellable_stage",
        1_000,
        [],
        (signal) => new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          }, { once: true });
        }),
      );
      const rejected = expect(pending).rejects.toThrow(
        "synthetic_cancellable_stage failed after 1000ms",
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await rejected;
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enables precomposed reads after readiness, revokes dynamically, and keeps deletion-only closed", async () => {
    const pool = new Pool({
      connectionString: "postgresql://synthetic.invalid/never-connected",
    });
    const infinity = await startDisposableInfinityHttpService();
    infinity.endpoint.setRuntimeQualificationReceipt({
      embeddingProfileDigestSha256:
        retainedProductionEmbeddingProfileAttestation.embeddingProfileDigestSha256,
      embeddingProfileId:
        retainedProductionEmbeddingProfileAttestation.embeddingProfile,
      serviceRevision:
        INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedServiceRevision,
    });
    const runtime = requiredHistoricalRuntime(
      pool, infinity, true, true, "test",
      retainedProductionEmbeddingProfileAttestation,
    );
    const deletionOnly = requiredHistoricalRuntime(pool, infinity, false, false, "test");
    try {
      // Retrieval/exhaustive adapters can be constructed before startup; only
      // execution-time authorization changes when readiness is established.
      expect(runtime.createFocusedRetrieval({
        authorize: async () => ({
          authorizationDigest: "synthetic",
          authorizationEpoch: "1",
          authorized: true,
          policyVersion: "synthetic.v1",
        }),
      })).toBeDefined();
      expect(runtime.searchEnabled()).toBe(false);
      expect(runtime.servingAuthorized()).toBe(false);
      await runtime.assertReady();
      expect(runtime.searchEnabled()).toBe(true);
      expect(runtime.servingAuthorized()).toBe(true);

      infinity.endpoint.setCapabilitiesQualified(false);
      await runtime.assertReady();
      expect(runtime.searchEnabled()).toBe(false);
      expect(runtime.servingAuthorized()).toBe(false);

      await deletionOnly.assertReady();
      expect(deletionOnly.searchEnabled()).toBe(false);
      expect(deletionOnly.servingAuthorized()).toBe(false);
    } finally {
      await runtime.close();
      await deletionOnly.close();
      await infinity.close();
      await pool.end();
    }
  }, 15_000);

  it("denies mock-qualified search without disabling the base deletion runtime", async () => {
    const pool = new Pool({
      connectionString: "postgresql://synthetic.invalid/never-connected",
    });
    const infinity = await startDisposableInfinityHttpService();
    const runtime = requiredHistoricalRuntime(pool, infinity, true, true, "production");
    try {
      await expect(runtime.assertReady()).resolves.toBeUndefined();
      expect(runtime.searchEnabled()).toBe(false);
      expect(runtime.servingAuthorized()).toBe(false);
    } finally {
      await runtime.close();
      await infinity.close();
      await pool.end();
    }
  });

});

describe("Infinity deletion-only transport qualification", () => {
  it.each([
    ["missing", null],
    ["wrong", {
      embeddingProfileDigestSha256:
        retainedProductionEmbeddingProfileAttestation.embeddingProfileDigestSha256,
      embeddingProfileId:
        retainedProductionEmbeddingProfileAttestation.embeddingProfile,
      serviceRevision: "f".repeat(40),
    }],
  ] as const)("keeps deletion-only reconciliation closed for %s service revision", async (
    _label,
    receipt,
  ) => {
    const connect = vi.fn();
    const query = vi.fn(async () => ({ rowCount: 0, rows: [] }));
    const pool = { connect, query } as unknown as Pool;
    const infinity = await startDisposableInfinityHttpService();
    infinity.endpoint.setRuntimeQualificationReceipt(receipt);
    const runtime = createPlatformHistoricalMemory({
      config: platformConfig(infinity.baseUrl, false, false, "test"),
      logger: silentLogger,
      pool,
      profileMaintenance: {
        enqueueAppliedProfileRebuilds: async () => ({
          enqueued: 0,
          remaining: false,
        }),
      },
      runtimeTransport: syntheticCoverageRuntime,
    });
    if (runtime === undefined) {
      throw new Error("invalid transport fixture did not compose");
    }
    try {
      await expect(runtime.assertReady()).resolves.toBeUndefined();
      await expect(runtime.assertReady()).resolves.toBeUndefined();
      await runtime.start();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
      expect(query).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
      const requests = infinity.endpoint.requests.map(({ method, path }) => `${method} ${path}`);
      expect(requests.length).toBeGreaterThanOrEqual(3);
      expect(requests.every((request) => request === "GET /v1/capabilities"))
        .toBe(true);
      expect(runtime.searchEnabled()).toBe(false);
      expect(runtime.servingAuthorized()).toBe(false);
    } finally {
      await runtime.close();
      await infinity.close();
    }
  });
  it("keeps exact transport available when semantic projection is unqualified", async () => {
    const connect = vi.fn();
    const query = vi.fn(async () => ({ rowCount: 0, rows: [] }));
    const pool = { connect, query } as unknown as Pool;
    const infinity = await startDisposableInfinityHttpService();
    infinity.endpoint.setRuntimeQualificationReceipt({
      embeddingProfileDigestSha256:
        retainedProductionEmbeddingProfileAttestation.embeddingProfileDigestSha256,
      embeddingProfileId:
        retainedProductionEmbeddingProfileAttestation.embeddingProfile,
      serviceRevision:
        INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedServiceRevision,
    });
    const runtime = createPlatformHistoricalMemory({
      config: platformConfig(
        infinity.baseUrl,
        true,
        true,
        "production",
        retainedProductionEmbeddingProfileAttestation,
      ),
      logger: silentLogger,
      pool,
      profileMaintenance: {
        enqueueAppliedProfileRebuilds: async () => ({
          enqueued: 0,
          remaining: false,
        }),
      },
      runtimeTransport: syntheticCoverageRuntime,
    });
    if (runtime === undefined) {
      throw new Error("active transport fixture did not compose");
    }
    try {
      await runtime.assertReady();
      await runtime.start();
      await vi.waitFor(() => {
        expect(connect).toHaveBeenCalled();
      });
      expect(runtime.searchEnabled()).toBe(false);
      expect(runtime.servingAuthorized()).toBe(false);
      expect(infinity.endpoint.requests.every(({ path }) =>
        path === "/v1/capabilities"
      )).toBe(true);
    } finally {
      await runtime.close();
      await infinity.close();
    }
  });
});

describe("Infinity production semantic qualification continuation", () => {

  it("keeps production search closed without explicit semantic qualification", async () => {
    const pool = new Pool({
      connectionString: "postgresql://synthetic.invalid/never-connected",
    });
    const infinity = await startDisposableInfinityHttpService();
    infinity.endpoint.setRuntimeQualificationReceipt({
      embeddingProfileDigestSha256:
        retainedProductionEmbeddingProfileAttestation.embeddingProfileDigestSha256,
      embeddingProfileId:
        retainedProductionEmbeddingProfileAttestation.embeddingProfile,
      serviceRevision:
        INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedServiceRevision,
    });
    const runtime = createPlatformHistoricalMemory({
      config: platformConfig(
        infinity.baseUrl,
        true,
        true,
        "production",
        retainedProductionEmbeddingProfileAttestation,
      ),
      logger: silentLogger,
      pool,
      profileMaintenance: {
        enqueueAppliedProfileRebuilds: async () => ({
          enqueued: 0,
          remaining: false,
        }),
      },
      runtimeTransport: syntheticCoverageRuntime,
    });
    expect(runtime).toBeDefined();
    if (runtime === undefined) {
      throw new Error("source policy fixture did not compose");
    }
    try {
      await expect(runtime.assertReady()).resolves.toBeUndefined();
      expect(runtime.searchEnabled()).toBe(false);
      expect(runtime.servingAuthorized()).toBe(false);

      infinity.endpoint.setCapabilitiesQualified(false);
      await runtime.assertReady();
      expect(runtime.searchEnabled()).toBe(false);
      expect(runtime.servingAuthorized()).toBe(false);
    } finally {
      await runtime.close();
      await infinity.close();
      await pool.end();
    }
  });

  it("does not treat the Meeting release SHA as Infinity semantic authority", async () => {
    const pool = new Pool({
      connectionString: "postgresql://synthetic.invalid/never-connected",
    });
    const infinity = await startDisposableInfinityHttpService();
    infinity.endpoint.setRuntimeQualificationReceipt({
      embeddingProfileDigestSha256:
        retainedProductionEmbeddingProfileAttestation.embeddingProfileDigestSha256,
      embeddingProfileId:
        retainedProductionEmbeddingProfileAttestation.embeddingProfile,
      serviceRevision:
        INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedServiceRevision,
    });
    const runtime = createPlatformHistoricalMemory({
      config: platformConfig(
        infinity.baseUrl,
        true,
        true,
        "production",
        retainedProductionEmbeddingProfileAttestation,
        "f".repeat(40),
      ),
      logger: silentLogger,
      pool,
      profileMaintenance: {
        enqueueAppliedProfileRebuilds: async () => ({
          enqueued: 0,
          remaining: false,
        }),
      },
      productionQualification: testProductionQualificationPolicy,
      runtimeTransport: syntheticCoverageRuntime,
    });
    if (runtime === undefined) {
      throw new Error("stale-release fixture did not compose");
    }
    try {
      await expect(runtime.assertReady()).resolves.toBeUndefined();
      expect(runtime.searchEnabled()).toBe(true);
      expect(runtime.servingAuthorized()).toBe(true);
    } finally {
      await runtime.close();
      await infinity.close();
      await pool.end();
    }
  }, 15_000);

  it("keeps production search closed when the endpoint instance echo drifts", async () => {
    const pool = new Pool({
      connectionString: "postgresql://synthetic.invalid/never-connected",
    });
    const infinity = await startDisposableInfinityHttpService();
    infinity.endpoint.setRuntimeQualificationReceipt({
      embeddingProfileDigestSha256: `sha256:${"f".repeat(64)}`,
      embeddingProfileId:
        retainedProductionEmbeddingProfileAttestation.embeddingProfile,
      serviceRevision:
        INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedServiceRevision,
    });
    const runtime = requiredHistoricalRuntime(
      pool,
      infinity,
      true,
      true,
      "production",
      retainedProductionEmbeddingProfileAttestation,
    );
    try {
      await expect(runtime.assertReady()).resolves.toBeUndefined();
      expect(runtime.searchEnabled()).toBe(false);
      expect(runtime.servingAuthorized()).toBe(false);
    } finally {
      await runtime.close();
      await infinity.close();
      await pool.end();
    }
  });
});
