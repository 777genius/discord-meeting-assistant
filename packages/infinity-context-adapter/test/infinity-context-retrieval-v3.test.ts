import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
  JsonValue,
} from "@infinity-context/sdk";

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FOCUSED_LOCATOR_RETRIEVAL_V2_POLICY } from
  "@discord-meeting/meeting-core/meeting-knowledge";

import {
  InfinityContextRetrievalV3Adapter,
  retrievalV3CapabilityFingerprint,
  type InfinityContextRetrievalV3Request,
} from "../src/infinity-context-retrieval-v3.js";


const require = createRequire(import.meta.url);
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(
  require.resolve(`@infinity-context/sdk/fixtures/context_retrieval_v2/${name}.json`),
  "utf8",
)) as Record<string, unknown>;
// Synthetic V3 fixture only: runtime always fetches an untouched bare V3 descriptor.
const capability = fixture("capability");
capability.contract_version = "context-retrieval.v3";
capability.endpoint = "/v1/context/retrieve-v3";
capability.capability_fingerprint = retrievalV3CapabilityFingerprint(capability);
const successFixture = fixture("success");
successFixture.contract_version = "context-retrieval.v3";
successFixture.capability_fingerprint = capability.capability_fingerprint;

it("keeps the synthetic descriptor and response fingerprint bound", () => {
  expect(retrievalV3CapabilityFingerprint(capability)).toBe(
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

class RetrievalV3Endpoint implements HttpTransport {
  public readonly requests: HttpRequest[] = [];
  public capabilities: Record<string, unknown> = capability;
  public response: Record<string, unknown> = response();
  public hang = false;
  public afterCapabilities?: () => void;

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
    if (httpRequest.url.pathname === "/v1/context/retrieve-v3/capability") {
      this.afterCapabilities?.();
      return json(200, this.capabilities as JsonValue);
    }
    if (httpRequest.url.pathname === "/v1/context/retrieve-v3") {
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
      deadline_ms: 1_000,
      neighbor_radius: 0,
      response_byte_limit: 16_384,
      result_limit: 10,
      returned_neighbors: 0,
      returned_seeds: 1,
    },
    candidates: [direct],
  });
}

function request(overrides: Partial<InfinityContextRetrievalV3Request> = {}):
InfinityContextRetrievalV3Request {
  return freeze({
    binding: {
      capabilityFingerprint: capability.capability_fingerprint as string,
      contractVersion: "context-retrieval.v3",
      indexProfileDigest: capability.index_profile_digest as string,
      profileId: capability.profile_id as string,
      rankingPolicy: "weighted_rrf_canonical_preferences.v1",
      requiredProviderLanes: capability.required_provider_lanes as string[],
      serviceRevision: capability.service_revision as string,
    },
    budgets: {
      candidateLimit: 100,
      deadlineMs: 1_000,
      evidenceByteLimit: 16_000,
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
    schemaVersion: 3,
    scope: { memoryScopeId: "scope-a", spaceId: "space-a", thread: { mode: "any" } },
    softPreferences: {
      actorPreferences: [],
      relativeTimeInterval: null,
      sourcePreferences: [],
      timeInterval: null,
      timeWeightMicros: null,
    },
    ...overrides,
  });
}

function adapter(endpoint: RetrievalV3Endpoint, timeoutMs = 1_000) {
  return new InfinityContextRetrievalV3Adapter({
    baseUrl: "https://infinity.invalid",
    operationTimeoutMs: Math.max(timeoutMs, 200),
    requestTimeoutMs: timeoutMs,
    transport: endpoint,
  });
}

describe("Infinity Context locator-only Retrieval V3 adapter", () => {
  it("passes one original question and hard filters unchanged without ranking", async () => {
    const endpoint = new RetrievalV3Endpoint();
    const result = await adapter(endpoint).retrieve(request());

    expect(result.status === "available" ? "available" : result.code)
      .toBe("available");
    if (result.status !== "available") {throw new Error("retrieval unavailable");}
    const candidate = result.candidates[0];
    expect(candidate?.locator).toBe("candidate-007");
    expect(typeof candidate?.retrievalProvenance.fusedScore).toBe("number");
    expect(typeof candidate?.retrievalProvenance.providerRank).toBe("number");
    expect(candidate?.retrievalProvenance.contributions[0]).toMatchObject({
      queryId: "original-question",
    });
    expect(typeof candidate?.retrievalProvenance.contributions[0]?.providerLaneId)
      .toBe("string");
    expect(typeof candidate?.retrievalProvenance.contributions[0]?.providerRank)
      .toBe("number");
    const wire = endpoint.requests[1]?.body;
    expect(wire?.kind).toBe("json");
    if (wire?.kind !== "json") {
      throw new Error("missing Retrieval V3 wire request");
    }
    expect(wire.value).toEqual({
      bounds: {
        candidate_limit: 100,
        deadline_ms: 1_000,
        neighbor_radius: 0,
        response_byte_limit: 16_384,
        result_limit: 10,
      },
      capability_fingerprint: capability.capability_fingerprint,
      contract_version: "context-retrieval.v3",
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
      scope: { memoryScopeId: "scope-a", spaceId: "space-a", thread: { mode: "any" } },
      soft_preferences: {
        actor_preferences: [], relative_time_interval: null,
        source_preferences: [], time_interval: null, time_weight_micros: null,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/text|snippet|content/u);
  });



  it("preserves a valid provider unavailable reason as retryable", async () => {
    const endpoint = new RetrievalV3Endpoint();
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
    const endpoint = new RetrievalV3Endpoint();
    const changedCapability = structuredClone(capability);
    changedCapability.required_provider_lanes = ["postgres_keyword"];
    const dense = (changedCapability.provider_lanes as Array<Record<string, unknown>>)[1];
    if (dense === undefined) {
      throw new Error("missing optional provider lane");
    }
    dense.required = false;
    changedCapability.capability_fingerprint = retrievalV3CapabilityFingerprint(
      changedCapability,
    );
    endpoint.capabilities = changedCapability;
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
    const endpoint = new RetrievalV3Endpoint();
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

  it("retains exact request and response bytes when the official SDK rejects a response",
    async () => {
    const hostile = response();
    Object.assign((hostile.candidates as Record<string, unknown>[])[0]!, {
      text: "provider text must be rejected",
    });
    const exactResponse = JSON.stringify(hostile);
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => new Response(
      String(url).endsWith("/capability") ? JSON.stringify(capability) : exactResponse,
      { status: 200, headers: { "content-type": "application/json" } },
    )));
    try {
      const concrete = new InfinityContextRetrievalV3Adapter({
        baseUrl: "https://infinity.invalid",
        operationTimeoutMs: 1_000,
        requestTimeoutMs: 1_000,
      });
      await expect(concrete.retrieve(request())).resolves.toEqual({
        code: "memory.context_retrieval_response_invalid",
        retryable: false,
        status: "unavailable",
      });
      const exchange = concrete.takeExactExchange();
      expect(exchange.capabilityRequestBytes).toHaveLength(0);
      expect(JSON.parse(new TextDecoder().decode(exchange.capabilityResponseBytes)))
        .toEqual(capability);
      expect(new TextDecoder().decode(exchange.responseBytes)).toBe(exactResponse);
      expect(JSON.parse(new TextDecoder().decode(exchange.requestBytes))).toMatchObject({
        bounds: { candidate_limit: 100, neighbor_radius: 0, result_limit: 10 },
        queries: [{ query: "approved launch decision", query_id: "original-question" }],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

});

describe("Infinity Context locator-only Retrieval V3 validation", () => {

  it("fails closed on unsafe numbers and response bounds drift", async () => {
    const endpoint = new RetrievalV3Endpoint();
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

  it.each([
    ["missing", (candidate: Record<string, unknown>) => {
      delete candidate.contributions;
    }],
    ["malformed", (candidate: Record<string, unknown>) => {
      candidate.provider_rank = 0;
    }],
  ] as const)("rejects %s official-SDK ranking provenance", async (_name, mutate) => {
    const endpoint = new RetrievalV3Endpoint();
    const candidate = (endpoint.response.candidates as Array<Record<string, unknown>>)[0];
    if (candidate === undefined) {
      throw new Error("missing fixture candidate");
    }
    mutate(candidate);

    await expect(adapter(endpoint).retrieve(request())).resolves.toEqual({
      code: "memory.context_retrieval_response_invalid",
      retryable: false,
      status: "unavailable",
    });
  });

  it("fails closed on fingerprint, profile, revision, digest, and lane mismatches", async () => {
    const mismatches: InfinityContextRetrievalV3Request[] = [
      request({ binding: { ...request().binding, capabilityFingerprint: "0".repeat(64) } }),
      request({ binding: { ...request().binding, profileId: "other-profile" } }),
      request({ binding: { ...request().binding, serviceRevision: "b".repeat(40) } }),
      request({ binding: { ...request().binding, indexProfileDigest: "c".repeat(64) } }),
      request({ binding: { ...request().binding, requiredProviderLanes: ["qdrant_dense"] } }),
    ];
    for (const mismatch of mismatches) {
      const result = await adapter(new RetrievalV3Endpoint()).retrieve(mismatch);
      expect(result).toMatchObject({ retryable: false, status: "unqualified" });
    }
  });

  it("rejects an unhealthy or profile-unqualified required capability lane", async () => {
    for (const drift of [{ healthy: false }, { profile_qualified: false }]) {
      const endpoint = new RetrievalV3Endpoint();
      const changed = structuredClone(capability);
      const lane = (changed.provider_lanes as Array<Record<string, unknown>>)[0];
      if (lane === undefined) {
        throw new Error("missing fixture provider lane");
      }
      Object.assign(lane, drift);
      changed.capability_fingerprint = retrievalV3CapabilityFingerprint(changed);
      endpoint.capabilities = changed;
      expect(await adapter(endpoint).retrieve(request({ binding: { ...request().binding,
        capabilityFingerprint: changed.capability_fingerprint as string } }))).toMatchObject({
        retryable: false,
        status: "unqualified",
      });
      expect(endpoint.requests).toHaveLength(1);
    }
  });

  it("rejects query, result, and neighbor bounds before transport", async () => {
    const endpoint = new RetrievalV3Endpoint();
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
      { ...request(), schemaVersion: 2 },
      { ...request(), binding: { ...request().binding, contractVersion: "context-retrieval.v2" } },
      { ...request(), binding: { ...request().binding, rankingPolicy: "consumer_rerank.v1" } },
      { ...request(), transcript: "must never enter provider retrieval" },
    ] as unknown as InfinityContextRetrievalV3Request[];
    for (const invalid of invalidInputs) {
      const endpoint = new RetrievalV3Endpoint();
      expect(await adapter(endpoint).retrieve(freeze(invalid))).toMatchObject({
        code: "memory.context_retrieval_contract_invalid",
        status: "unqualified",
      });
      expect(endpoint.requests).toHaveLength(0);
    }
  });

});

describe("Infinity Retrieval V3 deadline ownership", () => {
  it("cancels an in-flight POST under the production 2000 ms budget without replay", async () => {
    const endpoint = new RetrievalV3Endpoint();
    endpoint.afterCapabilities = () => { endpoint.hang = true; };
    const controller = new AbortController();
    const retrieval = new InfinityContextRetrievalV3Adapter({
      baseUrl: "http://infinity.invalid/v1", operationTimeoutMs: 4_000,
      requestTimeoutMs: 2_000, transport: endpoint,
    }).retrieve(request({ budgets: { ...request().budgets,
      deadlineMs: DEFAULT_FOCUSED_LOCATOR_RETRIEVAL_V2_POLICY.deadlineMs },
    }), { signal: controller.signal });
    await vi.waitFor(() => { expect(endpoint.requests).toHaveLength(2); });
    controller.abort(new Error("caller cancelled the pending POST"));
    expect(await retrieval).toEqual({ code: "memory.operation_cancelled",
      retryable: false, status: "unavailable" });
    expect(endpoint.requests.map(({ url }) => url.pathname))
      .toEqual(["/v1/context/retrieve-v3/capability", "/v1/context/retrieve-v3"]);
    expect(endpoint.requests[1]!.signal?.aborted).toBe(true);
  });

  it("maps timeout and caller cancellation without returning partial locators", async () => {
    const timeoutEndpoint = new RetrievalV3Endpoint();
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
    expect(await adapter(new RetrievalV3Endpoint()).retrieve(
      request(),
      { signal: controller.signal },
    )).toEqual({
      code: "memory.operation_cancelled",
      retryable: false,
      status: "unavailable",
    });
  });

  it.each([200, 2_000])("uses one %i ms absolute deadline across both SDK requests", async (deadlineMs) => {
    let now = 1_000;
    const endpoint = new RetrievalV3Endpoint();
    endpoint.afterCapabilities = () => { now += deadlineMs + 1; };

    await expect(adapterWithClock(endpoint, () => now, deadlineMs).retrieve(request({
      budgets: { ...request().budgets, deadlineMs },
    }))).resolves.toEqual({
      code: "memory.context_retrieval_deadline_exceeded",
      retryable: true,
      status: "unavailable",
    });
    expect(endpoint.requests.map(({ url }) => url.pathname))
      .toEqual(["/v1/context/retrieve-v3/capability"]);
  });

  it("gives caller cancellation deterministic precedence at a deadline race", async () => {
    let now = 1_000;
    const controller = new AbortController();
    const endpoint = new RetrievalV3Endpoint();
    endpoint.afterCapabilities = () => {
      now = 1_201;
      controller.abort(new Error("caller won the race"));
    };

    await expect(adapterWithClock(endpoint, () => now).retrieve(request({
      budgets: { ...request().budgets, deadlineMs: 200 },
    }), { signal: controller.signal })).resolves.toEqual({
      code: "memory.operation_cancelled",
      retryable: false,
      status: "unavailable",
    });
  });
});

function adapterWithClock(
  endpoint: RetrievalV3Endpoint,
  monotonicNowMs: () => number,
  operationTimeoutMs = 200,
) {
  return new InfinityContextRetrievalV3Adapter({
    baseUrl: "http://infinity.invalid/v1",
    monotonicNowMs,
    operationTimeoutMs,
    requestTimeoutMs: 100,
    transport: endpoint,
  });
}

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) {freeze(nested);}
    Object.freeze(value);
  }
  return value;
}

it.each([{ mode: "any" }, { mode: "exact", id: "thread-a" }, { mode: "exact", id: null }] as const)(
  "sends the explicit selector %j and complete source-generation vector in one POST", async (thread) => {
    const endpoint = new RetrievalV3Endpoint();
    const pairs = [
      { sourceKey: "source-family-a", projectionGeneration: "generation-a-42" },
      { sourceKey: "source-family-b", projectionGeneration: "generation-b-7" },
      { sourceKey: "source-family-c", projectionGeneration: "generation-c-3" },
    ];
    const snapshot = request({ scope: { ...request().scope, thread },
      filters: { ...request().filters, sourceGenerations: pairs } });
    expect((await adapter(endpoint).retrieve(snapshot)).status).toBe("available");
    expect(endpoint.requests).toHaveLength(2);
    expect(endpoint.requests[1]!.body).toMatchObject({ kind: "json", value: {
      scope: { spaceId: "space-a", memoryScopeId: "scope-a", thread },
      filters: { source_generations: pairs.map((pair) => ({ source_key: pair.sourceKey,
        projection_generation: pair.projectionGeneration })) },
    } });
  });

it("rejects mutable snapshots and invalid pairs before any SDK effect", async () => {
  for (const snapshot of [structuredClone(request()),
    freeze({ ...request(), scope: { ...request().scope, threadId: null } }),
    request({ filters: { ...request().filters, sourceGenerations: [] } }),
    request({ filters: { ...request().filters, sourceGenerations: [
      { sourceKey: "same", projectionGeneration: "a" },
      { sourceKey: "same", projectionGeneration: "b" },
    ] } }),
  ]) {
    const endpoint = new RetrievalV3Endpoint();
    expect(await adapter(endpoint).retrieve(snapshot)).toMatchObject({ status: "unqualified" });
    expect(endpoint.requests).toHaveLength(0);
  }
});

it("rejects unadmitted source keys while leaving locator generation/room reauthorization to core", async () => {
  const endpoint = new RetrievalV3Endpoint();
  (endpoint.response.candidates as Record<string, unknown>[])[0]!.source_key = "foreign-source";
  expect(await adapter(endpoint).retrieve(request())).toMatchObject({
    status: "unavailable", code: "memory.context_retrieval_response_invalid",
  });
});

it.each(["v2-envelope", "v2-descriptor", "wrong-route"])("never falls back for %s", async (kind) => {
  const endpoint = new RetrievalV3Endpoint();
  endpoint.capabilities = kind === "v2-envelope" ? { context: { retrieval: capability } }
    : { ...capability, ...(kind === "v2-descriptor" ? { contract_version: "context-retrieval.v2" }
      : { endpoint: "/v1/context/retrieve" }) };
  expect((await adapter(endpoint).retrieve(request())).status).not.toBe("available");
  expect(endpoint.requests.map(({ url }) => url.pathname)).toEqual(["/v1/context/retrieve-v3/capability"]);
});

it.each(["duplicate", "unsafe-integer", "partial", "invalid-utf8"])(
  "retains hostile raw %s bytes through the genuine SDK and exact transport", async (kind) => {
    const valid = JSON.stringify(response());
    const raw = kind === "duplicate" ? '{"status":"available",' + valid.slice(1)
      : kind === "unsafe-integer" ? valid.replace('"canonical_version":1', '"canonical_version":9007199254740993')
      : kind === "partial" ? valid.replace('"status":"available"', '"status":"unavailable"')
      : new Uint8Array([0xff, 0xfe]);
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => new Response(
      String(url).endsWith("/capability") ? JSON.stringify(capability) : raw,
      { status: 200, headers: { "content-type": "application/json" } },
    )));
    try {
      const concrete = new InfinityContextRetrievalV3Adapter({ baseUrl: "https://infinity.invalid",
        operationTimeoutMs: 1000, requestTimeoutMs: 1000 });
      expect(await concrete.retrieve(request())).toMatchObject({ status: "unavailable" });
      const captured = concrete.takeExactExchange();
      expect(captured.responseBytes).toEqual(typeof raw === "string" ? new TextEncoder().encode(raw) : raw);
      expect(captured.contractVersion).toBe("context-retrieval.v3");
      expect(() => concrete.takeExactExchange()).toThrow();
      expect(() => concrete.takeObservation()).toThrow();
    } finally {vi.unstubAllGlobals();}
  });

it("captures successful wire bytes, keeps snapshot/candidate digests distinct, and clears stale custody", async () => {
  let capabilityBody = JSON.stringify(capability);
  const raw = ` ${JSON.stringify(response())}\n`;
  const fetch = vi.fn(async (url: string | URL | Request) => new Response(
    String(url).endsWith("/capability") ? capabilityBody : raw,
    { status: 200, headers: { "content-type": "application/json" } },
  ));
  vi.stubGlobal("fetch", fetch);
  try {
    const concrete = new InfinityContextRetrievalV3Adapter({ baseUrl: "https://infinity.invalid",
      operationTimeoutMs: 1000, requestTimeoutMs: 1000 });
    const result = await concrete.retrieve(request());
    expect(result.status).toBe("available");
    if (result.status !== "available") {throw new Error("Expected synthetic locators");}
    const observation = concrete.takeObservation();
    expect(observation).toMatchObject({ schemaVersion: 2, contractVersion: "context-retrieval.v3",
      exchangeSource: "exact_transport", capabilityRoute: "/v1/context/retrieve-v3/capability" });
    expect(observation.requestSha256).not.toBe(result.candidates[0]!.retrievalProvenance.requestDigest);
    expect(observation.responseSha256).not.toBe(result.candidates[0]!.retrievalProvenance.responseDigest);
    const exact = concrete.takeExactExchange();
    expect(new TextDecoder().decode(exact.responseBytes)).toBe(raw);
    expect(observation.requestSha256).toBe(createHash("sha256").update(exact.requestBytes).digest("hex"));
    expect(observation.responseSha256).toBe(createHash("sha256").update(exact.responseBytes).digest("hex"));
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
      : typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, nested]) => [key, canonical(nested)])) : value;
    expect(result.candidates[0]!.retrievalProvenance.requestDigest).toBe(createHash("sha256")
      .update(JSON.stringify(canonical(request()))).digest("hex"));
    await concrete.retrieve(request()); // Leave this exchange unread.
    capabilityBody = JSON.stringify({ context: { retrieval: capability } });
    expect((await concrete.retrieve(request())).status).not.toBe("available");
    expect(() => concrete.takeExactExchange()).toThrow();
    expect(() => concrete.takeObservation()).toThrow();
    capabilityBody = JSON.stringify(capability);
    expect((await concrete.retrieve(request())).status).toBe("available");
    expect((await concrete.retrieve(structuredClone(request()))).status).toBe("unqualified");
    expect(() => concrete.takeExactExchange()).toThrow();
  } finally {vi.unstubAllGlobals();}
});

it("preserves V2/null alongside explicit V3/any on separate exact transports", async () => {
  const { InfinityContextRetrievalV2Adapter } = await import("../src/infinity-context-retrieval-v2.js");
  const v2Capability = fixture("capability");
  const v2Response = { ...response(), contract_version: "context-retrieval.v2",
    capability_fingerprint: v2Capability.capability_fingerprint };
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    urls.push(path);
    const value = path === "/v1/capabilities" ? { context: { retrieval: v2Capability } }
      : path === "/v1/context/retrieve" ? v2Response
      : path.endsWith("/capability") ? capability : response();
    return new Response(JSON.stringify(value), { status: 200,
      headers: { "content-type": "application/json" } });
  }));
  try {
    const config = { baseUrl: "https://infinity.invalid", operationTimeoutMs: 1000, requestTimeoutMs: 1000 };
    const v2 = new InfinityContextRetrievalV2Adapter(config);
    const v3 = new InfinityContextRetrievalV3Adapter(config);
    const v2Request = { ...request(), schemaVersion: 2 as const,
      scope: { memoryScopeId: "scope-a", spaceId: "space-a", threadId: null },
      binding: { ...request().binding, contractVersion: "context-retrieval.v2" as const,
        capabilityFingerprint: v2Capability.capability_fingerprint as string } };
    expect((await v2.retrieve(v2Request)).status).toBe("available");
    expect((await v3.retrieve(request())).status).toBe("available");
    expect(urls).toEqual(["/v1/capabilities", "/v1/context/retrieve",
      "/v1/context/retrieve-v3/capability", "/v1/context/retrieve-v3"]);
    expect(JSON.parse(new TextDecoder().decode(v2.takeExactExchange().requestBytes)).scope)
      .toEqual({ memory_scope_id: "scope-a", space_id: "space-a", thread_id: null });
    expect(JSON.parse(new TextDecoder().decode(v3.takeExactExchange().requestBytes)).scope)
      .toEqual({ memoryScopeId: "scope-a", spaceId: "space-a", thread: { mode: "any" } });
  } finally {vi.unstubAllGlobals();}
});

it("retains fresh V3 scope identity with two separate bounded metadata reads", async () => {
  const { InfinityRetrievalScopeResolution } = await import("../src/infinity-retrieval-scope-resolution.js");
  const input = { spaceSlug: "external-space", roomScopeExternalRef: "external-room" };
  const metadataRequests: HttpRequest[] = [];
  let foreign = false;
  const transport: HttpTransport = { send: async (req) => {
    metadataRequests.push(req);
    return json(200, { data: req.url.pathname.endsWith("/spaces")
      ? [{ id: "space-a", slug: input.spaceSlug, status: "active" }]
      : [{ id: "scope-a", space_id: foreign ? "foreign-space" : "space-a",
        external_ref: input.roomScopeExternalRef, status: "active" }] });
  } };
  const resolver = new InfinityRetrievalScopeResolution({ baseUrl: "https://metadata.invalid",
    operationTimeoutMs: 500, requestTimeoutMs: 500, transport });
  const resolved = await resolver.resolve(input);
  if (resolved.status !== "resolved") {throw new Error("Expected synthetic scope");}
  const snapshot = request();
  resolved.bind(snapshot);
  const match = (value: InfinityContextRetrievalV3Request) => resolver.matches({ ...input,
    request: value, spaceId: "space-a", memoryScopeId: "scope-a" });
  expect(match(snapshot)).toBe(true);
  expect(match(freeze(structuredClone(snapshot)))).toBe(false);
  expect(metadataRequests).toHaveLength(2);
  expect(metadataRequests.every((req) => req.method === "GET" && req.maxResponseBytes === 65_536 &&
    req.url.searchParams.get("limit") === "100")).toBe(true);
  expect(await resolver.matchesPersisted({ ...input, request: snapshot })).toBe(true);
  foreign = true;
  expect(await resolver.matchesPersisted({ ...input, request: snapshot })).toBe(false);
  expect(match(snapshot)).toBe(true);
  expect(snapshot.filters.sourceGenerations).toEqual(request().filters.sourceGenerations);
});

it("rejects late POST success and never lets overlapping callers consume the owner's exchange", async () => {
  let now = 0;
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {release = resolve;});
  const entered = new Promise<void>((resolve) => {started = resolve;});
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
    if (!String(url).endsWith("/capability")) {started(); await pending; now = 1001;}
    return new Response(JSON.stringify(String(url).endsWith("/capability") ? capability : response()),
      { status: 200, headers: { "content-type": "application/json" } });
  }));
  try {
    const concrete = new InfinityContextRetrievalV3Adapter({ baseUrl: "https://infinity.invalid",
      operationTimeoutMs: 1000, requestTimeoutMs: 1000, monotonicNowMs: () => now });
    const active = concrete.retrieve(request());
    await entered;
    expect(await concrete.retrieve(request())).toMatchObject({ code: "memory.context_retrieval_busy" });
    release();
    expect(await active).toMatchObject({ code: "memory.context_retrieval_deadline_exceeded" });
    expect(concrete.takeExactExchange().responseBytes.length).toBeGreaterThan(0);
    expect(() => concrete.takeObservation()).toThrow();
  } finally {release(); vi.unstubAllGlobals();}
});

it("cancels during capability without issuing a POST or retry", async () => {
  const endpoint = new RetrievalV3Endpoint();
  endpoint.hang = true;
  const controller = new AbortController();
  const pending = adapter(endpoint).retrieve(request(), { signal: controller.signal });
  await vi.waitFor(() => {expect(endpoint.requests).toHaveLength(1);});
  controller.abort();
  expect(await pending).toEqual({ status: "unavailable", code: "memory.operation_cancelled", retryable: false });
  expect(endpoint.requests).toHaveLength(1);
});

it("accepts a pinned full active locator-v2 profile ID under V3", async () => {
  const endpoint = new RetrievalV3Endpoint();
  const full = { ...capability, profile_id: `locator-v2-full-${"2".repeat(64)}` };
  const fingerprint = retrievalV3CapabilityFingerprint(full);
  endpoint.capabilities = { ...full, capability_fingerprint: fingerprint };
  endpoint.response.profile_id = full.profile_id;
  endpoint.response.capability_fingerprint = fingerprint;
  expect((await adapter(endpoint).retrieve(request({ binding: { ...request().binding,
    profileId: full.profile_id, capabilityFingerprint: fingerprint } }))).status).toBe("available");
});

it.each([
  ["lifecycle_status", "deleted"], ["memory_scope_id", "foreign-scope"],
  ["projection_generation", "stale-generation"],
])("rejects hostile candidate %s instead of treating provider metadata as authority", async (field, value) => {
  const endpoint = new RetrievalV3Endpoint();
  (endpoint.response.candidates as Record<string, unknown>[])[0]![field] = value;
  expect(await adapter(endpoint).retrieve(request())).toMatchObject({
    status: "unavailable", code: "memory.context_retrieval_response_invalid",
  });
});

it("keeps one global provider order for different admitted sources", async () => {
  const endpoint = new RetrievalV3Endpoint();
  const candidates = endpoint.response.candidates as Record<string, unknown>[];
  candidates.push({ ...structuredClone(candidates[0]), source_key: "source-family-b",
    locator: "candidate-008", canonical_identity: "chunk-008", chunk_key: "chunk-008",
    document_key: "doc-008" });
  (endpoint.response.applied_bounds as Record<string, unknown>).returned_seeds = 2;
  const result = await adapter(endpoint).retrieve(request({ filters: { ...request().filters,
    sourceGenerations: [...request().filters.sourceGenerations,
      { sourceKey: "source-family-b", projectionGeneration: "generation-b-7" }] } }));
  expect(result.status).toBe("available");
  if (result.status !== "available") {throw new Error("Expected synthetic locators");}
  expect(result.candidates.map(({ locator }) => locator)).toEqual(["candidate-007", "candidate-008"]);
  expect(endpoint.requests).toHaveLength(2);
});

// Exercise the consumer admission guard, not just the adapter projection.
it.each([[1, 1], [2, 1]])("binds fused order for raw provider ranks %j", async (first, second) => {
  const ranks = [first, second];
  const { historicalRetrievalAuditsBindRequest } = await import(
    "../../meeting-core/src/features/meeting-knowledge/application/ports/focused-retrieval-provenance.js");
  const endpoint = new RetrievalV3Endpoint();
  const candidates = endpoint.response.candidates as Record<string, unknown>[];
  candidates.push({ ...structuredClone(candidates[0]), locator: "candidate-008",
    canonical_identity: "chunk-008", chunk_key: "chunk-008", document_key: "doc-008" });
  candidates.forEach((candidate, index) => {
    candidate.provider_rank = ranks[index];
    const contributions = candidate.contributions as Record<string, unknown>[];
    contributions.forEach((contribution, lane) => {
      const rank = lane === 0 ? ranks[index]! : index === 0 ? 2 : 100;
      contribution.provider_rank = rank;
      contribution.contribution_score_picos = Math.round(1_000_000_000_000 / (60 + rank));
      contribution.contribution = (contribution.contribution_score_picos as number) / 1_000_000_000_000;
    });
    candidate.base_score_picos = contributions.reduce((sum, c) => sum + (c.contribution_score_picos as number), 0);
    candidate.rerank_score_picos = candidate.base_score_picos;
    candidate.fused_score = (candidate.base_score_picos as number) / 1_000_000_000_000;
  });
  (endpoint.response.applied_bounds as Record<string, unknown>).returned_seeds = 2;
  const raw = JSON.stringify(endpoint.response);
  const snapshot = request();
  expect(snapshot.filters.sourceGenerations).toHaveLength(1);
  const result = await adapter(endpoint).retrieve(snapshot);
  expect(result.status).toBe("available");
  if (result.status !== "available") {throw new Error("Expected admitted synthetic response");}
  expect(result.candidates.map(candidate => candidate.retrievalProvenance.providerRank)).toEqual([1, 2]);
  expect(await historicalRetrievalAuditsBindRequest(result.candidates, snapshot)).toBe(true);
  expect(result.candidates.map(candidate => candidate.retrievalProvenance.contributions[0]!.providerRank))
    .toEqual(ranks);
  expect(JSON.stringify(endpoint.response)).toBe(raw);
});

it("reconstructs V3 frozen binding with separate byte, snapshot and projection identities", async () => {
  const { createCanonicalRetrievalBinding, validateCanonicalRetrievalBinding } = await import(
    "../src/quality-campaign/canonical-execution-artifact-validation.js");
  const input = await custodyFixture();
  const binding = await createCanonicalRetrievalBinding(input);
  expect(binding.providerStatus).toBe("available");
  expect(binding.candidates[0]?.providerRank).toBe(1);
  expect(binding.rawRequestSha256).not.toBe(binding.snapshotSha256);
  expect(binding.rawResponseSha256).not.toBe(binding.candidateProjectionSha256);
  expect(Object.isFrozen(binding.request.filters.sourceGenerations)).toBe(true);
  expect(await validateCanonicalRetrievalBinding(binding, input)).toEqual(binding);
  for (const field of ["snapshotSha256", "officialPayloadSha256", "rawRequestSha256", "rawResponseSha256",
    "descriptorSha256", "candidateProjectionSha256", "attemptId", "contractVersion"]) {
    await expect(validateCanonicalRetrievalBinding({ ...binding, [field]: "tampered" }, input)).rejects.toThrow();
  }
  await expect(validateCanonicalRetrievalBinding({ ...binding, extra: true }, input)).rejects.toThrow();
  await expect(validateCanonicalRetrievalBinding({ ...binding, request: undefined }, input)).rejects.toThrow();
  await expect(validateCanonicalRetrievalBinding(binding, { ...input,
    packet: { ...input.packet, questionId: "other" } })).rejects.toThrow();
  await expect(validateCanonicalRetrievalBinding(binding, { ...input,
    topology: { ...input.topology, roomId: "other" } })).rejects.toThrow();
  const changed = structuredClone(binding);
  (changed.request.filters.sourceGenerations[0] as { projectionGeneration: string }).projectionGeneration = "other";
  await expect(validateCanonicalRetrievalBinding(changed, input)).rejects.toThrow();
  await expect(validateCanonicalRetrievalBinding({ ...binding, candidates: [] }, input)).rejects.toThrow();
});

it("retains malformed raw response as failed binding without inventing candidates", async () => {
  const { createCanonicalRetrievalBinding } = await import(
    "../src/quality-campaign/canonical-execution-artifact-validation.js");
  const input = await custodyFixture();
  const raw = new TextEncoder().encode('{"status":"available","status":"unavailable"}');
  const binding = await createCanonicalRetrievalBinding({ ...input,
    exchange: { ...input.exchange, responseBytes: raw } });
  expect(binding.providerStatus).toBe("invalid_response");
  expect(binding.candidates).toEqual([]);
  expect(binding.rawResponseSha256).toBe(createHash("sha256").update(raw).digest("hex"));
});

it("keeps generic V3 retrieval custody multi-source while diagnostic custody remains single-source", async () => {
  const { createCanonicalRetrievalBinding } = await import(
    "../src/quality-campaign/canonical-execution-artifact-validation.js");
  const { retrievalV3RequestPayload } = await import("@infinity-context/sdk");
  const { retrievalV3InputFromSnapshot } = await import("../src/infinity-context-retrieval-v3.js");
  const base = await custodyFixture();
  const snapshot = request({ budgets: base.request.budgets, filters: { ...base.request.filters,
    sourceGenerations: [...base.request.filters.sourceGenerations, {
      projectionGeneration: "generation-b-42", sourceKey: "source-family-b" }] } });
  const exchange = { ...base.exchange, requestBytes: new TextEncoder().encode(JSON.stringify(
    retrievalV3RequestPayload(retrievalV3InputFromSnapshot(snapshot)))) };
  await expect(createCanonicalRetrievalBinding({ ...base, diagnosticPlanSha256: null,
    request: snapshot, exchange })).resolves.toMatchObject({ request: snapshot });
  await expect(createCanonicalRetrievalBinding({ ...base, request: snapshot, exchange }))
    .rejects.toThrow("diagnostic single-source");
});

it("requires and reconstructs the V3 retrieval binding in retained local evidence", async () => {
  const { mkdtemp, unlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createCanonicalRetrievalBinding, custodyJson } = await import(
    "../src/quality-campaign/canonical-execution-artifact-validation.js");
  const { createProductionCanonicalExecutionEvidence } = await import(
    "../src/quality-campaign/production-canonical-execution-evidence.js");
  const { createProductionLocalCanonicalEvidenceReader } = await import(
    "../src/quality-campaign/production-local-canonical-evidence-reader.js");
  const input = await custodyFixture();
  const binding = await createCanonicalRetrievalBinding(input);
  const root = await mkdtemp(join(tmpdir(), "canonical-v3-reader-"));
  const artifactRoot = join(root, "artifacts");
  const artifactKey = new Uint8Array(32).fill(7);
  const campaignRootSha256 = "c".repeat(64);
  const evidence = createProductionCanonicalExecutionEvidence({ answerJournalRoot: join(root, "answer"),
    artifactKey, artifactKeyId: "synthetic-key", artifactRoot, attemptId: input.attemptId,
    questionId: input.packet.questionId, repetition: 1, retrievalJournalRoot: join(root, "retrieval"),
    rootBindingSha256: campaignRootSha256 });
  const canonicalCapability = new TextEncoder().encode(custodyJson(capability));
  const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
  const observation = { attemptId: input.attemptId, capabilityAndRetrievalLatencyUs: 12,
    capabilityBytes: canonicalCapability.byteLength, capabilitySha256: sha(canonicalCapability),
    capabilityRoute: "/v1/context/retrieve-v3/capability", capabilitySemantics: "bare_descriptor",
    contractVersion: "context-retrieval.v3", requestBytes: input.exchange.requestBytes.byteLength,
    requestSha256: sha(input.exchange.requestBytes), responseBytes: input.exchange.responseBytes.byteLength,
    responseSha256: sha(input.exchange.responseBytes), retrievalRoute: "/v1/context/retrieve-v3",
    routeLatencyUs: 7, schemaVersion: "meeting_knowledge.canonical_retrieval_observation.v2" };
  const turn = { endMs: 2, sourceLocatorId: binding.candidates[0]!.locatorId,
    speakerId: "speaker-1", startMs: 1, text: "Approved.", turnHash: "d".repeat(64),
    turnId: "turn-1" };
  const outcome = { citations: [turn.turnId], claims: ["Approved."],
    rawRetrievalResponseSha256: binding.rawResponseSha256,
    retrievalCandidates: binding.candidates, selectedTurns: [turn], status: "answered" };
  for (const [kind, plaintext] of [
    ["capability_request", input.exchange.capabilityRequestBytes],
    ["capability_response", input.exchange.capabilityResponseBytes],
    ["retrieval_request", input.exchange.requestBytes], ["retrieval_response", input.exchange.responseBytes],
    ["retrieval_binding", new TextEncoder().encode(custodyJson(binding))],
    ["retrieval_observation", new TextEncoder().encode(JSON.stringify(observation))],
    ["scope_resolution_observation", new TextEncoder().encode(JSON.stringify({
      schemaVersion: "meeting_knowledge.scope_resolution.v1", status: "prepared",
      reads: ["scope_spaces", "scope_memory_scopes"].map(kind => ({ kind,
        requestSha256: "1".repeat(64), responseSha256: "2".repeat(64), responseBytes: 12,
        status: "received" })) }))],
    ["answer_normalized_outcome", new TextEncoder().encode(JSON.stringify(outcome))],
  ] as const) { await evidence.audit.seal({ attemptId: input.attemptId, kind, plaintext }); }
  const reader = createProductionLocalCanonicalEvidenceReader({ artifactKey,
    artifactKeyId: "synthetic-key", artifactRoot });
  const projection = { answerAbstained: false, attemptId: input.attemptId, campaignRootSha256,
    capabilityRequestSha256: sha(input.exchange.capabilityRequestBytes),
    capabilityResponseSha256: sha(input.exchange.capabilityResponseBytes),
    citationLocatorIds: [turn.sourceLocatorId], evidenceLocatorIds: [turn.sourceLocatorId],
    evidenceTurnIds: [turn.turnId], rankedLocatorIds: binding.candidates.map(value => value.locatorId),
    retrievalLatencyUs: 12, retrievalRequestSha256: binding.rawRequestSha256,
    retrievalResponseSha256: binding.rawResponseSha256 };
  await expect(reader.verify({ attempts: [projection], campaignRootSha256 })).resolves.toMatchObject({
    inventorySha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  await unlink(join(artifactRoot, "receipts", input.attemptId, "retrieval_binding.json"));
  await expect(reader.verify({ attempts: [projection], campaignRootSha256 })).rejects.toThrow();
});

it("rejects mixed routes, request bytes, and hostile bare descriptor bytes", async () => {
  const { createCanonicalRetrievalBinding } = await import(
    "../src/quality-campaign/canonical-execution-artifact-validation.js");
  const input = await custodyFixture();
  for (const exchange of [
    { ...input.exchange, capabilityRoute: "/v1/capabilities" },
    { ...input.exchange, requestBytes: new TextEncoder().encode('{}') },
    { ...input.exchange, capabilityResponseBytes: new TextEncoder().encode('{"context":{}}') },
    { ...input.exchange, capabilityResponseBytes: new TextEncoder().encode(
      JSON.stringify(capability).replace('{', '{"contract_version":"context-retrieval.v3",')) },
  ]) {
    await expect(createCanonicalRetrievalBinding({ ...input, exchange: exchange as typeof input.exchange })).rejects.toThrow();
  }
});

async function custodyFixture() {
  const { retrievalV3RequestPayload } = await import("@infinity-context/sdk");
  const { retrievalV3InputFromSnapshot } = await import("../src/infinity-context-retrieval-v3.js");
  const snapshot = request({ budgets: { ...request().budgets, deadlineMs: 2000 } });
  const raw = response();
  (raw.applied_bounds as Record<string, unknown>).deadline_ms = 2000;
  return {
    attemptId: `sqv4-${"a".repeat(64)}`,
    packet: { locale: "en" as const, questionId: "q1", questionText: "What was approved?",
      scopeTopologyReference: "signed:one", source: "automatic" as const },
    topology: { scopeId: "scope1", roomId: "room1", currentMeetingId: "meeting1" },
    diagnosticPlanSha256: "b".repeat(64), request: snapshot,
    exchange: { schemaVersion: 2 as const, contractVersion: "context-retrieval.v3" as const,
      capabilityRoute: "/v1/context/retrieve-v3/capability" as const,
      retrievalRoute: "/v1/context/retrieve-v3" as const,
      capabilityRequestBytes: new Uint8Array(),
      capabilityResponseBytes: new TextEncoder().encode(JSON.stringify(capability)),
      requestBytes: new TextEncoder().encode(JSON.stringify(retrievalV3RequestPayload(retrievalV3InputFromSnapshot(snapshot)))),
      responseBytes: new TextEncoder().encode(JSON.stringify(raw)) },
  };
}
