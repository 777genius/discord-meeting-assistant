import { describe, expect, it } from "vitest";
import { InfinityContextClient } from "@infinity-context/sdk";
import { createHash } from "node:crypto";

import {
  ExhaustiveCoverage,
  HistoricalFocusedRetrieval,
  HistoricalSyncWorker,
  historicalEmbeddingTokenProfile,
  buildHistoricalIndexPlan as buildCoreHistoricalIndexPlan,
  type AcceptedFinalMeetingV1,
  type CoverageExtractV1,
  type CoverageReducerPort,
  type HistoricalEvidenceBlockPolicyV1,
  type HistoricalOpaqueIdPort,
  type LocallyRehydratedEvidenceBlockV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";

import {
  HmacHistoricalOpaqueIds,
  INFINITY_CONTEXT_SDK_PROVENANCE,
  InfinityContextHistoricalMemoryAdapter,
  PinnedMultilingualMiniLmTokenizer,
  assertInfinityContextActivation,
  decodeInfinityContextRuntimeActivation,
} from "../src/index.js";
import {
  isHybridQualified,
  processMutationAccepted,
  validIndexPlan,
} from "../src/infinity-context-sdk-contract.js";
import { DisposableInfinityEndpoint } from "./disposable-infinity-endpoint.js";
import {
  MemoryCoverageCheckpoints,
  MemoryHistoricalAuthority,
  MemoryHistoricalStore,
  buildSameRoomFocusedPlan,
  finalMeeting,
} from "./historical-e2e-test-kit.js";

const blockPolicy = {
  maxBlockUtf8Bytes: 512,
  maxBlocksPerMeeting: 100,
  maxTurnsPerBlock: 64,
  version: "meeting-knowledge.block-policy.v1",
} as const;
const exactTokenizer = new PinnedMultilingualMiniLmTokenizer();

function buildHistoricalIndexPlan(
  meeting: AcceptedFinalMeetingV1,
  ids: HistoricalOpaqueIdPort,
  policy: HistoricalEvidenceBlockPolicyV1,
) {
  return buildCoreHistoricalIndexPlan(meeting, ids, policy, exactTokenizer);
}

function boundedWindowPlan(turnCount: number, maximumBlocks = turnCount) {
  const ids = new HmacHistoricalOpaqueIds(new Uint8Array(32).fill(0x4a));
  const base = finalMeeting(1, "Tuesday");
  const meeting = Object.freeze({
    ...base,
    humanTurns: Object.freeze(Array.from({ length: turnCount }, (_, index) =>
      Object.freeze({
        ...base.humanTurns[0]!,
        endMs: index * 10 + 9,
        startMs: index * 10,
        text: `bounded adapter turn ${index}`,
        turnId: `adapter-boundary-${index}`,
      })
    )),
  });
  return buildHistoricalIndexPlan(meeting, ids, {
    maximumEmbeddingTokens: 96,
    maxBlockUtf8Bytes: 4_096,
    maxBlocksPerMeeting: maximumBlocks,
    maxTurnsPerBlock: 1,
    turnOverlap: 0,
    version: "meeting-knowledge.block-policy.v1",
  });
}

function cedarExtract(block: LocallyRehydratedEvidenceBlockV1): CoverageExtractV1 {
  const selectedTurns = block.turns.filter(({ text }) =>
    text.includes("Cedar")
  ).map(({ turnId }) => ({
    blockLocator: block.candidateLocator,
    relevance: "direct" as const,
    turnId,
  }));
  return {
    blockLocator: block.candidateLocator,
    evidenceLocators: selectedTurns.length === 0 ? [] : [block.candidateLocator],
    payload: { cedarMentions: selectedTurns.length },
    selectedTurns,
    selectionStatus: selectedTurns.length === 0 ? "no_match" : "selected",
    schemaVersion: 1,
  };
}

function reduceCedar(
  values: Parameters<CoverageReducerPort["reduce"]>[0]["values"],
) {
  const reducedTurns = [...new Map(values.flatMap(({ selectedTurns }) =>
    selectedTurns.map((turn) => [
      `${turn.blockLocator}\u0000${turn.turnId}`,
      turn,
    ] as const)
  )).values()];
  return {
    evidenceLocators: [...new Set(
      reducedTurns.map(({ blockLocator }) => blockLocator),
    )],
    payload: {
      cedarMentions: values.reduce((total, value) =>
        total + (typeof value.payload.cedarMentions === "number"
          ? value.payload.cedarMentions
          : 0), 0),
    },
    selectedTurns: reducedTurns,
    selectionStatus: reducedTurns.length === 0 ? "no_match" as const : "selected" as const,
    schemaVersion: 1 as const,
  };
}


describe("Infinity Context official hybrid capability", () => {
  it("qualifies built-in lexical plus healthy Qdrant only from observed search evidence", () => {
    const officialCapabilities = {
      adapters: {
        qdrant: { enabled: true, healthy: true, supports_search: true },
      },
      capabilities: [{
        adapter_name: "qdrant",
        capability: "vector_recall",
        enabled: true,
        healthy: true,
        status: "ok",
      }],
      enabled_adapters: ["qdrant"],
      supports_qdrant: true,
    };
    expect(isHybridQualified(officialCapabilities, {
      keyword_chunks_considered: 17,
      retrieval_sources_used: ["qdrant", "keyword"],
      vector_status: "healthy",
    })).toBe(true);
    expect(isHybridQualified(officialCapabilities, {
      retrieval_sources_used: ["qdrant"],
      vector_status: "healthy",
    })).toBe(false);
  });
});

describe("Infinity Context bounded search budget", () => {
  it("uses the bounded service maximum so ranked evidence is not silently budget-dropped", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    const adapter = new InfinityContextHistoricalMemoryAdapter({
      baseUrl: "http://disposable.infinity.invalid", embeddingTokenProfile: () => historicalEmbeddingTokenProfile(exactTokenizer),
      requestTimeoutMs: 1_000,
      schemaVersion: 1,
      transport: endpoint,
    });
    await adapter.qualifyCapabilities();

    for (const candidateLimit of [1, 5, 16, 40]) {
      const result = await adapter.searchRoom({
        candidateLimit,
        query: "bounded evidence budget",
        roomScopeExternalRef: "room-scope",
        schemaVersion: 1,
        spaceSlug: "space-slug",
        timeoutMs: 1_000,
      });
      expect(result).toMatchObject({ status: "available" });
      if (result.status === "available") {
        expect(result.candidates.length).toBeLessThanOrEqual(candidateLimit);
      }
    }

    expect(endpoint.requests.filter(({ method, path }) =>
      method === "POST" && path === "/v1/search"
    ).map(({ body }) => body)).toEqual([
      expect.objectContaining({ max_chunks: 1, max_evidence_items: 1,
        project_anchor_policy: "advisory", token_budget: 6_000 }),
      expect.objectContaining({ max_chunks: 5, max_evidence_items: 5,
        project_anchor_policy: "advisory", token_budget: 6_000 }),
      expect.objectContaining({ max_chunks: 16, max_evidence_items: 16,
        project_anchor_policy: "advisory", token_budget: 6_000 }),
      expect.objectContaining({ max_chunks: 40, max_evidence_items: 40,
        project_anchor_policy: "advisory", token_budget: 6_000 }),
    ]);
  });
});

describe("Infinity Context bounded historical plan", () => {

  it("accepts 500 deterministic windows and rejects a 501-window domain policy", () => {
    expect(validIndexPlan(
      boundedWindowPlan(500, 500),
      historicalEmbeddingTokenProfile(exactTokenizer),
    )).toBe(true);
    expect(() => boundedWindowPlan(501, 501)).toThrow(
      "historical evidence block policy is outside its qualified bounds",
    );
  });

  it("converges a partial >100-window ingest within the bounded sequential envelope", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    const adapter = new InfinityContextHistoricalMemoryAdapter({
      baseUrl: "http://disposable.infinity.invalid", embeddingTokenProfile: () => historicalEmbeddingTokenProfile(exactTokenizer),
      operationTimeoutMs: 30_000,
      requestTimeoutMs: 1_000,
      schemaVersion: 1,
      transport: endpoint,
    });
    const plan = boundedWindowPlan(120);
    endpoint.loseNextIngestResponse();
    const startedAt = performance.now();

    await expect(adapter.indexFinalMeeting(plan)).resolves.toMatchObject({ status: "applied" });
    const elapsedMs = performance.now() - startedAt;
    expect(endpoint.documentCount()).toBe(120);
    expect(elapsedMs).toBeLessThan(30_000);
    expect(endpoint.requests.filter(({ method, path }) =>
      method === "POST" && path === "/v1/documents"
    ).length).toBeLessThanOrEqual(121);
  });

});

describe("Infinity Context historical memory vertical slice", () => {
  it("requires explicit process acceptance rather than document lifecycle status", () => {
    expect(processMutationAccepted({ id: "doc", status: "active", title: "fixture" }))
      .toBe(false);
    expect(processMutationAccepted({
      id: "doc",
      indexing_status: "pending",
      status: "active",
      title: "fixture",
    })).toBe(true);
  });

  it("fails closed when the unpageable official space listing is full", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    const client = new InfinityContextClient({
      baseUrl: "http://disposable.infinity.invalid",
      retryPolicy: { maxAttempts: 1 },
      timeoutMs: 1_000,
      transport: endpoint,
    });
    await Promise.all(Array.from({ length: 100 }, (_, index) =>
      client.spaces.createSpace({
        name: `decoy-space-${index}`,
        slug: `decoy-space-${index}`,
      })
    ));
    const plan = buildHistoricalIndexPlan(
      finalMeeting(1, "Tuesday"),
      new HmacHistoricalOpaqueIds(new Uint8Array(32).fill(0x71)),
      blockPolicy,
    );
    const adapter = new InfinityContextHistoricalMemoryAdapter({
      baseUrl: "http://disposable.infinity.invalid", embeddingTokenProfile: () => historicalEmbeddingTokenProfile(exactTokenizer),
      requestTimeoutMs: 1_000,
      schemaVersion: 1,
      transport: endpoint,
    });

    await expect(adapter.indexFinalMeeting(plan)).resolves.toEqual({
      code: "memory.invalid_sdk_response",
      retryable: false,
      status: "outcome_unknown",
    });
    expect(endpoint.requests.filter(({ method, path }) =>
      method === "POST" && path === "/v1/spaces"
    )).toHaveLength(100);
  });

  it("fails closed when the unpageable official memory-scope listing is full", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    const client = new InfinityContextClient({
      baseUrl: "http://disposable.infinity.invalid",
      retryPolicy: { maxAttempts: 1 },
      timeoutMs: 1_000,
      transport: endpoint,
    });
    const plan = buildHistoricalIndexPlan(
      finalMeeting(1, "Tuesday"),
      new HmacHistoricalOpaqueIds(new Uint8Array(32).fill(0x72)),
      blockPolicy,
    );
    const space = (await client.spaces.createSpace({
      name: plan.topology.spaceSlug,
      slug: plan.topology.spaceSlug,
    })).data;
    await Promise.all(Array.from({ length: 100 }, (_, index) =>
      client.spaces.createMemoryScope({
        externalRef: `decoy-scope-${index}`,
        name: `decoy-scope-${index}`,
        spaceId: space.id,
      })
    ));
    const adapter = new InfinityContextHistoricalMemoryAdapter({
      baseUrl: "http://disposable.infinity.invalid", embeddingTokenProfile: () => historicalEmbeddingTokenProfile(exactTokenizer),
      requestTimeoutMs: 1_000,
      schemaVersion: 1,
      transport: endpoint,
    });

    await expect(adapter.indexFinalMeeting(plan)).resolves.toEqual({
      code: "memory.invalid_sdk_response",
      retryable: false,
      status: "outcome_unknown",
    });
    expect(endpoint.requests.filter(({ method, path }) =>
      method === "POST" && path === "/v1/memory-scopes"
    )).toHaveLength(100);
  });

  it("does not claim release absence from a full unpageable SDK listing", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    const ids = new HmacHistoricalOpaqueIds(new Uint8Array(32).fill(0x4d));
    const plan = buildHistoricalIndexPlan(finalMeeting(1, "Tuesday"), ids, blockPolicy);
    const client = new InfinityContextClient({
      baseUrl: "http://disposable.infinity.invalid",
      retryPolicy: { maxAttempts: 1 },
      timeoutMs: 1_000,
      transport: endpoint,
    });
    await Promise.all(Array.from({ length: 500 }, (_, index) =>
      client.documents.ingestDocument({
        idempotencyKey: `decoy-${index}`,
        memoryScopeExternalRef: plan.topology.roomScopeExternalRef,
        sourceExternalId: `decoy-document-${index}`,
        spaceSlug: plan.topology.spaceSlug,
        text: `synthetic decoy ${index}`,
        threadExternalRef: plan.topology.threadExternalRef,
        title: `decoy-${index}`,
      })
    ));
    const target = plan.documents[0];
    if (target === undefined) {
      throw new Error("historical plan fixture produced no target document");
    }
    const adapter = new InfinityContextHistoricalMemoryAdapter({
      baseUrl: "http://disposable.infinity.invalid", embeddingTokenProfile: () => historicalEmbeddingTokenProfile(exactTokenizer),
      requestTimeoutMs: 1_000,
      schemaVersion: 1,
      transport: endpoint,
    });

    await expect(adapter.deleteMeeting({
      deleteMutationId: plan.deleteMutationId,
      documentExternalIds: [target.manifest.documentExternalId],
      mode: "release",
      remoteDocumentIds: {},
      schemaVersion: 1,
      topology: plan.topology,
    })).resolves.toEqual({
      code: "memory.scope_document_listing_incomplete",
      retryable: true,
      status: "absence_unverified",
    });
  });

  it("does not delete a document through a corrupt local remote-id binding", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    const ids = new HmacHistoricalOpaqueIds(new Uint8Array(32).fill(0x2f));
    const plan = buildHistoricalIndexPlan(finalMeeting(1, "Tuesday"), ids, blockPolicy);
    const target = plan.documents[0];
    if (target === undefined) {
      throw new Error("historical plan fixture produced no target document");
    }
    const client = new InfinityContextClient({
      baseUrl: "http://disposable.infinity.invalid",
      retryPolicy: { maxAttempts: 1 },
      timeoutMs: 1_000,
      transport: endpoint,
    });
    const unrelated = (await client.documents.ingestDocument({
      idempotencyKey: "unrelated-ingest",
      memoryScopeExternalRef: plan.topology.roomScopeExternalRef,
      sourceExternalId: "unrelated-document",
      spaceSlug: plan.topology.spaceSlug,
      text: "synthetic unrelated evidence",
      threadExternalRef: plan.topology.threadExternalRef,
      title: "unrelated",
    })).data;
    const adapter = new InfinityContextHistoricalMemoryAdapter({
      baseUrl: "http://disposable.infinity.invalid", embeddingTokenProfile: () => historicalEmbeddingTokenProfile(exactTokenizer),
      requestTimeoutMs: 1_000,
      schemaVersion: 1,
      transport: endpoint,
    });

    await expect(adapter.deleteMeeting({
      deleteMutationId: plan.deleteMutationId,
      documentExternalIds: [target.manifest.documentExternalId],
      mode: "release",
      remoteDocumentIds: { [target.manifest.documentExternalId]: unrelated.id },
      schemaVersion: 1,
      topology: plan.topology,
    })).resolves.toEqual({
      code: "memory.invalid_sdk_response",
      retryable: false,
      status: "absence_unverified",
    });
    expect(endpoint.documentCount()).toBe(1);
  });

  it("never treats zero thread counters as verified absence while a known document remains", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    const ids = new HmacHistoricalOpaqueIds(new Uint8Array(32).fill(0x31));
    const plan = buildHistoricalIndexPlan(finalMeeting(1, "Tuesday"), ids, blockPolicy);
    const adapter = new InfinityContextHistoricalMemoryAdapter({
      baseUrl: "http://disposable.infinity.invalid", embeddingTokenProfile: () => historicalEmbeddingTokenProfile(exactTokenizer),
      requestTimeoutMs: 1_000,
      schemaVersion: 1,
      transport: endpoint,
    });
    const indexed = await adapter.indexFinalMeeting(plan);
    expect(indexed.status).toBe("applied");
    if (indexed.status !== "applied") {
      throw new Error("document absence fixture failed to index");
    }
    endpoint.preserveNextThreadDocumentAndHideItFromStatus();
    endpoint.failNextDocumentDelete();

    await expect(adapter.deleteMeeting({
      deleteMutationId: plan.deleteMutationId,
      documentExternalIds: plan.documents.map(({ manifest }) =>
        manifest.documentExternalId
      ),
      mode: "meeting",
      remoteDocumentIds: indexed.remoteDocumentIds,
      schemaVersion: 1,
      topology: plan.topology,
    })).resolves.toMatchObject({ status: "absence_unverified" });
    expect(endpoint.documentCount()).toBe(1);

    await expect(adapter.deleteMeeting({
      deleteMutationId: plan.deleteMutationId,
      documentExternalIds: plan.documents.map(({ manifest }) =>
        manifest.documentExternalId
      ),
      mode: "meeting",
      remoteDocumentIds: indexed.remoteDocumentIds,
      schemaVersion: 1,
      topology: plan.topology,
    })).resolves.toEqual({ status: "verified_absent" });
    expect(endpoint.documentCount()).toBe(0);
  });

  it("reconciles official soft-deleted documents as verified absence", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    const ids = new HmacHistoricalOpaqueIds(new Uint8Array(32).fill(0x38));
    const plan = buildHistoricalIndexPlan(finalMeeting(1, "Tuesday"), ids, blockPolicy);
    const adapter = new InfinityContextHistoricalMemoryAdapter({
      baseUrl: "http://disposable.infinity.invalid", embeddingTokenProfile: () => historicalEmbeddingTokenProfile(exactTokenizer),
      requestTimeoutMs: 1_000,
      schemaVersion: 1,
      transport: endpoint,
    });
    const indexed = await adapter.indexFinalMeeting(plan);
    expect(indexed.status).toBe("applied");
    if (indexed.status !== "applied") {
      throw new Error("soft-delete reconciliation fixture failed to index");
    }

    const request = {
      deleteMutationId: plan.deleteMutationId,
      documentExternalIds: plan.documents.map(({ manifest }) =>
        manifest.documentExternalId
      ),
      mode: "release" as const,
      remoteDocumentIds: indexed.remoteDocumentIds,
      schemaVersion: 1 as const,
      topology: plan.topology,
    };
    endpoint.loseNextDocumentDeleteResponse();
    await expect(adapter.deleteMeeting(request)).resolves.toEqual({
      status: "verified_absent",
    });
    expect(endpoint.documentCount()).toBe(0);
    expect(endpoint.storedDocumentCount()).toBe(plan.documents.length);

    // A replay sees the SDK record with status=deleted and remains idempotent.
    await expect(adapter.deleteMeeting(request)).resolves.toEqual({
      status: "verified_absent",
    });
    expect(endpoint.storedDocumentCount()).toBe(plan.documents.length);
  });

});

describe("Infinity Context production provenance deletion", () => {
  it("keeps verified deletion available with serving and indexing disabled", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    const activation = decodeInfinityContextRuntimeActivation({
      apiVersion: "v1",
      archiveSha256: INFINITY_CONTEXT_SDK_PROVENANCE.archiveSha256,
      environment: "production",
      immutablePackageIntegrity: INFINITY_CONTEXT_SDK_PROVENANCE.immutablePackageIntegrity,
      indexingEnabled: false,
      packageSource: "immutable_package",
      qualificationManifestSha256:
        INFINITY_CONTEXT_SDK_PROVENANCE.retainedB77SemanticTransportManifestSha256,
      schemaVersion: 1,
      sdkCommit: INFINITY_CONTEXT_SDK_PROVENANCE.commit,
      sdkTree: INFINITY_CONTEXT_SDK_PROVENANCE.tree,
      searchEnabled: false,
      serviceName: "disposable-infinity-context",
      servingProfile: "shadow_sync",
    });
    const adapter = new InfinityContextHistoricalMemoryAdapter({
      baseUrl: "http://disposable.infinity.invalid", embeddingTokenProfile: () => historicalEmbeddingTokenProfile(exactTokenizer),
      requestTimeoutMs: 1_000,
      schemaVersion: 1,
      transport: endpoint,
    });
    const capabilities = await adapter.qualifyCapabilities();
    expect(() => {
      assertInfinityContextActivation(activation, capabilities);
    }).not.toThrow();

    const plan = buildHistoricalIndexPlan(
      finalMeeting(1, "Tuesday"),
      new HmacHistoricalOpaqueIds(new Uint8Array(32).fill(0x39)),
      blockPolicy,
    );
    const indexed = await adapter.indexFinalMeeting(plan);
    if (indexed.status !== "applied") {
      throw new Error("production provenance deletion fixture failed to index");
    }
    endpoint.loseNextDocumentDeleteResponse();
    await expect(adapter.deleteMeeting({
      deleteMutationId: plan.deleteMutationId,
      documentExternalIds: plan.documents.map(({ manifest }) =>
        manifest.documentExternalId
      ),
      mode: "release",
      remoteDocumentIds: indexed.remoteDocumentIds,
      schemaVersion: 1,
      topology: plan.topology,
    })).resolves.toEqual({ status: "verified_absent" });
    expect(endpoint.documentCount()).toBe(0);
  });
});

describe("Infinity Context historical memory end-to-end lifecycle", () => {
  it("indexes, replays, grounds, exhausts, supersedes, and drains verified deletion", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    const ids = new HmacHistoricalOpaqueIds(new Uint8Array(32).fill(0x5a));
    const authority = new MemoryHistoricalAuthority();
    const store = new MemoryHistoricalStore();
    const firstMeeting = finalMeeting(1, "Tuesday");
    authority.put(firstMeeting);
    await expect(store.acceptRelease(firstMeeting.binding)).resolves.toBe("accepted");

    const firstAdapter = new InfinityContextHistoricalMemoryAdapter({
      baseUrl: "http://disposable.infinity.invalid", embeddingTokenProfile: () => historicalEmbeddingTokenProfile(exactTokenizer),
      requestTimeoutMs: 1_000,
      schemaVersion: 1,
      transport: endpoint,
    });
    await expect(firstAdapter.qualifyCapabilities()).resolves.toMatchObject({
      supportsQdrant: true,
    });
    endpoint.loseNextIngestResponse();
    endpoint.loseNextProcessResponse();
    const firstWorker = new HistoricalSyncWorker({ authority, ids, memory: firstAdapter, store,
      tokenizer: () => exactTokenizer }, {
      blockPolicy,
      leaseDurationMs: 30_000,
      maximumIndexAttempts: 3,
      retryBackoffMs: [1],
      version: "meeting-knowledge.historical-sync.v1",
    });
    await expect(firstWorker.executeOnce({ indexingEnabled: true })).resolves.toMatchObject({
      operation: "index",
      status: "applied",
    });
    const processRequests = endpoint.requests.filter(({ path }) => path.endsWith("/process"));
    expect(processRequests.length).toBeGreaterThan(endpoint.documentCount());
    expect(processRequests.some((request, index) =>
      processRequests.some((candidate, candidateIndex) =>
        candidateIndex !== index && candidate.idempotencyKey === request.idempotencyKey
      )
    )).toBe(true);
    expect(store.state(firstMeeting.binding.releaseId)).toBe("applied");
    expect(endpoint.documentCount()).toBeGreaterThan(1);
    expect(endpoint.indexedTexts().join("\n")).not.toContain("BOTIK GENERATED SUMMARY");

    // Process restart: only local projection and provider endpoint state survive.
    await expect(store.acceptRelease(firstMeeting.binding)).resolves.toBe("replayed");
    const restartedAdapter = new InfinityContextHistoricalMemoryAdapter({
      baseUrl: "http://disposable.infinity.invalid", embeddingTokenProfile: () => historicalEmbeddingTokenProfile(exactTokenizer),
      requestTimeoutMs: 1_000,
      schemaVersion: 1,
      transport: endpoint,
    });
    await restartedAdapter.qualifyCapabilities();
    const restartedWorker = new HistoricalSyncWorker({ authority, ids, memory: restartedAdapter,
      store, tokenizer: () => exactTokenizer }, {
      blockPolicy,
      leaseDurationMs: 30_000,
      maximumIndexAttempts: 3,
      retryBackoffMs: [1],
      version: "meeting-knowledge.historical-sync.v1",
    });
    await expect(restartedWorker.executeOnce({ indexingEnabled: true })).resolves.toEqual({ status: "idle" });

    const authorization = {
      authorize: async (request: { readonly authorizationPrincipalRef: string; readonly roomId: string; readonly scopeId: string }) => ({
        authorizationDigest: `${request.scopeId}:${request.roomId}:policy-v1`,
        authorizationEpoch: "1",
        authorized: request.authorizationPrincipalRef === "principal" &&
          request.scopeId === "fixture-scope" && request.roomId === "fixture-room",
        policyVersion: "room-authorization.v1",
      }),
    };
    const focused = new HistoricalFocusedRetrieval({
      authority,
      authorization,
      ids,
      memory: restartedAdapter,
      store,
      tokenizer: () => exactTokenizer,
    }, {
      blockPolicy,
      candidateLimitPerQuery: 8,
      maximumDecomposedQueries: 4,
      maximumEvidenceBytes: 16_000,
      maximumLocalScanBlocks: 100,
      minimumProviderScore: 0.01,
      neighborRadius: 1,
      rerankLimit: 5,
      searchTimeoutMs: 500,
      version: "meeting-knowledge.focused-retrieval.v1",
    });
    const focusedResult = await focused.buildPlan({
      authorizationPrincipalRef: "principal",
      currentMeetingId: firstMeeting.binding.meetingId,
      question: "What is the Project Cedar launch day?",
      roomId: "fixture-room",
      scopeId: "fixture-scope",
      searchEnabled: true,
      servingAuthorized: true,
      sourceSet: "current",
    });
    expect(focusedResult.status).toBe("ready");
    if (focusedResult.status !== "ready") {
      throw new Error("focused grounding failed");
    }
    expect(focusedResult.plan.retrievalSource).toBe("qualified_hybrid");
    expect(focusedResult.plan.blocks.some(({ turns }) =>
      turns.some(({ text }) => text.includes("Tuesday"))
    )).toBe(true);
    expect(JSON.stringify(focusedResult.plan.blocks)).not.toContain("UNTRUSTED SDK CHUNK TEXT");
    expect(focusedResult.plan.selection).toBe("locally_rehydrated_focused_blocks_only");
    const retainedProviderSource = focusedResult.plan.sources.find(({ kind }) =>
      kind === "current"
    );
    expect(typeof retainedProviderSource?.providerRank).toBe("number");
    expect(typeof retainedProviderSource?.providerScore).toBe("number");
    expect(focusedResult.plan).not.toHaveProperty("currentTranscriptRequirement");

    const sameRoomFocused = await buildSameRoomFocusedPlan({
      historical: focused,
      historicalMeeting: firstMeeting,
      turnHash: historicalTurnHash,
    });
    expect(sameRoomFocused.historicalMeetingIncluded).toBe(true);
    expect(sameRoomFocused.plan.mode).toBe("focused_retrieval");
    expect(sameRoomFocused.plan.evidence.map(({ turnId }) => turnId))
      .toEqual(expect.arrayContaining([...sameRoomFocused.currentTurnIds]));
    expect(sameRoomFocused.plan.evidence.some(({ source }) =>
      source?.meetingId === firstMeeting.binding.meetingId
    )).toBe(true);
    expect(sameRoomFocused.plan.evidence.filter(({ source }) =>
      source?.meetingId === firstMeeting.binding.meetingId
    ).length).toBeLessThan(firstMeeting.humanTurns.length);
    expect(JSON.stringify(sameRoomFocused.plan.evidence))
      .not.toContain("UNTRUSTED SDK CHUNK TEXT");

    const searchCount = endpoint.requests.filter(({ path }) => path === "/v1/search").length;
    await expect(focused.buildPlan({
      authorizationPrincipalRef: "principal",
      question: "What is the Project Cedar launch day?",
      roomId: "another-room",
      scopeId: "fixture-scope",
      searchEnabled: true,
      servingAuthorized: true,
      sourceSet: "room",
    })).resolves.toMatchObject({ status: "unauthorized" });
    expect(endpoint.requests.filter(({ path }) => path === "/v1/search")).toHaveLength(searchCount);

    const checkpoints = new MemoryCoverageCheckpoints();
    const extracted = new Set<string>();
    const exhaustive = new ExhaustiveCoverage({
      authority,
      authorization,
      checkpoints,
      extractor: {
        profile: "meeting-knowledge.fixture-cedar-extractor.v1",
        extract: async ({ block }): Promise<CoverageExtractV1> => {
          extracted.add(block.candidateLocator);
          return cedarExtract(block);
        },
      },
      ids,
      reducer: {
        profile: "meeting-knowledge.fixture-cedar-reducer.v1",
        reduce: async ({ values }) => reduceCedar(values),
      },
      sync: store,
      tokenizer: () => exactTokenizer,
    }, {
      blockPolicy,
      checkpointRetentionSeconds: 86_400,
      maximumBlocks: 100,
      maximumCheckpointAttempts: 8,
      maximumCumulativeEvidenceUtf8Bytes: 8_388_608,
      maximumExtractPayloadUtf8Bytes: 4_096,
      maximumReduceCalls: 100,
      maximumReductionPayloadUtf8Bytes: 8_192,
      maximumSelectedTurns: 256,
      maximumSynthesisBlocks: 64,
      processingRelease: "meeting-knowledge.fixture-coverage.r2",
      reduceFanIn: 2,
      version: "meeting-knowledge.exhaustive-coverage.v1",
    });
    const exhaustiveResult = await exhaustive.buildPlan({
      authorizationPrincipalRef: "principal",
      question: "Count every Project Cedar mention across all meetings",
      requestId: "coverage-request-1",
      roomId: "fixture-room",
      scopeId: "fixture-scope",
    });
    expect(exhaustiveResult.status).toBe("ready");
    if (exhaustiveResult.status !== "ready") {
      throw new Error("exhaustive grounding failed");
    }
    const firstPlan = buildHistoricalIndexPlan(firstMeeting, ids, blockPolicy);
    expect(exhaustiveResult.plan.coverageBitmap).toHaveLength(firstPlan.documents.length);
    expect(exhaustiveResult.plan.coverageBitmap.every(Boolean)).toBe(true);
    expect(extracted.size).toBe(firstPlan.documents.length);
    expect(checkpoints.completed).toBe(true);

    const replacement = finalMeeting(2, "Thursday");
    authority.put(replacement);
    await expect(store.acceptRelease(replacement.binding)).resolves.toBe("accepted");
    store.forgetRemoteDocumentIds(firstMeeting.binding.releaseId);
    endpoint.loseNextDocumentDeleteResponse();
    await expect(restartedWorker.executeOnce({ indexingEnabled: false })).resolves.toMatchObject({
      operation: "delete_release",
      status: "deleted",
    });
    expect(endpoint.documentCount()).toBe(0);
    await expect(restartedWorker.executeOnce({ indexingEnabled: true })).resolves.toMatchObject({
      operation: "index",
      status: "applied",
    });
    expect(endpoint.indexedTexts().join("\n")).toContain("Thursday");
    expect(endpoint.indexedTexts().join("\n")).not.toContain("Tuesday");

    await store.requestMeetingDeletion(replacement.binding.meetingId);
    endpoint.loseNextThreadDeleteResponse();
    await expect(restartedWorker.executeOnce({ indexingEnabled: false })).resolves.toMatchObject({
      operation: "delete_meeting",
      status: "deleted",
    });
    expect(endpoint.documentCount()).toBe(0);
    expect(store.state(replacement.binding.releaseId)).toBe("deleted");

    const paths = endpoint.requests.map(({ method, path }) => `${method} ${path}`);
    expect(paths).toEqual(expect.arrayContaining([
      "POST /v1/documents",
      "POST /v1/search",
      "DELETE /v1/thread-memory",
      "POST /v1/thread-memory/status",
    ]));
    const providerRequests = JSON.stringify(endpoint.requests);
    expect(providerRequests).not.toContain("fixture-scope");
    expect(providerRequests).not.toContain("fixture-room");
    expect(providerRequests).not.toContain("fixture-meeting");
  }, 30_000);
});

describe("Infinity Context out-of-order generation reconciliation", () => {
  it("fences an in-flight generation until its late provider outcome can be deleted", async () => {
    const endpoint = new DisposableInfinityEndpoint();
    const ids = new HmacHistoricalOpaqueIds(new Uint8Array(32).fill(0x6b));
    const authority = new MemoryHistoricalAuthority();
    const store = new MemoryHistoricalStore();
    const first = finalMeeting(1, "Tuesday");
    authority.put(first);
    await store.acceptRelease(first.binding);
    const adapter = new InfinityContextHistoricalMemoryAdapter({
      baseUrl: "http://disposable.infinity.invalid", embeddingTokenProfile: () => historicalEmbeddingTokenProfile(exactTokenizer),
      requestTimeoutMs: 1_000,
      schemaVersion: 1,
      transport: endpoint,
    });
    const worker = new HistoricalSyncWorker({ authority, ids, memory: adapter, store,
      tokenizer: () => exactTokenizer }, {
      blockPolicy,
      leaseDurationMs: 30_000,
      maximumIndexAttempts: 3,
      retryBackoffMs: [1],
      version: "meeting-knowledge.historical-sync.v1",
    });
    const ingest = endpoint.pauseNextIngest();
    const staleIndex = worker.executeOnce({ indexingEnabled: true });
    const staleIndexAssertion = expect(staleIndex).rejects.toThrow(
      "historical test index lease was superseded",
    );
    await ingest.started;

    const replacement = finalMeeting(2, "Thursday");
    authority.put(replacement);
    await store.acceptRelease(replacement.binding);
    await expect(worker.executeOnce({ indexingEnabled: false })).resolves.toEqual({
      status: "idle",
    });

    ingest.resume();
    await staleIndexAssertion;
    expect(endpoint.documentCount()).toBeGreaterThan(0);
    expect(endpoint.indexedTexts().join("\n")).toContain("Tuesday");

    store.expireSupersededLease(first.binding.releaseId);
    await expect(worker.executeOnce({ indexingEnabled: false })).resolves.toMatchObject({
      operation: "delete_release",
      status: "deleted",
    });
    expect(endpoint.documentCount()).toBe(0);

    await expect(worker.executeOnce({ indexingEnabled: true })).resolves.toMatchObject({
      operation: "index",
      status: "applied",
    });
    expect(endpoint.indexedTexts().join("\n")).toContain("Thursday");
    expect(endpoint.indexedTexts().join("\n")).not.toContain("Tuesday");
  });
});


function historicalTurnHash(turn: AcceptedFinalMeetingV1["humanTurns"][number]): string {
  const value = [turn.turnId, turn.speakerId, turn.startMs, turn.endMs, turn.text]
    .join("\u0000");
  return createHash("sha256")
    .update(value, "utf8")
    .digest("hex");
}
