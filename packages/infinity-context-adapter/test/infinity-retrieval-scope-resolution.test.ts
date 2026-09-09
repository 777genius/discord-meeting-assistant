import type { FocusedLocatorRetrievalV2RequestSnapshot } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { describe, expect, it, vi } from "vitest";
import type { HttpRequest, HttpTransport } from "@infinity-context/sdk";
import { InfinityRetrievalScopeResolution } from "../src/infinity-retrieval-scope-resolution.js";

const input = { spaceSlug: "external-space", roomScopeExternalRef: "external-room" };
const space = { id: "internal-space-123", slug: input.spaceSlug, name: "Synthetic", status: "active",
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
const scope = { id: "internal-scope-456", space_id: space.id, external_ref: input.roomScopeExternalRef,
  name: "Synthetic", status: "active", created_at: space.created_at, updated_at: space.updated_at };
function fixture(spaces: unknown = { data: [space] }, scopes: unknown = { data: [scope] }) {
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = { send: async (request) => {
    requests.push(request);
    return { status: 200, headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify(request.url.pathname.endsWith("/spaces") ? spaces : scopes) };
  } };
  const resolver = new InfinityRetrievalScopeResolution({ baseUrl: "http://scope.test/v1",
    operationTimeoutMs: 500, requestTimeoutMs: 500, transport });
  return { resolver, requests };
}

function preparedRequest(): FocusedLocatorRetrievalV2RequestSnapshot {
  return Object.freeze({
    schemaVersion: 2,
    binding: { capabilityFingerprint: "3".repeat(64), contractVersion: "context-retrieval.v2",
      indexProfileDigest: "2".repeat(64), profileId: "synthetic",
      rankingPolicy: "weighted_rrf_canonical_preferences.v1", requiredProviderLanes: [],
      serviceRevision: "4".repeat(40) },
    budgets: { candidateLimit: 100, deadlineMs: 2000, evidenceByteLimit: 16000,
      neighborRadius: 0, responseByteLimit: 16384, resultLimit: 10 },
    filters: { actorKeys: [], category: null, documentKeys: [], excludedSourceKeys: [],
      kinds: ["record_block"], relativeTimeInterval: null, sourceGenerations: [],
      tagsAll: [], tagsAny: [], tagsNone: [], timeInterval: null },
    queries: [{ query: "Synthetic question", queryId: "original-question" }],
    scope: Object.freeze({ spaceId: space.id, memoryScopeId: scope.id, threadId: null }),
    softPreferences: { actorPreferences: [], relativeTimeInterval: null, sourcePreferences: [],
      timeInterval: null, timeWeightMicros: null },
  } satisfies FocusedLocatorRetrievalV2RequestSnapshot);
}
function match(resolver: InfinityRetrievalScopeResolution, request: FocusedLocatorRetrievalV2RequestSnapshot) {
  return resolver.matches({ ...input, request, ...request.scope });
}

describe("official SDK read-only scope resolution", () => {
  it("keeps an admitted binding valid when a later same-scope read fails", async () => {
    const { resolver } = fixture();
    const admitted = await resolver.resolve(input);
    if (admitted.status !== "resolved") { throw new Error("Missing resolution"); }
    const request = preparedRequest();
    admitted.bind(request);
    const failed = await resolver.resolve({ ...input, effects: {
      beforeRead: async () => { throw new Error("next request is not admitted"); },
      observe: async () => {},
    } });
    expect(failed.status).toBe("unavailable");
    expect(match(resolver, request)).toBe(true);
  });

  it("resolves external references to different internal IDs with two bounded GETs", async () => {
    const { resolver, requests } = fixture();
    const beforeRead = vi.fn(async () => {});
    const observe = vi.fn(async () => {});
    const admitted = await resolver.resolve({ ...input, effects: { beforeRead, observe } });
    expect(admitted).toMatchObject({ status: "resolved", spaceId: space.id, memoryScopeId: scope.id });
    if (admitted.status !== "resolved") { throw new Error("Missing resolution"); }
    const request = preparedRequest();
    const bytes = JSON.stringify(request);
    admitted.bind(request);
    expect(JSON.stringify(request)).toBe(bytes);
    expect(requests.map(({ method }) => method)).toEqual(["GET", "GET"]);
    expect(requests[1]!.url.searchParams.get("space_id")).toBe(space.id);
    expect(requests.every(({ maxResponseBytes }) => maxResponseBytes === 65_536)).toBe(true);
    expect(requests.every(({ url }) => url.searchParams.get("limit") === "100")).toBe(true);
    expect(beforeRead.mock.calls).toHaveLength(2);
    expect(observe.mock.calls).toHaveLength(2);
    expect(match(resolver, request)).toBe(true);
    expect(resolver.matches({ ...input, request, roomScopeExternalRef: "foreign", spaceId: space.id,
      memoryScopeId: scope.id })).toBe(false);
  });

  it("retains overlapping requests and more than 100 later resolutions", async () => {
    const spaces = { data: [{ ...space }] };
    const scopes = { data: [{ ...scope }] };
    const { resolver } = fixture(spaces, scopes);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const first = resolver.resolve({ ...input, effects: {
      beforeRead: async () => { entered(); await barrier; }, observe: async () => {},
    } });
    await waiting;
    const second = await resolver.resolve(input);
    if (second.status !== "resolved") { throw new Error("Missing resolution"); }
    const secondRequest = preparedRequest();
    second.bind(secondRequest);
    release();
    const earlier = await first;
    if (earlier.status !== "resolved") { throw new Error("Missing resolution"); }
    const firstRequest = preparedRequest();
    earlier.bind(firstRequest);
    for (let index = 0; index < 101; index += 1) {
      const otherInput = { spaceSlug: `space-${index}`, roomScopeExternalRef: `room-${index}` };
      spaces.data[0]!.slug = otherInput.spaceSlug;
      scopes.data[0]!.external_ref = otherInput.roomScopeExternalRef;
      const other = await resolver.resolve(otherInput);
      if (other.status !== "resolved") { throw new Error("Missing resolution"); }
      other.bind(preparedRequest());
    }
    expect(match(resolver, firstRequest)).toBe(true);
    expect(match(resolver, secondRequest)).toBe(true);
  });

  it("keeps both same-room requests bound when the provider IDs change", async () => {
    const spaces = { data: [{ ...space }] };
    const scopes = { data: [{ ...scope }] };
    const { resolver } = fixture(spaces, scopes);
    const first = await resolver.resolve(input);
    if (first.status !== "resolved") { throw new Error("Missing resolution"); }
    const firstRequest = preparedRequest();
    first.bind(firstRequest);
    spaces.data[0]!.id = "replacement-space";
    scopes.data[0]!.space_id = "replacement-space";
    scopes.data[0]!.id = "replacement-scope";
    const second = await resolver.resolve(input);
    if (second.status !== "resolved") { throw new Error("Missing resolution"); }
    const secondRequest = Object.freeze({ ...preparedRequest(), scope: Object.freeze({
      spaceId: second.spaceId, memoryScopeId: second.memoryScopeId, threadId: null,
    }) });
    expect(() => second.bind(firstRequest)).toThrow();
    second.bind(secondRequest);
    expect(match(resolver, firstRequest)).toBe(true);
    expect(match(resolver, secondRequest)).toBe(true);
  });

  it("rejects copied, tampered, unbound, and foreign request authority", async () => {
    const { resolver } = fixture();
    const admitted = await resolver.resolve(input);
    if (admitted.status !== "resolved") { throw new Error("Missing resolution"); }
    const request = preparedRequest();
    expect(match(resolver, request)).toBe(false);
    expect(() => admitted.bind(Object.freeze({ ...request,
      scope: Object.freeze({ ...request.scope, spaceId: "foreign" }) }))).toThrow();
    expect(() => admitted.bind({ ...request })).toThrow();
    admitted.bind(request);
    expect(() => admitted.bind(preparedRequest())).toThrow();
    expect(match(resolver, Object.freeze({ ...request }))).toBe(false);
    expect(match(resolver, Object.create(request) as FocusedLocatorRetrievalV2RequestSnapshot)).toBe(false);
    expect(match(resolver, JSON.parse(JSON.stringify(request)) as FocusedLocatorRetrievalV2RequestSnapshot)).toBe(false);
    expect(match(fixture().resolver, request)).toBe(false);
    expect(Reflect.set(request.scope, "spaceId", "foreign")).toBe(false);
    expect(match(resolver, request)).toBe(true);
  });

  it.each([
    ["missing space", { data: [] }, { data: [scope] }, 1],
    ["duplicate space", { data: [space, space] }, { data: [scope] }, 1],
    ["invalid space ID", { data: [{ ...space, id: "../foreign" }] }, { data: [scope] }, 1],
    ["full space page", { data: Array.from({ length: 100 }, () => space) }, { data: [scope] }, 1],
    ["pagination metadata", { data: [space], next_cursor: "next" }, { data: [scope] }, 1],
    ["missing scope", { data: [space] }, { data: [] }, 2],
    ["duplicate scope", { data: [space] }, { data: [scope, scope] }, 2],
    ["foreign parent", { data: [space] }, { data: [{ ...scope, space_id: "foreign" }] }, 2],
    ["invalid scope ID", { data: [space] }, { data: [{ ...scope, id: "" }] }, 2],
    ["full scope page", { data: [space] }, { data: Array.from({ length: 100 }, () => scope) }, 2],
    ["oversized metadata", { data: [{ ...space, name: "x".repeat(65_536) }] }, { data: [scope] }, 1],
  ])("fails closed on %s", async (_name, spaces, scopes, count) => {
    const { resolver, requests } = fixture(spaces, scopes);
    expect(await resolver.resolve(input)).toEqual({ status: "unavailable" });
    expect(requests).toHaveLength(count as number);
    expect(match(resolver, preparedRequest())).toBe(false);
  });

  it("does not send metadata when effect admission fails", async () => {
    const { resolver, requests } = fixture();
    expect(await resolver.resolve({ ...input, effects: {
      beforeRead: async () => { throw new Error("not reserved"); }, observe: async () => {},
    } })).toEqual({ status: "unavailable" });
    expect(requests).toHaveLength(0);
  });

  it("bounds a transport that ignores cancellation and never starts the second GET", async () => {
    const send = vi.fn(() => new Promise<never>(() => {}));
    const resolver = new InfinityRetrievalScopeResolution({ baseUrl: "http://scope.test/v1",
      operationTimeoutMs: 10, requestTimeoutMs: 10, transport: { send } });
    expect(await resolver.resolve(input)).toEqual({ status: "unavailable" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toBeDefined();
  });

  it("does not call the SDK after caller cancellation", async () => {
    const { resolver, requests } = fixture();
    expect(await resolver.resolve({ ...input, signal: AbortSignal.abort() })).toEqual({ status: "unavailable" });
    expect(requests).toHaveLength(0);
  });
});
