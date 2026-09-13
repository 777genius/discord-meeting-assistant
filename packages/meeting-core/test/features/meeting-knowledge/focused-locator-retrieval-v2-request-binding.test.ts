import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  HistoricalFocusedLocatorRetrievalV2,
  HistoricalFocusedLocatorRetrievalV3,
  buildHistoricalIndexPlan,
  PrepareFocusedLocatorRetrievalV2Request,
  PrepareFocusedLocatorRetrievalV3Request,
  type FocusedLocatorRetrievalV2Port,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  TestIds,
  AppliedStore,
  makeMeeting,
} from "../../fixtures/historical-retrieval-fixtures.js";
import {
  scopeResolution,
  authorization,
  expectPrepared,
  fixture,
  providerBinding,
  providerCandidate,
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


describe("V3 shared deterministic preparation", () => {
  it("changes only contract and selector while retaining the complete admitted pair set", async () => {
    const { prepare, store } = fixture();
    let bound: unknown;
    const v3 = new PrepareFocusedLocatorRetrievalV3Request({ ids: new TestIds(), store,
      providerBinding: { ...providerBinding, contractVersion: "context-retrieval.v3" },
      scopeResolution: { ...scopeResolution, resolve: async () => ({
        status: "resolved", spaceId: "internal-space-123", memoryScopeId: "internal-room-456",
        bind: (value) => { bound = value; },
      }) },
    });
    const input = { currentMeetingId: "not-an-admitted-historical-meeting",
      question: "What happened?", roomId: "room-1", scopeId: "scope-1" };
    const old = await prepare.prepare(input);
    const request = await v3.prepare(input);
    expectPrepared(old);
    if (request.status !== "prepared") {throw new Error(request.status);}
    expect(request.schemaVersion).toBe(3);
    expect(request.binding.contractVersion).toBe("context-retrieval.v3");
    expect(request.scope).toEqual({ spaceId: old.scope.spaceId,
      memoryScopeId: old.scope.memoryScopeId, thread: { mode: "any" } });
    expect(request.filters).toEqual(old.filters);
    expect(request.queries).toEqual(old.queries);
    expect(request.budgets).toEqual(old.budgets);
    expect(request.softPreferences).toEqual(old.softPreferences);
    expect(request.filters.sourceGenerations.length).toBeGreaterThan(0);
    expect(Object.isFrozen(request.scope.thread)).toBe(true);
    expect(bound).toBe(request);
    expect(Object.keys(request)).not.toContain("status");
  });
});


it("keeps V3 request authority by identity and binds historical generation to the request", async () => {
  const { store } = fixture();
  const admitted = new WeakSet<object>();
  const resolver = { ...scopeResolution,
    matches: (input: { request: object }) => admitted.has(input.request),
    resolve: async () => ({ status: "resolved" as const,
      spaceId: "internal-space-123", memoryScopeId: "internal-room-456",
      bind: (request: object) => { admitted.add(request); },
    }),
  };
  const preparer = new PrepareFocusedLocatorRetrievalV3Request({ ids: new TestIds(), store,
    providerBinding: { ...providerBinding, contractVersion: "context-retrieval.v3" },
    scopeResolution: resolver });
  const retrieve = vi.fn(async () => ({ status: "available" as const, candidates: [] }));
  const historical = new HistoricalFocusedLocatorRetrievalV3({ ids: new TestIds(), store,
    scopeResolution: resolver, authorization: authorization([true, true, true, true]), retrieval: { retrieve },
    turnHashes: { hash: () => "unused" } });
  const input = { currentMeetingId: "current", roomId: "room-1", scopeId: "scope-1" };
  const first = await preparer.prepare({ ...input, question: "What happened?" });
  const second = await preparer.prepare({ ...input, question: "Who decided?" });
  if (first.status !== "prepared" || second.status !== "prepared") {throw new Error("not prepared");}
  const retrieveInput = { ...input, authorizationPrincipalRef: "principal" };
  for (const request of [{ ...first, schemaVersion: 2 },
    { ...first, binding: { ...first.binding, contractVersion: "context-retrieval.v2" } }]) {
    expect(await historical.retrieveEvidence({ ...retrieveInput, request: request as never }))
      .toEqual({ status: "unavailable", reason: "request_not_admitted" });
  }
  expect(retrieve).not.toHaveBeenCalled();
  expect(await historical.retrieveEvidence({ ...retrieveInput,
    request: Object.freeze({ ...first }) })).toEqual({ status: "unavailable", reason: "scope_not_bound" });
  expect(retrieve).not.toHaveBeenCalled();
  const result = await historical.retrieveEvidence({ ...retrieveInput, request: first });
  const changed = await historical.retrieveEvidence({ ...retrieveInput, request: second });
  expect(result.status).toBe("empty");
  expect(changed.status).toBe("empty");
  if (result.status !== "empty" || changed.status !== "empty") {throw new Error("not empty");}
  expect(result.authorityGeneration).toMatch(/^historical-locator-v3:/u);
  expect(changed.authorityGeneration).not.toBe(result.authorityGeneration);
});


it("rehydrates both admitted V3 sources with equal turn IDs and excludes an unadmitted source", async () => {
  const ids = new TestIds();
  const meetings = ["first", "second", "unadmitted"].map((meetingId) => makeMeeting({
    meetingId, turns: [{ turnId: "turn-1", startMs: 0, endMs: 1_000,
      text: `Decision in ${meetingId}.` }],
  }));
  const plans = meetings.map((meeting) => buildHistoricalIndexPlan(meeting, ids));
  const records = meetings.map((meeting, index) => ({ binding: meeting.binding,
    plan: plans[index]!, remoteDocumentIds: {} }));
  const initial = new AppliedStore(records.slice(0, 2), meetings.slice(0, 2));
  const current = new AppliedStore(records, meetings);
  const preparer = new PrepareFocusedLocatorRetrievalV3Request({ ids, store: initial,
    providerBinding: { ...providerBinding, contractVersion: "context-retrieval.v3" }, scopeResolution });
  const input = { currentMeetingId: "different-current-meeting", roomId: "room-1", scopeId: "scope-1" };
  const request = await preparer.prepare({ ...input, question: "What decisions were made?" });
  if (request.status !== "prepared") {throw new Error("not prepared");}
  expect(request.filters.sourceGenerations).toHaveLength(2);
  expect(new Set(request.filters.sourceGenerations.map((pair) => pair.projectionGeneration)).size).toBe(2);
  const historical = new HistoricalFocusedLocatorRetrievalV3({ ids, store: current, scopeResolution,
    authorization: authorization(), turnHashes: { hash: () => "a".repeat(64) },
    retrieval: { retrieve: async (value) => ({ status: "available", candidates:
      plans.map((plan, index) => providerCandidate(plan.documents[0]!.manifest.candidateLocator,
        value, index + 1)) }) },
  });
  const result = await historical.retrieveEvidence({ ...input, request,
    authorizationPrincipalRef: "principal" });
  if (result.status !== "current") {throw new Error(result.status);}
  expect(result.turns.map((turn) => [turn.source?.meetingId, turn.turnId]))
    .toEqual([["first", "turn-1"], ["second", "turn-1"]]);
});

it("rejects a stale admitted source generation even with a correctly hashed provider audit", async () => {
  const { store, plan } = fixture();
  const snapshot = { loadRoomAuthoritySnapshot: async (input: Parameters<typeof store.loadRoomAuthoritySnapshot>[0]) => {
    const result = await store.loadRoomAuthoritySnapshot(input);
    return result.status !== "current" ? result : { ...result, entries: result.entries.map((entry) => ({
      ...entry, plan: { ...entry.plan, topology: { ...entry.plan.topology, indexGeneration: "stale-generation" } },
    })) };
  } };
  const request = await new PrepareFocusedLocatorRetrievalV3Request({ ids: new TestIds(), snapshot,
    scopeResolution, providerBinding: { ...providerBinding, contractVersion: "context-retrieval.v3" },
  }).prepare({ currentMeetingId: "current", question: "What happened?", roomId: "room-1", scopeId: "scope-1" });
  if (request.status !== "prepared") {throw new Error("not prepared");}
  const historical = new HistoricalFocusedLocatorRetrievalV3({ ids: new TestIds(), store,
    scopeResolution, authorization: authorization(), turnHashes: { hash: () => "a".repeat(64) },
    retrieval: { retrieve: async (value) => ({ status: "available", candidates: [
      providerCandidate(plan.documents[0]!.manifest.candidateLocator, value),
    ] }) },
  });
  expect(await historical.retrieveEvidence({ request, authorizationPrincipalRef: "principal",
    currentMeetingId: "current", roomId: "room-1", scopeId: "scope-1" }))
    .toEqual({ status: "unavailable", reason: "canonical_evidence_unavailable" });
});

it.each([{ scopeId: "foreign-scope", roomId: "room-1" },
  { scopeId: "scope-1", roomId: "foreign-room" }])(
  "denies a V3 authority snapshot from another canonical scope %j", async (foreign) => {
    const ids = new TestIds();
    const meeting = makeMeeting({ ...foreign, meetingId: "foreign", turns: [
      { turnId: "turn-1", startMs: 0, endMs: 1000, text: "Foreign decision." },
    ] });
    const plan = buildHistoricalIndexPlan(meeting, ids);
    const store = new AppliedStore([{ binding: meeting.binding, plan, remoteDocumentIds: {} }], [meeting]);
    const snapshot = { loadRoomAuthoritySnapshot: async () => store.loadRoomAuthoritySnapshot({
      ...foreign, maximumSources: 100,
    }) };
    const preparer = new PrepareFocusedLocatorRetrievalV3Request({ ids, snapshot, scopeResolution,
      providerBinding: { ...providerBinding, contractVersion: "context-retrieval.v3" } });
    expect(await preparer.prepare({ currentMeetingId: "current", question: "What changed?",
      scopeId: "scope-1", roomId: "room-1" })).toEqual({
      status: "unavailable", reason: "historical_authority_unavailable",
    });
  });
