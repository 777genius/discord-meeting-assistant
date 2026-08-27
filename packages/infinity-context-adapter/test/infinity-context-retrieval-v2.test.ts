import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
  JsonValue,
} from "@infinity-context/sdk";
import { describe, expect, it } from "vitest";

import {
  InfinityContextRetrievalV2Adapter,
  retrievalV2CapabilityFingerprint,
  type InfinityContextRetrievalV2Request,
} from "../src/infinity-context-retrieval-v2.js";

const require = createRequire(import.meta.url);
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(
  require.resolve(`@infinity-context/sdk/fixtures/context_retrieval_v2/${name}.json`),
  "utf8",
)) as Record<string, unknown>;
const capability = fixture("capability");
const successFixture = fixture("success");

it("recomputes the exact producer-emitted capability fingerprint", () => {
  expect(retrievalV2CapabilityFingerprint(capability)).toBe(
    capability.capability_fingerprint,
  );
  expect(successFixture.capability_fingerprint).toBe(capability.capability_fingerprint);
});

function json(status: number, value: JsonValue): HttpResponse {
  return {
    body: JSON.stringify(value),
    headers: new Headers({ "content-type": "application/json" }),
    status,
  };
}

class RetrievalV2Endpoint implements HttpTransport {
  public readonly requests: HttpRequest[] = [];
  public capabilities: Record<string, unknown> = {
    context: { retrieval: capability },
  };
  public response: Record<string, unknown> = response();
  public hang = false;

  public async send(httpRequest: HttpRequest): Promise<HttpResponse> {
    this.requests.push(httpRequest);
    if (this.hang) {
      await new Promise<never>((_resolve, reject) => {
        httpRequest.signal?.addEventListener("abort", () => {
          reject(httpRequest.signal?.reason);
        },
          { once: true });
      });
    }
    if (httpRequest.url.pathname === "/v1/capabilities") {
      return json(200, this.capabilities as JsonValue);
    }
    if (httpRequest.url.pathname === "/v1/context/retrieve") {
      return json(200, this.response as JsonValue);
    }
    return json(404, {});
  }
}

function response(): Record<string, unknown> {
  const candidate = (successFixture.candidates as Array<Record<string, unknown>>)[0];
  const direct: Record<string, unknown> = structuredClone({
    ...candidate,
    neighbors: [],
  });
  direct.matched_query_ids = ["original-question"];
  direct.source_requested_weight_micros = 0;
  direct.source_matched_weight_micros = 0;
  direct.actor_requested_weight_micros = 0;
  direct.actor_matched_weight_micros = 0;
  direct.time_requested_weight_micros = 0;
  direct.time_matched_weight_micros = 0;
  direct.preference_score_micros = 0;
  direct.preference_boost_micros = 0;
  direct.rerank_score_picos = direct.base_score_picos;
  direct.contributions = (direct.contributions as Array<Record<string, unknown>>)
    .map((contribution) => ({
      ...contribution,
      query_id: "original-question",
    }));
  return structuredClone({
    ...successFixture,
    applied_bounds: {
      candidate_limit: 100,
      deadline_ms: 100,
      neighbor_radius: 0,
      response_byte_limit: 16_384,
      result_limit: 10,
      returned_neighbors: 0,
      returned_seeds: 1,
    },
    candidates: [direct],
  });
}

function request(overrides: Partial<InfinityContextRetrievalV2Request> = {}):
InfinityContextRetrievalV2Request {
  return {
    binding: {
      capabilityFingerprint: capability.capability_fingerprint as string,
      contractVersion: "context-retrieval.v2",
      indexProfileDigest: capability.index_profile_digest as string,
      profileId: capability.profile_id as string,
      rankingPolicy: "weighted_rrf_canonical_preferences.v1",
      requiredProviderLanes: capability.required_provider_lanes as string[],
      serviceRevision: capability.service_revision as string,
    },
    budgets: {
      candidateLimit: 100,
      deadlineMs: 100,
      evidenceByteLimit: 24_000,
      neighborRadius: 0,
      responseByteLimit: 16_384,
      resultLimit: 10,
    },
    filters: {
      actorKeys: ["actor-a"],
      category: "decision",
      documentKeys: [],
      excludedSourceKeys: [],
      kinds: ["record_block"],
      relativeTimeInterval: { endMs: 480_000, startMs: 420_000 },
      sourceGenerations: [{
        projectionGeneration: "generation-a-42",
        sourceKey: "source-family-a",
      }],
      tagsAll: [],
      tagsAny: ["approved"],
      tagsNone: ["draft"],
      timeInterval: null,
    },
    queries: [{ query: "approved launch decision", queryId: "original-question" }],
    schemaVersion: 2,
    scope: { memoryScopeId: "scope-a", spaceId: "space-a", threadId: null },
    softPreferences: {
      actorPreferences: [],
      relativeTimeInterval: null,
      sourcePreferences: [],
      timeInterval: null,
      timeWeightMicros: null,
    },
    ...overrides,
  };
}

function adapter(endpoint: RetrievalV2Endpoint, timeoutMs = 100) {
  return new InfinityContextRetrievalV2Adapter({
    baseUrl: "https://infinity.invalid",
    operationTimeoutMs: Math.max(timeoutMs, 200),
    requestTimeoutMs: timeoutMs,
    transport: endpoint,
  });
}

describe("Infinity Context locator-only Retrieval V2 adapter", () => {
  it("passes one original question and hard filters unchanged without ranking", async () => {
    const endpoint = new RetrievalV2Endpoint();
    const result = await adapter(endpoint).retrieve(request());

    expect(result).toEqual({
      candidates: [{ locator: "candidate-007" }],
      status: "available",
    });
    const wire = endpoint.requests[1]?.body;
    expect(wire?.kind).toBe("json");
    if (wire?.kind !== "json") {
      throw new Error("missing Retrieval V2 wire request");
    }
    expect(wire.value).toEqual({
      bounds: {
        candidate_limit: 100,
        deadline_ms: 100,
        neighbor_radius: 0,
        response_byte_limit: 16_384,
        result_limit: 10,
      },
      capability_fingerprint: capability.capability_fingerprint,
      contract_version: "context-retrieval.v2",
      filters: {
        actor_keys: ["actor-a"], category: "decision", document_keys: [],
        excluded_source_keys: [], kinds: ["record_block"],
        relative_time_interval: { end_ms: 480_000, start_ms: 420_000 },
        source_generations: [{ projection_generation: "generation-a-42",
          source_key: "source-family-a" }], tags_all: [], tags_any: ["approved"],
        tags_none: ["draft"], time_interval: null,
      },
      profile_id: capability.profile_id,
      queries: [{ query: "approved launch decision", query_id: "original-question",
        weight_micros: 1_000_000 }],
      scope: { memory_scope_id: "scope-a", space_id: "space-a", thread_id: null },
      soft_preferences: {
        actor_preferences: [], relative_time_interval: null,
        source_preferences: [], time_interval: null, time_weight_micros: null,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/text|snippet|content/u);
  });

  it("preserves a valid provider unavailable reason as retryable", async () => {
    const endpoint = new RetrievalV2Endpoint();
    endpoint.response.status = "unavailable";
    endpoint.response.candidates = [];
    endpoint.response.provider_outcomes = ["postgres_keyword", "qdrant_dense"]
      .map((provider_id) => ({
        provider_id,
        reason_code: "provider_unavailable",
        status: "unavailable",
      }));
    Object.assign(endpoint.response.applied_bounds as Record<string, unknown>, {
      returned_neighbors: 0,
      returned_seeds: 0,
    });

    await expect(adapter(endpoint).retrieve(request())).resolves.toEqual({
      code: "provider_unavailable",
      retryable: true,
      status: "unavailable",
    });
  });

  it("preserves a valid provider unqualified reason as nonretryable", async () => {
    const endpoint = new RetrievalV2Endpoint();
    const changedCapability = structuredClone(capability);
    changedCapability.required_provider_lanes = ["postgres_keyword"];
    const dense = (changedCapability.provider_lanes as Array<Record<string, unknown>>)[1];
    if (dense === undefined) {
      throw new Error("missing optional provider lane");
    }
    dense.required = false;
    changedCapability.capability_fingerprint = retrievalV2CapabilityFingerprint(
      changedCapability,
    );
    endpoint.capabilities = { context: { retrieval: changedCapability } };
    endpoint.response.status = "unqualified";
    endpoint.response.capability_fingerprint = changedCapability.capability_fingerprint;
    endpoint.response.candidates = [];
    endpoint.response.provider_outcomes = [{
      provider_id: "postgres_keyword", reason_code: null, status: "available",
    }, {
      provider_id: "qdrant_dense", reason_code: "provider_unqualified",
      status: "unqualified",
    }];
    endpoint.response.degradation_reason_codes = ["optional_provider_unqualified"];
    Object.assign(endpoint.response.applied_bounds as Record<string, unknown>, {
      returned_neighbors: 0,
      returned_seeds: 0,
    });
    const changedRequest = request({ binding: {
      ...request().binding,
      capabilityFingerprint: changedCapability.capability_fingerprint as string,
      requiredProviderLanes: ["postgres_keyword"],
    } });

    await expect(adapter(endpoint).retrieve(changedRequest)).resolves.toEqual({
      code: "provider_unqualified",
      retryable: false,
      status: "unqualified",
    });
  });

  it.each([
    ["text", "remote transcript text"],
    ["content", "remote transcript text"],
    ["snippet", "remote transcript text"],
  ])("rejects forbidden hostile-wire candidate field %s", async (field, value) => {
    const endpoint = new RetrievalV2Endpoint();
    const candidate = (endpoint.response.candidates as Array<Record<string, unknown>>)[0];
    if (candidate === undefined) {
      throw new Error("missing fixture candidate");
    }
    Object.assign(candidate, { [field]: value });
    const result = await adapter(endpoint).retrieve(request());
    expect(result).toEqual({
      code: "memory.context_retrieval_response_invalid",
      retryable: false,
      status: "unavailable",
    });
  });

  it("fails closed on unsafe numbers and response bounds drift", async () => {
    const endpoint = new RetrievalV2Endpoint();
    const candidate = (endpoint.response.candidates as Array<Record<string, unknown>>)[0];
    if (candidate === undefined) {
      throw new Error("missing fixture candidate");
    }
    candidate.canonical_version = Number.MAX_SAFE_INTEGER + 1;
    expect(await adapter(endpoint).retrieve(request())).toMatchObject({
      code: "memory.context_retrieval_response_invalid", status: "unavailable",
    });

    endpoint.response = response();
    (endpoint.response.applied_bounds as Record<string, unknown>).result_limit = 9;
    expect(await adapter(endpoint).retrieve(request())).toMatchObject({
      code: "memory.context_retrieval_response_invalid", status: "unavailable",
    });
  });

  it("fails closed on fingerprint, profile, revision, digest, and lane mismatches", async () => {
    const mismatches: InfinityContextRetrievalV2Request[] = [
      request({ binding: { ...request().binding, capabilityFingerprint: "0".repeat(64) } }),
      request({ binding: { ...request().binding, profileId: "other-profile" } }),
      request({ binding: { ...request().binding, serviceRevision: "b".repeat(40) } }),
      request({ binding: { ...request().binding, indexProfileDigest: "c".repeat(64) } }),
      request({ binding: { ...request().binding, requiredProviderLanes: ["qdrant_dense"] } }),
    ];
    for (const mismatch of mismatches) {
      const result = await adapter(new RetrievalV2Endpoint()).retrieve(mismatch);
      expect(result).toMatchObject({ retryable: false, status: "unqualified" });
    }
  });

  it("rejects an unhealthy or profile-unqualified required capability lane", async () => {
    for (const drift of [{ healthy: false }, { profile_qualified: false }]) {
      const endpoint = new RetrievalV2Endpoint();
      const changed = structuredClone(capability);
      const lane = (changed.provider_lanes as Array<Record<string, unknown>>)[0];
      if (lane === undefined) {
        throw new Error("missing fixture provider lane");
      }
      Object.assign(lane, drift);
      endpoint.capabilities = { context: { retrieval: changed } };
      expect(await adapter(endpoint).retrieve(request())).toMatchObject({
        retryable: false,
        status: "unqualified",
      });
      expect(endpoint.requests).toHaveLength(1);
    }
  });

  it("rejects query, result, and neighbor bounds before transport", async () => {
    const endpoint = new RetrievalV2Endpoint();
    const invalid = request({
      budgets: { ...request().budgets, neighborRadius: 1 as 0 },
      queries: [{ query: "x".repeat(513), queryId: "q1" }],
    });
    expect(await adapter(endpoint).retrieve(invalid)).toEqual({
      code: "memory.context_retrieval_contract_invalid",
      retryable: false,
      status: "unqualified",
    });
    expect(endpoint.requests).toHaveLength(0);
  });

  it("rejects policy/version drift and arbitrary persisted request fields", async () => {
    const invalidInputs = [
      { ...request(), schemaVersion: 3 },
      { ...request(), binding: { ...request().binding, contractVersion: "context-retrieval.v3" } },
      { ...request(), binding: { ...request().binding, rankingPolicy: "consumer_rerank.v1" } },
      { ...request(), transcript: "must never enter provider retrieval" },
    ] as unknown as InfinityContextRetrievalV2Request[];
    for (const invalid of invalidInputs) {
      const endpoint = new RetrievalV2Endpoint();
      expect(await adapter(endpoint).retrieve(invalid)).toMatchObject({
        code: "memory.context_retrieval_contract_invalid",
        status: "unqualified",
      });
      expect(endpoint.requests).toHaveLength(0);
    }
  });

  it("maps timeout and caller cancellation without returning partial locators", async () => {
    const timeoutEndpoint = new RetrievalV2Endpoint();
    timeoutEndpoint.hang = true;
    expect(await adapter(timeoutEndpoint, 10).retrieve(request({
      budgets: { ...request().budgets, deadlineMs: 10 },
    }))).toEqual({
      code: "memory.context_retrieval_deadline_exceeded",
      retryable: true,
      status: "unavailable",
    });

    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));
    expect(await adapter(new RetrievalV2Endpoint()).retrieve(
      request(),
      { signal: controller.signal },
    )).toEqual({
      code: "memory.operation_cancelled",
      retryable: true,
      status: "unavailable",
    });
  });
});
