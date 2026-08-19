import { describe, expect, it } from "vitest";
import { InfinityContextClient } from "@infinity-context/sdk";

import {
  buildHistoricalIndexPlan,
  historicalEmbeddingTokenProfile,
} from "@discord-meeting/meeting-core/meeting-knowledge";

import {
  HmacHistoricalOpaqueIds,
  InfinityContextHistoricalMemoryAdapter,
  PinnedMultilingualMiniLmTokenizer,
} from "../src/index.js";
import { DisposableInfinityEndpoint } from "./disposable-infinity-endpoint.js";
import { finalMeeting } from "./historical-e2e-test-kit.js";

const tokenizer = new PinnedMultilingualMiniLmTokenizer();

function fixture() {
  const base = finalMeeting(1, "Tuesday");
  const meeting = {
    ...base,
    humanTurns: [base.humanTurns[0]!, {
      ...base.humanTurns[0]!,
      endMs: 3_000,
      startMs: 2_000,
      text: "Second bounded turn",
      turnId: "second-bounded-turn",
    }],
  };
  const plan = buildHistoricalIndexPlan(
    meeting,
    new HmacHistoricalOpaqueIds(new Uint8Array(32).fill(0x53)),
    {
      maximumEmbeddingTokens: 96,
      maxBlockUtf8Bytes: 4_096,
      maxBlocksPerMeeting: 2,
      maxTurnsPerBlock: 1,
      turnOverlap: 0,
      version: "meeting-knowledge.block-policy.v1",
    },
    tokenizer,
  );
  return { plan, request: {
    deleteMutationId: plan.deleteMutationId,
    documentExternalIds: plan.documents.map(({ manifest }) => manifest.documentExternalId),
    mode: "release" as const,
    reconciliationDocuments: plan.documents,
    remoteDocumentIds: {},
    schemaVersion: 1 as const,
    topology: plan.topology,
  } };
}

function adapter(endpoint: DisposableInfinityEndpoint) {
  return new InfinityContextHistoricalMemoryAdapter({
    baseUrl: "http://disposable.infinity.invalid",
    embeddingTokenProfile: () => historicalEmbeddingTokenProfile(tokenizer),
    requestTimeoutMs: 1_000,
    schemaVersion: 1,
    transport: endpoint,
  });
}

async function ingest(
  endpoint: DisposableInfinityEndpoint,
  topology: ReturnType<typeof fixture>["plan"]["topology"],
  sourceExternalId: string,
  input: { readonly sourceType?: string; readonly threadExternalRef?: string } = {},
): Promise<string> {
  const client = new InfinityContextClient({
    baseUrl: "http://disposable.infinity.invalid",
    retryPolicy: { maxAttempts: 1 },
    timeoutMs: 1_000,
    transport: endpoint,
  });
  return (await client.documents.ingestDocument({
    idempotencyKey: `seed-${sourceExternalId}-${endpoint.requests.length}`,
    memoryScopeExternalRef: topology.roomScopeExternalRef,
    sourceExternalId,
    sourceType: input.sourceType ?? "meeting_final_human_evidence",
    spaceSlug: topology.spaceSlug,
    text: "synthetic reconciliation seed",
    threadExternalRef: input.threadExternalRef ?? topology.threadExternalRef,
    title: "reconciliation seed",
  })).data.id;
}

function deletionRequests(endpoint: DisposableInfinityEndpoint, start: number) {
  return endpoint.requests.slice(start);
}

function expectNoDeletionPost(endpoint: DisposableInfinityEndpoint, start: number): void {
  expect(deletionRequests(endpoint, start).filter(({ method }) => method === "POST"))
    .toEqual([]);
}

describe("Infinity Context delete reconciliation contract", () => {
  it.each([
    ["mismatched sets", ({ plan, request }: ReturnType<typeof fixture>) => ({
      ...request, reconciliationDocuments: plan.documents.slice(0, 1),
    })],
    ["duplicate external IDs", ({ plan, request }: ReturnType<typeof fixture>) => ({
      ...request,
      reconciliationDocuments: [plan.documents[0]!, {
        ...plan.documents[1]!,
        manifest: {
          ...plan.documents[1]!.manifest,
          documentExternalId: plan.documents[0]!.manifest.documentExternalId,
        },
      }],
    })],
    ["duplicate mutation IDs", ({ plan, request }: ReturnType<typeof fixture>) => ({
      ...request,
      reconciliationDocuments: [plan.documents[0]!, {
        ...plan.documents[1]!, mutationId: plan.documents[0]!.mutationId,
      }],
    })],
    ["duplicate ordinals", ({ plan, request }: ReturnType<typeof fixture>) => ({
      ...request,
      reconciliationDocuments: [plan.documents[0]!, {
        ...plan.documents[1]!,
        manifest: { ...plan.documents[1]!.manifest, ordinal: plan.documents[0]!.manifest.ordinal },
      }],
    })],
    ["generation mismatch", ({ plan, request }: ReturnType<typeof fixture>) => ({
      ...request,
      reconciliationDocuments: [{
        ...plan.documents[0]!,
        manifest: { ...plan.documents[0]!.manifest, indexGeneration: "wrong-generation" },
      }, plan.documents[1]!],
    })],
  ])("rejects %s before contacting the provider", async (_name, mutate) => {
    const endpoint = new DisposableInfinityEndpoint();
    const memory = adapter(endpoint);

    await expect(memory.deleteMeeting(mutate(fixture()))).resolves.toEqual({
      code: "memory.invalid_delete_request",
      retryable: false,
      status: "rejected",
    });
    expect(endpoint.requests).toEqual([]);
  });

  it("recovers a stale missing ID through exact-scope listing without POST", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    const memory = adapter(endpoint);
    const { plan, request } = fixture();
    const indexed = await memory.indexFinalMeeting(plan);
    expect(indexed.status).toBe("applied");
    const start = endpoint.requests.length;

    await expect(memory.deleteMeeting({
      ...request,
      remoteDocumentIds: Object.fromEntries(request.documentExternalIds.map(
        (externalId, index) => [externalId, `missing-stored-id-${index}`],
      )),
    })).resolves.toEqual({ status: "verified_absent" });

    expect(endpoint.documentCount()).toBe(0);
    expect(endpoint.requests.some(({ method, path }) =>
      method === "GET" && path === "/v1/documents"
    )).toBe(true);
    expectNoDeletionPost(endpoint, start);
    expect(endpoint.requests.some(({ method, path }) =>
      method === "DELETE" && /^\/v1\/documents\/document-\d+$/u.test(path)
    )).toBe(true);
  });

  it("does not materialize a document when no canonical remote row exists", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    const memory = adapter(endpoint);
    const { request } = fixture();

    const start = endpoint.requests.length;
    await expect(memory.deleteMeeting({
      ...request,
      remoteDocumentIds: Object.fromEntries(request.documentExternalIds.map(
        (externalId, index) => [externalId, `missing-stored-id-${index}`],
      )),
    })).resolves.toEqual({ status: "verified_absent" });

    expect(endpoint.documentCount()).toBe(0);
    expectNoDeletionPost(endpoint, start);
  });

  it("walks deterministic cursor pages through the last target", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    endpoint.configureScopeList(1);
    const memory = adapter(endpoint);
    const { plan, request } = fixture();
    const indexed = await memory.indexFinalMeeting(plan);
    expect(indexed.status).toBe("applied");
    const start = endpoint.requests.length;

    await expect(memory.deleteMeeting({
      ...request,
      remoteDocumentIds: indexed.status === "applied" ? indexed.remoteDocumentIds : {},
    })).resolves.toEqual({ status: "verified_absent" });

    const listRequests = deletionRequests(endpoint, start).filter(({ method, path }) =>
      method === "GET" && path === "/v1/documents"
    );
    expect(listRequests.some(({ query }) => query.includes("cursor=1"))).toBe(true);
    expect(listRequests.every(({ query }) =>
      query.includes(`space_slug=${encodeURIComponent(plan.topology.spaceSlug)}`) &&
      query.includes(`memory_scope_external_ref=${encodeURIComponent(plan.topology.roomScopeExternalRef)}`) &&
      query.includes(`thread_external_ref=${encodeURIComponent(plan.topology.threadExternalRef)}`) &&
      query.includes("status=active")
    )).toBe(true);
    expect(endpoint.documentCount()).toBe(0);
    expectNoDeletionPost(endpoint, start);
  });

  it.each(["missing", "oversized", "repeated"] as const)(
    "fails closed on a %s scope-list cursor chain",
    async (fault) => {
      const endpoint = new DisposableInfinityEndpoint();
      endpoint.configureScopeList(1, fault);
      const memory = adapter(endpoint);
      const { plan, request } = fixture();
      const indexed = await memory.indexFinalMeeting(plan);
      expect(indexed.status).toBe("applied");
      const start = endpoint.requests.length;

      await expect(memory.deleteMeeting({
        ...request,
        remoteDocumentIds: indexed.status === "applied" ? indexed.remoteDocumentIds : {},
      })).resolves.toMatchObject({
        code: "memory.invalid_sdk_response",
        retryable: false,
        status: "absence_unverified",
      });
      expect(endpoint.documentCount()).toBe(plan.documents.length);
      expectNoDeletionPost(endpoint, start);
    },
  );

  it("discards a wrong foreign ID and preserves foreign scope and source rows", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    const memory = adapter(endpoint);
    const { plan, request } = fixture();
    const indexed = await memory.indexFinalMeeting(plan);
    expect(indexed.status).toBe("applied");
    const externalId = request.documentExternalIds[0]!;
    const foreignId = await ingest(endpoint, plan.topology, externalId, {
      threadExternalRef: `${plan.topology.threadExternalRef}-foreign`,
    });
    await ingest(endpoint, plan.topology, externalId, { sourceType: "foreign_source" });
    const start = endpoint.requests.length;

    await expect(memory.deleteMeeting({
      ...request,
      remoteDocumentIds: { ...(
        indexed.status === "applied" ? indexed.remoteDocumentIds : {}
      ), [externalId]: foreignId },
    })).resolves.toEqual({ status: "verified_absent" });

    expect(endpoint.documentIds()).toContain(foreignId);
    expect(endpoint.documentCount()).toBe(2);
    expectNoDeletionPost(endpoint, start);
  });

  it("deletes every canonical duplicate found in the exact scope", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    const memory = adapter(endpoint);
    const { plan, request } = fixture();
    const indexed = await memory.indexFinalMeeting(plan);
    expect(indexed.status).toBe("applied");
    const externalId = request.documentExternalIds[0]!;
    await ingest(endpoint, plan.topology, externalId);
    const start = endpoint.requests.length;

    await expect(memory.deleteMeeting({
      ...request,
      remoteDocumentIds: indexed.status === "applied" ? indexed.remoteDocumentIds : {},
    })).resolves.toEqual({ status: "verified_absent" });

    expect(endpoint.documentCount()).toBe(0);
    expect(deletionRequests(endpoint, start).filter(({ method }) => method === "DELETE"))
      .toHaveLength(plan.documents.length + 1);
    expectNoDeletionPost(endpoint, start);
  });

  it("converges after a crash-window partial delete with a fresh adapter", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    const { plan, request } = fixture();
    const indexed = await adapter(endpoint).indexFinalMeeting(plan);
    expect(indexed.status).toBe("applied");
    const deleteRequest = {
      ...request,
      remoteDocumentIds: indexed.status === "applied" ? indexed.remoteDocumentIds : {},
    };
    endpoint.failDocumentDeleteAfter(1);
    const start = endpoint.requests.length;

    await expect(adapter(endpoint).deleteMeeting(deleteRequest)).resolves.toMatchObject({
      status: "absence_unverified",
    });
    expect(endpoint.documentCount()).toBe(1);
    await expect(adapter(endpoint).deleteMeeting(deleteRequest)).resolves.toEqual({
      status: "verified_absent",
    });

    expect(endpoint.documentCount()).toBe(0);
    expectNoDeletionPost(endpoint, start);
  });

  it("reconciles a lost DELETE response with GET and a final scope scan", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    const memory = adapter(endpoint);
    const { plan, request } = fixture();
    const indexed = await memory.indexFinalMeeting(plan);
    expect(indexed.status).toBe("applied");
    endpoint.loseNextDocumentDeleteResponse();
    const start = endpoint.requests.length;

    await expect(memory.deleteMeeting({
      ...request,
      remoteDocumentIds: indexed.status === "applied" ? indexed.remoteDocumentIds : {},
    })).resolves.toEqual({ status: "verified_absent" });

    expect(endpoint.documentCount()).toBe(0);
    expect(deletionRequests(endpoint, start).some(({ method, path }) =>
      method === "GET" && /^\/v1\/documents\/document-\d+$/u.test(path)
    )).toBe(true);
    expectNoDeletionPost(endpoint, start);
  });
});
