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

function adapter(endpoint: DisposableInfinityEndpoint) {
  return new InfinityContextLiveFinalizedMemoryAdapter({
    actorKeys: { activeActorKey: () => "dactor1.r1.opaque-human" },
    baseUrl: "http://disposable.infinity.invalid",
    ids,
    operationTimeoutMs: 2_000,
    requestTimeoutMs: 1_000,
    schemaVersion: 1,
    token: "test-token",
    transport: endpoint,
  });
}

describe("Infinity finalized-live-memory ACL", () => {
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
  });

  it("reports exact absence so the application may retry the same mutation", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    const memory = adapter(endpoint);
    // Establish only the opaque topology; this other document cannot satisfy reconciliation.
    await memory.upsert({ ...projection(), documentId: "other-document", mutationId: "c".repeat(64) });

    await expect(memory.reconcile(projection())).resolves.toEqual({ status: "not_found" });
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
    expect(endpoint.requests.filter(({ method }) => method === "DELETE")).toHaveLength(1);
  });
});
