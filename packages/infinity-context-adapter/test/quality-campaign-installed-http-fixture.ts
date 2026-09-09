import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";
import { expect } from "vitest";
import { retrievalV2CapabilityFingerprint } from "../src/infinity-context-retrieval-v2.js";

const require = createRequire(import.meta.url);

function sdkFixture(name: "capability" | "success"): Record<string, unknown> {
  return JSON.parse(readFileSync(require.resolve(
    `@infinity-context/sdk/fixtures/context_retrieval_v2/${name}.json`), "utf8")) as
    Record<string, unknown>;
}

export function sdkQualificationCapability(): Record<string, unknown> {
  const capability = sdkFixture("capability");
  capability.profile_id = `locator-v2-full-${String(capability.index_profile_digest)}`;
  capability.capability_fingerprint = retrievalV2CapabilityFingerprint(capability);
  return capability;
}

export function sdkRetrievalResponse(locator: string,
  capability: Record<string, unknown>): Record<string, unknown> {
  const fixture = sdkFixture("success");
  const candidate = (fixture.candidates as Record<string, unknown>[])[0]!;
  const direct: Record<string, unknown> = structuredClone({ ...candidate, locator, neighbors: [] });
  Object.assign(direct, { actor_matched_weight_micros: 0, actor_requested_weight_micros: 0,
    matched_query_ids: ["original-question"], preference_boost_micros: 0,
    preference_score_micros: 0, rerank_score_picos: direct.base_score_picos,
    source_matched_weight_micros: 0, source_requested_weight_micros: 0,
    time_matched_weight_micros: 0, time_requested_weight_micros: 0 });
  direct.contributions = (direct.contributions as Record<string, unknown>[]).map((value) =>
    ({ ...value, query_id: "original-question" }));
  return structuredClone({ ...fixture, capability_fingerprint: capability.capability_fingerprint,
    profile_id: capability.profile_id, applied_bounds: { candidate_limit: 100,
    deadline_ms: 2_000, neighbor_radius: 0, response_byte_limit: 16_384, result_limit: 10,
    returned_neighbors: 0, returned_seeds: 1 }, candidates: [direct] });
}

export function packedScopeHttpFixture(topology: {
  readonly spaceSlug: string; readonly roomScopeExternalRef: string;
}) {
  const metadata = { name: "Synthetic packed scope", status: "active",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
  const space = { ...metadata, id: "packed-internal-space", slug: topology.spaceSlug };
  const scope = { ...metadata, id: "packed-internal-room", space_id: space.id,
    external_ref: topology.roomScopeExternalRef };
  const requests: { method: string | undefined; path: string; query: string }[] = [];
  const retrievalScopes: unknown[] = [];
  return {
    observeRetrieval(request: IncomingMessage): void {
      const chunks: Uint8Array[] = [];
      request.on("data", (chunk: Uint8Array) => { chunks.push(chunk); });
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { scope: unknown };
        retrievalScopes.push(body.scope);
      });
    },
    serve(request: IncomingMessage, response: ServerResponse): boolean {
      const url = new URL(request.url ?? "/", "https://127.0.0.1");
      if (url.pathname !== "/v1/spaces" && url.pathname !== "/v1/memory-scopes") { return false; }
      requests.push({ method: request.method, path: url.pathname, query: url.search });
      if (request.method !== "GET") { response.writeHead(405).end(); return true; }
      const data = url.pathname === "/v1/spaces" ? [space] :
        url.searchParams.get("space_id") === space.id ? [scope] : [];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data })); return true;
    },
    assertReads(resolutions: number): void {
      expect(space.id).not.toBe(topology.spaceSlug);
      expect(scope.id).not.toBe(topology.roomScopeExternalRef);
      expect(requests).toHaveLength(resolutions * 2);
      expect(retrievalScopes).toEqual(Array.from({ length: resolutions }, () => ({
        space_id: space.id, memory_scope_id: scope.id, thread_id: null,
      })));
      expect(requests.filter(({ path }) => path === "/v1/spaces")).toEqual(
        Array.from({ length: resolutions }, () => ({ method: "GET", path: "/v1/spaces", query: "?limit=100" })));
      expect(requests.filter(({ path }) => path === "/v1/memory-scopes")).toEqual(
        Array.from({ length: resolutions }, () => ({ method: "GET", path: "/v1/memory-scopes",
          query: `?space_id=${space.id}&limit=100` })));
    },
  };
}
