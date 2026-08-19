import { describe, expect, it } from "vitest";

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

  it("recovers and deletes the canonical document behind a stale missing ID", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    const memory = adapter(endpoint);
    const { plan, request } = fixture();
    const indexed = await memory.indexFinalMeeting(plan);
    expect(indexed.status).toBe("applied");
    const processCount = endpoint.requests.filter(({ path }) =>
      path.endsWith("/process")
    ).length;

    await expect(memory.deleteMeeting({
      ...request,
      remoteDocumentIds: Object.fromEntries(request.documentExternalIds.map(
        (externalId, index) => [externalId, `missing-stored-id-${index}`],
      )),
    })).resolves.toEqual({ status: "verified_absent" });

    expect(endpoint.documentCount()).toBe(0);
    expect(endpoint.requests.some(({ method, path }) =>
      method === "GET" && path === "/v1/documents"
    )).toBe(false);
    expect(endpoint.requests.filter(({ path }) => path.endsWith("/process")))
      .toHaveLength(processCount);
    expect(endpoint.requests.some(({ method, path }) =>
      method === "DELETE" && /^\/v1\/documents\/document-\d+$/u.test(path)
    )).toBe(true);
  });

  it("materializes an unprocessed canonical document solely to verify deletion", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    const memory = adapter(endpoint);
    const { plan, request } = fixture();

    await expect(memory.deleteMeeting({
      ...request,
      remoteDocumentIds: Object.fromEntries(request.documentExternalIds.map(
        (externalId, index) => [externalId, `missing-stored-id-${index}`],
      )),
    })).resolves.toEqual({ status: "verified_absent" });

    expect(endpoint.documentCount()).toBe(0);
    expect(endpoint.requests.filter(({ method, path }) =>
      method === "POST" && path === "/v1/documents"
    )).toHaveLength(plan.documents.length);
    expect(endpoint.requests.some(({ path }) => path.endsWith("/process"))).toBe(false);
    expect(endpoint.requests.some(({ method, path }) =>
      method === "GET" && path === "/v1/documents"
    )).toBe(false);
  });
});
