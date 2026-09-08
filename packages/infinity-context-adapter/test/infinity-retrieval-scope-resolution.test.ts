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
      body: JSON.stringify(requests.length === 1 ? spaces : scopes) };
  } };
  const resolver = new InfinityRetrievalScopeResolution({ baseUrl: "http://scope.test/v1",
    operationTimeoutMs: 500, requestTimeoutMs: 500, transport });
  return { resolver, requests };
}

describe("official SDK read-only scope resolution", () => {
  it("keeps an admitted binding valid when a later same-scope read fails", async () => {
    const { resolver } = fixture();
    const admitted = await resolver.resolve(input);
    expect(admitted.status).toBe("resolved");
    const failed = await resolver.resolve({ ...input, effects: {
      beforeRead: async () => { throw new Error("next request is not admitted"); },
      observe: async () => {},
    } });
    expect(failed.status).toBe("unavailable");
    expect(resolver.matches({ ...input, spaceId: space.id, memoryScopeId: scope.id })).toBe(true);
  });

  it("resolves external references to different internal IDs with two bounded GETs", async () => {
    const { resolver, requests } = fixture();
    const beforeRead = vi.fn(async () => {});
    const observe = vi.fn(async () => {});
    expect(await resolver.resolve({ ...input, effects: { beforeRead, observe } })).toEqual({
      status: "resolved", spaceId: space.id, memoryScopeId: scope.id });
    expect(requests.map(({ method }) => method)).toEqual(["GET", "GET"]);
    expect(requests[1]!.url.searchParams.get("space_id")).toBe(space.id);
    expect(requests.every(({ maxResponseBytes }) => maxResponseBytes === 65_536)).toBe(true);
    expect(requests.every(({ url }) => url.searchParams.get("limit") === "100")).toBe(true);
    expect(beforeRead.mock.calls).toHaveLength(2);
    expect(observe.mock.calls).toHaveLength(2);
    expect(resolver.matches({ ...input, spaceId: space.id, memoryScopeId: scope.id })).toBe(true);
    expect(resolver.matches({ ...input, roomScopeExternalRef: "foreign", spaceId: space.id,
      memoryScopeId: scope.id })).toBe(false);
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
    expect(resolver.matches({ ...input, spaceId: space.id, memoryScopeId: scope.id })).toBe(false);
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
