import type { LiveFinalizedMemoryProjectionV1 } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { describe, expect, it } from "vitest";

import {
  HmacHistoricalOpaqueIds,
  InfinityContextLiveFinalizedMemoryAdapter,
} from "../src/index.js";
import { DisposableInfinityEndpoint } from "./disposable-infinity-endpoint.js";

const ids = new HmacHistoricalOpaqueIds(new Uint8Array(32).fill(0x61));

function projection(): LiveFinalizedMemoryProjectionV1 {
  return {
    documentId: ids.keyedId("live-finalized-turn-document.v1", [
      "scope-secret", "room-secret", "meeting-secret", "turn-1",
    ]),
    generation: 3,
    meetingId: "meeting-secret",
    mutationId: "a".repeat(64),
    ordinal: 7,
    roomId: "room-secret",
    scopeId: "scope-secret",
    turn: {
      endMs: 2_000,
      speakerId: "human-1",
      startMs: 1_000,
      text: "The launch owner is Ana.",
      turnId: "turn-1",
    },
    turnHash: "b".repeat(64),
  };
}

function projectionAt(ordinal: number): LiveFinalizedMemoryProjectionV1 {
  const turnId = `turn-${ordinal}`;
  return {
    ...projection(),
    documentId: ids.keyedId("live-finalized-turn-document.v1", [
      "scope-secret", "room-secret", "meeting-secret", turnId,
    ]),
    mutationId: ids.keyedId("live-finalized-turn-mutation.v1", [turnId]),
    ordinal,
    turn: { ...projection().turn, turnId },
  };
}

function adapter(endpoint: DisposableInfinityEndpoint) {
  return new InfinityContextLiveFinalizedMemoryAdapter({
    actorKeys: { activeActorKey: () => "dactor1.r1.opaque-human" },
    baseUrl: "http://disposable.infinity.invalid",
    exactDocuments: endpoint.exactDocumentSdk(),
    ids,
    operationTimeoutMs: 2_000,
    requestTimeoutMs: 1_000,
    schemaVersion: 1,
    token: "test-token",
    transport: endpoint,
  });
}

describe("Infinity finalized-live-memory ACL", () => {
  it("starts without exact reconciliation and fails closed on projection calls", async () => {
      const memory = new InfinityContextLiveFinalizedMemoryAdapter({
        actorKeys: { activeActorKey: () => "dactor1.r1.opaque-human" },
        baseUrl: "http://disposable.infinity.invalid", ids, operationTimeoutMs: 2_000,
        requestTimeoutMs: 1_000, schemaVersion: 1, token: "test-token",
        transport: new DisposableInfinityEndpoint(),
      });
      await expect(memory.upsert(projection())).resolves.toEqual({
        code: "memory.live_exact_reconciliation_unavailable", retryable: false, status: "rejected",
      });
    });

  it("rejects an unsupported runtime configuration schema", () => {
    expect(() => new InfinityContextLiveFinalizedMemoryAdapter({
      actorKeys: { activeActorKey: () => "dactor1.r1.opaque-human" },
      baseUrl: "http://disposable.infinity.invalid",
      exactDocuments: new DisposableInfinityEndpoint().exactDocumentSdk(),
      ids,
      operationTimeoutMs: 2_000,
      requestTimeoutMs: 1_000,
      schemaVersion: 2,
      token: "test-token",
      transport: new DisposableInfinityEndpoint(),
    })).toThrow("Infinity live memory configuration is invalid");
  });

  it("uses the official SDK with opaque stable identity and finalized human text only", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    await expect(adapter(endpoint).upsert(projection())).resolves.toEqual({
      status: "applied",
    });

    expect(endpoint.indexedTexts()).toEqual(["The launch owner is Ana."]);
    const wire = JSON.stringify(endpoint.requests);
    expect(wire).not.toContain("meeting-secret");
    expect(wire).not.toContain("scope-secret");
    expect(wire).not.toContain("room-secret");
    expect(endpoint.requests.filter(({ method, path }) =>
      method === "POST" && path === "/v1/documents"
    )).toHaveLength(1);
    expect(endpoint.requests.filter(({ method }) => method === "GET"))
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "/v1/documents" }),
      ]));
  });

  it("reconciles a committed response loss without issuing a duplicate ingest", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    endpoint.loseNextIngestResponse();
    const memory = adapter(endpoint);

    await expect(memory.upsert(projection())).resolves.toMatchObject({
      status: "outcome_unknown",
    });
    expect(endpoint.documentCount()).toBe(1);
    await expect(memory.reconcile(projection())).resolves.toEqual({ status: "applied" });
    expect(endpoint.requests.filter(({ method, path }) =>
      method === "POST" && path === "/v1/documents"
    )).toHaveLength(1);
    expect(endpoint.exactDocumentRequests).toEqual([{
      documentId: projection().documentId,
      operation: "reconcile",
    }]);
  });

  it("reports exact absence so the application may retry the same mutation", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    const memory = adapter(endpoint);
    // Establish only the opaque topology; this other document cannot satisfy reconciliation.
    await memory.upsert({ ...projection(), documentId: "other-document", mutationId: "c".repeat(64) });

    await expect(memory.reconcile(projection())).resolves.toEqual({ status: "not_found" });
  });

  it("fails closed when an exact identity is presented under another scope", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    const memory = adapter(endpoint);
    await expect(memory.upsert(projection())).resolves.toEqual({ status: "applied" });

    await expect(memory.reconcile({
      ...projection(),
      roomId: "foreign-room",
      scopeId: "foreign-scope",
    })).resolves.toMatchObject({ status: "outcome_unknown" });
    expect(endpoint.documentCount()).toBe(1);
  });

  it("retires a superseded live generation and reconciles a lost delete response", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    const memory = adapter(endpoint);
    await memory.upsert(projection());
    endpoint.loseNextDocumentDeleteResponse();

    await expect(memory.remove(projection())).resolves.toMatchObject({
      status: "outcome_unknown",
    });
    expect(endpoint.documentCount()).toBe(0);
    await expect(memory.reconcileRemoval(projection())).resolves.toEqual({
      status: "applied",
    });
    expect(endpoint.requests.filter(({ method }) => method === "DELETE")).toHaveLength(0);
    expect(endpoint.exactDocumentRequests.map(({ operation }) => operation))
      .toEqual(["delete", "reconcile"]);
  });

  it.each([100, 101, 2_209])(
    "reconciles, restarts and retires %i exact documents to zero without scoped-list loops",
    async (count) => {
      const endpoint = new DisposableInfinityEndpoint();
      const first = adapter(endpoint);
      const projections = Array.from({ length: count }, (_value, index) =>
        projectionAt(index + 1));
      for (const item of projections) {
        await expect(first.upsert(item)).resolves.toEqual({ status: "applied" });
      }
      expect(endpoint.documentCount()).toBe(count);

      const restarted = adapter(endpoint);
      await expect(restarted.reconcile(projections.at(-1)!)).resolves.toEqual({
        status: "applied",
      });
      for (const [index, item] of projections.entries()) {
        if (index === Math.floor(count / 2)) {
          endpoint.loseNextDocumentDeleteResponse();
          await expect(restarted.remove(item)).resolves.toMatchObject({
            status: "outcome_unknown",
          });
          await expect(adapter(endpoint).reconcileRemoval(item)).resolves.toEqual({
            status: "applied",
          });
        } else {
          await expect(restarted.remove(item)).resolves.toEqual({ status: "applied" });
        }
      }

      expect(endpoint.documentCount()).toBe(0);
      expect(endpoint.requests.filter(({ method, path }) =>
        method === "GET" && path === "/v1/documents"
      )).toHaveLength(0);
      expect(endpoint.exactDocumentRequests).toHaveLength(count + 2);
    },
    120_000,
  );
});
