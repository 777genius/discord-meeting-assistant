import { describe, expect, it } from "vitest";

import {
  HistoricalSyncWorker,
  buildHistoricalIndexPlan,
  type HistoricalMemoryPort,
} from "@discord-meeting/meeting-core/meeting-knowledge";

import {
  HmacHistoricalOpaqueIds,
  InfinityContextHistoricalMemoryAdapter,
  PinnedMultilingualMiniLmTokenizer,
} from "../src/index.js";
import { DisposableInfinityEndpoint } from "./disposable-infinity-endpoint.js";
import {
  MemoryHistoricalAuthority,
  MemoryHistoricalStore,
  finalMeeting,
} from "./historical-e2e-test-kit.js";

const policy = Object.freeze({
  maximumEmbeddingTokens: 96,
  maxBlockUtf8Bytes: 4_096,
  maxBlocksPerMeeting: 500,
  maxTurnsPerBlock: 1,
  turnOverlap: 0,
  version: "meeting-knowledge.block-policy.v1" as const,
});
const exactTokenizer = new PinnedMultilingualMiniLmTokenizer();

function adapter(endpoint: DisposableInfinityEndpoint) {
  return new InfinityContextHistoricalMemoryAdapter({
    baseUrl: "http://disposable.infinity.invalid",
    operationTimeoutMs: 30_000,
    requestTimeoutMs: 1_000,
    schemaVersion: 1,
    transport: endpoint,
  });
}

describe("Infinity Context durable restart convergence", () => {
  it("finishes a partial ingest after a fresh worker and adapter restart", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    const ids = new HmacHistoricalOpaqueIds(new Uint8Array(32).fill(0x6b));
    const base = finalMeeting(1, "Tuesday");
    const meeting = Object.freeze({
      ...base,
      humanTurns: Object.freeze(Array.from({ length: 120 }, (_, index) =>
        Object.freeze({
          ...base.humanTurns[0]!,
          endMs: index * 10 + 9,
          startMs: index * 10,
          text: `restart evidence ${index}`,
          turnId: `restart-${index}`,
        })
      )),
    });
    const plan = buildHistoricalIndexPlan(meeting, ids, policy, exactTokenizer);
    const authority = new MemoryHistoricalAuthority();
    const store = new MemoryHistoricalStore();
    authority.put(meeting);
    await store.acceptRelease(meeting.binding);
    const firstAdapter = adapter(endpoint);
    const partialMemory: HistoricalMemoryPort = {
      deleteMeeting: firstAdapter.deleteMeeting.bind(firstAdapter),
      indexFinalMeeting: async (request, options) => {
        const partial = await firstAdapter.indexFinalMeeting({
          ...request,
          documents: request.documents.slice(0, 7),
        }, options);
        expect(partial.status).toBe("applied");
        return {
          code: "fixture.crash_after_partial_ingest",
          retryable: true,
          status: "outcome_unknown",
        };
      },
      searchRoom: firstAdapter.searchRoom.bind(firstAdapter),
    };
    const syncPolicy = {
      blockPolicy: policy,
      leaseDurationMs: 30_000,
      maximumIndexAttempts: 3,
      retryBackoffMs: [1],
      version: "meeting-knowledge.historical-sync.v1" as const,
    };
    const firstWorker = new HistoricalSyncWorker({
      authority,
      ids,
      memory: partialMemory,
      store,
      tokenizer: () => exactTokenizer,
    }, syncPolicy);

    await expect(firstWorker.executeOnce({ indexingEnabled: true })).resolves.toMatchObject({
      status: "retry_scheduled",
    });
    expect(endpoint.documentCount()).toBe(7);
    expect(store.state(meeting.binding.releaseId)).toBe("retry_wait");
    await expect(store.findCurrentCandidate(
      meeting.binding.scopeId,
      meeting.binding.roomId,
      plan.documents[0]!.manifest.candidateLocator,
    )).resolves.toBeNull();

    const restartedWorker = new HistoricalSyncWorker({
      authority,
      ids,
      memory: adapter(endpoint),
      store,
      tokenizer: () => exactTokenizer,
    }, syncPolicy);
    await expect(restartedWorker.executeOnce({ indexingEnabled: true })).resolves.toMatchObject({
      status: "applied",
    });

    expect(endpoint.documentCount()).toBe(120);
    expect(new Set(endpoint.documentIds()).size).toBe(120);
    expect(store.state(meeting.binding.releaseId)).toBe("applied");
    await expect(store.findCurrentCandidate(
      meeting.binding.scopeId,
      meeting.binding.roomId,
      plan.documents[0]!.manifest.candidateLocator,
    )).resolves.toMatchObject({ ordinal: 0 });
    for (const document of plan.documents.slice(0, 7)) {
      expect(endpoint.requests.filter(({ idempotencyKey, method, path }) =>
        method === "POST" && path === "/v1/documents" &&
        idempotencyKey === document.mutationId
      )).toHaveLength(1);
      expect(endpoint.requests.filter(({ idempotencyKey, method, path }) =>
        method === "POST" && path.endsWith("/process") &&
        idempotencyKey === `${document.mutationId}:process`
      )).toHaveLength(2);
    }
  });
});
