import { describe, expect, it, vi } from "vitest";

import { buildHistoricalIndexPlan } from
  "@discord-meeting/meeting-core/meeting-knowledge";

import {
  HmacHistoricalOpaqueIds,
  InfinityContextHistoricalMemoryAdapter,
} from "../src/index.js";
import { DisposableInfinityEndpoint } from "./disposable-infinity-endpoint.js";
import { finalMeeting } from "./historical-e2e-test-kit.js";

const blockPolicy = {
  maxBlockUtf8Bytes: 512,
  maxBlocksPerMeeting: 100,
  maxTurnsPerBlock: 64,
  version: "meeting-knowledge.block-policy.v1",
} as const;

function plan(seed: number) {
  return buildHistoricalIndexPlan(
    finalMeeting(1, "Tuesday"),
    new HmacHistoricalOpaqueIds(new Uint8Array(32).fill(seed)),
    blockPolicy,
  );
}

describe("Infinity Context SDK request and resumable operation deadlines", () => {
  it("indexes and drains a maximum-size valid plan with fresh request deadlines", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    endpoint.delayEveryRequest(8);
    const seed = plan(0x73);
    const source = seed.documents[0];
    if (source === undefined) {
      throw new Error("large deadline fixture produced no source document");
    }
    const largePlan = {
      ...seed,
      documents: Object.freeze(Array.from({ length: 100 }, (_, ordinal) => ({
        ...source,
        manifest: {
          ...source.manifest,
          candidateLocator: `${source.manifest.candidateLocator}-${ordinal}`,
          documentExternalId: `${source.manifest.documentExternalId}-${ordinal}`,
          ordinal,
        },
        mutationId: `${source.mutationId}-${ordinal}`,
        remoteText: `${source.remoteText}\nfixture=${ordinal}`,
        title: `${source.title}-${ordinal}`,
      }))),
    };
    const adapter = new InfinityContextHistoricalMemoryAdapter({
      baseUrl: "http://disposable.infinity.invalid",
      operationTimeoutMs: 30_000,
      requestTimeoutMs: 1_000,
      schemaVersion: 1,
      transport: endpoint,
    });
    const started = performance.now();
    const indexed = await adapter.indexFinalMeeting(largePlan);
    const indexDurationMs = performance.now() - started;
    if (indexed.status !== "applied") {
      throw new Error(`maximum-size index failed: ${JSON.stringify(indexed)}`);
    }
    expect(Object.keys(indexed.remoteDocumentIds)).toHaveLength(100);
    // More than 200 bounded SDK calls make aggregate wall time exceed one
    // request deadline. A shared 1s signal deterministically fails here;
    // fresh per-call deadlines remain comfortably above each 8ms request.
    expect(indexDurationMs).toBeGreaterThan(1_000);
    await expect(adapter.deleteMeeting({
      deleteMutationId: largePlan.deleteMutationId,
      documentExternalIds: largePlan.documents.map(({ manifest }) =>
        manifest.documentExternalId
      ),
      mode: "release",
      remoteDocumentIds: indexed.remoteDocumentIds,
      schemaVersion: 1,
      topology: largePlan.topology,
    })).resolves.toEqual({ status: "verified_absent" });
    expect(endpoint.documentCount()).toBe(0);
  }, 30_000);

  it("composes caller cancellation and removes its listener", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    endpoint.hangNextRequestUntilDeadline("/v1/spaces");
    const adapter = new InfinityContextHistoricalMemoryAdapter({
      baseUrl: "http://disposable.infinity.invalid",
      operationTimeoutMs: 1_000,
      requestTimeoutMs: 500,
      schemaVersion: 1,
      transport: endpoint,
    });
    const caller = new AbortController();
    const added = vi.spyOn(caller.signal, "addEventListener");
    const removed = vi.spyOn(caller.signal, "removeEventListener");
    const pending = adapter.indexFinalMeeting(plan(0x74), { signal: caller.signal });
    setTimeout(() => {
      caller.abort(new DOMException("caller stopped", "AbortError"));
    }, 10);
    await expect(pending).resolves.toMatchObject({
      retryable: true,
      status: "outcome_unknown",
    });
    expect(endpoint.requests).toHaveLength(1);
    expect(added.mock.calls.filter(([type]) => type === "abort")).toHaveLength(1);
    expect(removed.mock.calls.filter(([type]) => type === "abort")).toHaveLength(1);
  });

  it("distinguishes a per-call timeout from overall budget exhaustion", async () => {
    const perCallEndpoint = new DisposableInfinityEndpoint();
    perCallEndpoint.hangNextRequestUntilDeadline("/v1/spaces");
    const perCall = new InfinityContextHistoricalMemoryAdapter({
      baseUrl: "http://disposable.infinity.invalid",
      operationTimeoutMs: 500,
      requestTimeoutMs: 20,
      schemaVersion: 1,
      transport: perCallEndpoint,
    });
    await expect(perCall.indexFinalMeeting(plan(0x75))).resolves.toMatchObject({
      retryable: true,
      status: "outcome_unknown",
    });
    expect(perCallEndpoint.requests).toHaveLength(1);

    const overallEndpoint = new DisposableInfinityEndpoint();
    overallEndpoint.delayEveryRequest(18);
    const overall = new InfinityContextHistoricalMemoryAdapter({
      baseUrl: "http://disposable.infinity.invalid",
      operationTimeoutMs: 55,
      requestTimeoutMs: 40,
      schemaVersion: 1,
      transport: overallEndpoint,
    });
    await expect(overall.indexFinalMeeting(plan(0x76))).resolves.toMatchObject({
      retryable: true,
      status: "outcome_unknown",
    });
    expect(overallEndpoint.requests.length).toBeGreaterThan(1);
    expect(overallEndpoint.documentCount()).toBe(0);
  });
});
