import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  HistoricalFocusedLocatorRetrievalV2,
  PrepareFocusedLocatorRetrievalV2Request,
  type FocusedLocatorRetrievalV2Port,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  TestIds,
} from "../../fixtures/historical-retrieval-fixtures.js";
import {
  scopeResolution,
  authorization,
  expectPrepared,
  fixture,
  providerBinding,
} from "./focused-locator-retrieval-v2.fixture.test.js";

describe("resolved scope preparation", () => {
  it("prepares internal IDs without exposing external references in the request", async () => {
    const { prepare } = fixture();
    const request = await prepare.prepare({ currentMeetingId: "current", question: "What happened?",
      roomId: "room-1", scopeId: "scope-1" });
    expectPrepared(request);
    expect(request.scope).toEqual({ spaceId: "internal-space-123", memoryScopeId: "internal-room-456", threadId: null });
    const serialized: unknown = JSON.parse(JSON.stringify(request));
    if (typeof serialized !== "object" || serialized === null || !("scope" in serialized)) {
      throw new Error("Expected a serialized request with scope");
    }
    expect(serialized.scope).toEqual(request.scope);
  });
  it("rejects copied prepared requests before provider or authorization I/O", async () => {
    const { prepare, store } = fixture();
    const request = await prepare.prepare({ currentMeetingId: "current", question: "What happened?",
      roomId: "room-1", scopeId: "scope-1" });
    expectPrepared(request);
    const retrieve = vi.fn<FocusedLocatorRetrievalV2Port["retrieve"]>(async () => ({
      status: "available", candidates: [],
    }));
    const authority = authorization();
    const authorize = vi.fn((...args: Parameters<typeof authority.authorize>) => authority.authorize(...args));
    const rehydrate = new HistoricalFocusedLocatorRetrievalV2({ scopeResolution,
      ids: new TestIds(), store, authorization: { authorize }, retrieval: { retrieve },
      turnHashes: { hash: () => "unused" },
    });
    const input = { authorizationPrincipalRef: "principal", currentMeetingId: "current",
      request, roomId: "room-1", scopeId: "scope-1" };
    await expect(rehydrate.retrieveEvidence({ ...input, request: Object.freeze({ ...request }) }))
      .resolves.toEqual({ status: "unavailable", reason: "scope_not_bound" });
    expect(retrieve).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    await expect(rehydrate.retrieveEvidence(input)).resolves.toMatchObject({ status: "empty" });
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrieve.mock.calls[0]?.[0]).toBe(request);
  });

  it("binds the exact immutable serialized request and rejects failed binding", async () => {
    const { store } = fixture();
    let bound: unknown;
    const resolver = { ...scopeResolution, resolve: async () => ({
      status: "resolved" as const, spaceId: "internal-space-123", memoryScopeId: "internal-room-456",
      bind: (request: unknown) => { bound = request; },
    }) };
    const prepare = new PrepareFocusedLocatorRetrievalV2Request({
      ids: new TestIds(), providerBinding, scopeResolution: resolver, store,
    });
    const request = await prepare.prepare({ currentMeetingId: "current", question: "What happened?",
      roomId: "room-1", scopeId: "scope-1" });
    expectPrepared(request);
    expect(bound).toBe(request);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.scope)).toBe(true);
    expect(Object.keys(request)).not.toContain("bind");
    expect(Object.keys(request)).not.toContain("status");
    const failing = new PrepareFocusedLocatorRetrievalV2Request({
      ids: new TestIds(), providerBinding, store, scopeResolution: { ...resolver,
        resolve: async () => ({ ...await resolver.resolve(),
          bind: () => { throw new Error("Binding denied"); } }),
      },
    });
    await expect(failing.prepare({ currentMeetingId: "current", question: "What happened?",
      roomId: "room-1", scopeId: "scope-1" })).resolves.toEqual({
      status: "unavailable", reason: "scope_resolution_unavailable",
    });
  });

  it.each([undefined, { ...scopeResolution, resolve: async () => ({ status: "unavailable" as const }) },
    { ...scopeResolution, resolve: async () => { throw new Error("metadata timeout"); } },
    { ...scopeResolution, resolve: async () => ({ status: "resolved" as const, spaceId: "", memoryScopeId: "room", bind: () => {} }) },
  ])("does not prepare a retrieval request when resolution fails", async (resolver) => {
    const { store } = fixture();
    const preparer = new PrepareFocusedLocatorRetrievalV2Request({ ids: new TestIds(), providerBinding,
      ...(resolver === undefined ? {} : { scopeResolution: resolver }), store });
    expect(await preparer.prepare({ currentMeetingId: "current", question: "What happened?",
      roomId: "room-1", scopeId: "scope-1" })).toEqual({ status: "unavailable", reason: "scope_resolution_unavailable" });
  });
});
