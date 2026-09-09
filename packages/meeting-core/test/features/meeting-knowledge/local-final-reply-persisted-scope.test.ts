import {
  createHash,
} from "node:crypto";
import {
  AppliedStore,
  TestIds,
  makeMeeting,
} from "../../fixtures/historical-retrieval-fixtures.js";
import {
  scopeResolution,
} from "./focused-locator-retrieval-v2.fixture.test.js";
import {
  describe,
  expect,
  it,
} from "vitest";
import {
  AdmitCurrentFinalReply,
  PrepareFocusedLocatorRetrievalV2Request,
  HistoricalFocusedLocatorRetrievalV2,
  PersistedFocusedMemoryRetrievalV2,
  buildHistoricalIndexPlan,
  buildHistoricalRoomTopology,
  type FocusedLocatorRetrievalV2RequestSnapshot,
  type FocusedMemoryRetrievalResult,
  ProcessFinalReplyJob,
  type QuestionBindingSnapshot,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  authority,
  AuthorizationFake,
  EvidenceFake,
  MemoryFake,
} from "./local-final-reply-application-fixtures.test.js";
import {
  QuestionJobStoreFake,
} from "./question-job-store.fake.test.js";
import {
  retrievalV2Request,
} from "./retrieval-v2-application-fixtures.test.js";
import {
  policy,
  renderer,
  AdmissionFake,
  GeneratorFake,
  PublicationFake,
  focusedSelector,
} from "../../fixtures/local-final-reply-processing-fixtures.js";

const canonical = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonical) : typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, nested]) => [key, canonical(nested)])) : value;
const digest = (value: unknown) => createHash("sha256")
  .update(JSON.stringify(canonical(value))).digest("hex");

describe("persisted final reply scope authority", () => {
  it("serves a serialized admitted lease with fresh worker scope authority and rejects request copies", async () => {
    const ids = new TestIds();
    const meeting = makeMeeting({ meetingId: "historical-meeting", scopeId: authority.scopeId,
      roomId: authority.roomId, turns: [{ turnId: "historical-turn", startMs: 0,
        endMs: 1000, text: "The synthetic release moved to Monday." }] });
    const plan = buildHistoricalIndexPlan(meeting, ids);
    const store = new AppliedStore([{ binding: meeting.binding,
      plan, remoteDocumentIds: {} }], [meeting]);
    const admissions = new AdmissionFake();
    const evidence = new EvidenceFake();
    const authorization = new AuthorizationFake();
    const preparer = new PrepareFocusedLocatorRetrievalV2Request({ ids, store,
      scopeResolution, providerBinding: retrievalV2Request.binding });
    const admission = new AdmitCurrentFinalReply(evidence, authorization, admissions,
      policy, { retrievalV2Admission: preparer });
    const question = "When is the corrected release day?";
    await expect(admission.execute({ authorizationPrincipalRef: "principal:v1:opaque",
      deliveryContainerId: "question-thread-1", finalProjectionReceipt: authority.finalProjectionReceipt,
      projectionTargetContainerId: authority.projectionTargetContainerId,
      questionHash: "c".repeat(64), questionId: "question-1", questionText: question,
      requesterSubject: "d".repeat(64), schemaVersion: 2, scopeId: authority.scopeId,
    })).resolves.toEqual({ jobId: "question-1", status: "accepted" });
    const persistedBytes = JSON.stringify(admissions.commits[0]!.binding);
    const persisted = JSON.parse(persistedBytes) as QuestionBindingSnapshot;
    const jobs = new QuestionJobStoreFake({ answerCandidate: null, attempts: 0,
      binding: persisted, generation: 1, groundingPlan: null, jobId: "question-1",
      questionText: question, state: "running" });
    const topology = buildHistoricalRoomTopology(authority.scopeId, authority.roomId, ids);
    let scopeReads = 0;
    const requests: FocusedLocatorRetrievalV2RequestSnapshot[] = [];
    const historical = new HistoricalFocusedLocatorRetrievalV2({ ids, store,
      authorization: { authorize: async () => ({ authorized: true,
        authorizationDigest: "auth", authorizationEpoch: "epoch", policyVersion: "policy" }) },
      // A new worker has none of the admission resolver's identity bindings.
      scopeResolution: { matches: () => false, resolve: async () => ({ status: "unavailable" }),
        matchesPersisted: async (input) => { scopeReads += 1;
          return input.spaceSlug === topology.spaceSlug &&
            input.roomScopeExternalRef === topology.roomScopeExternalRef &&
            input.request.scope.spaceId === "internal-space-123" &&
            input.request.scope.memoryScopeId === "internal-room-456";
        } },
      retrieval: { retrieve: async (request) => { requests.push(request);
        const locator = plan.documents[0]!.manifest.candidateLocator;
        const contributions = [{ contributionScorePicos: 500_000,
          providerLaneId: "postgres_keyword", providerRank: 1, queryId: "original-question",
          rawScoreKind: "bm25" as const, rawScoreValue: 2.5 }];
        return { status: "available", candidates: [{ locator,
          retrievalProvenance: { contributions, fusedScore: 0.5, locator, providerRank: 1,
            laneIdentity: { lane: "historical", profileId: request.binding.profileId,
              capabilityFingerprint: request.binding.capabilityFingerprint },
            requestDigest: digest(request), responseDigest: digest({ contributions,
              fusedScore: 0.5, locator, providerRank: 1 }) } }] }; } },
      turnHashes: { hash: () => "a".repeat(64) },
    });
    const composite = new PersistedFocusedMemoryRetrievalV2({ current: new MemoryFake(), historical });
    const retrieved: FocusedMemoryRetrievalResult[] = [];
    const processor = new ProcessFinalReplyJob({ answerPublication: new PublicationFake(),
      authorization, evidence, generator: new GeneratorFake(), jobs,
      memory: { reauthorizeHistoricalEvidence: (input) => composite.reauthorizeHistoricalEvidence(input),
        retrieve: async (input) => {
        const result = await composite.retrieve(input);
        retrieved.push(result);
        return result;
      } },
      policy, selector: focusedSelector(), renderer, workerId: "restarted-worker" });
    await processor.executeOnce();
    expect(scopeReads).toBe(1);
    expect(requests).toHaveLength(1);
    expect(retrieved[0]?.status).toBe("current");
    const completedRetrieval = retrieved[0];
    if (completedRetrieval?.status !== "current") { throw new Error("worker retrieval failed"); }
    expect(completedRetrieval.candidates.some((candidate) =>
      candidate.meetingId === meeting.binding.meetingId && candidate.turnId === "historical-turn"))
      .toBe(true);
    expect(persisted.retrievalBinding?.retrievalPath).toBe("infinity_locator_v2");
    if (persisted.retrievalBinding?.retrievalPath !== "infinity_locator_v2") {
      throw new Error("missing persisted request");
    }
    expect(requests[0]).not.toBe(persisted.retrievalBinding.request);
    expect(JSON.stringify(requests[0])).toBe(JSON.stringify(persisted.retrievalBinding.request));
    expect(JSON.stringify(persisted)).toBe(persistedBytes);
    const base = { authorizationPrincipalRef: "principal:v1:opaque",
      currentMeetingId: authority.meetingId, roomId: authority.roomId, scopeId: authority.scopeId };
    await expect(historical.retrieveEvidence({ ...base,
      request: Object.freeze({ ...requests[0]! }) })).resolves.toEqual({
        status: "unavailable", reason: "scope_not_bound" });
    await expect(historical.retrieveEvidence({ ...base, scopeId: "another-guild",
      request: requests[0]! })).resolves.toEqual({ status: "unavailable", reason: "scope_not_bound" });
    await expect(historical.retrieveEvidence({ ...base, request: Object.freeze({ ...requests[0]!,
      scope: Object.freeze({ ...requests[0]!.scope, memoryScopeId: "other-room" }) }) }))
      .resolves.toEqual({ status: "unavailable", reason: "scope_not_bound" });
    expect(scopeReads).toBe(1);
    expect(requests).toHaveLength(1);
    const hydrated = await historical.retrieveEvidence({ ...base, request: requests[0]! });
    expect(hydrated.status).toBe("current");
    if (hydrated.status !== "current") { throw new Error("historical hydration failed"); }
    expect(hydrated.turns.map(({ text }) => text))
      .toEqual(["The synthetic release moved to Monday."]);
    expect(scopeReads).toBe(2);
    expect(requests).toHaveLength(2);
    const wrongInternalScope: QuestionBindingSnapshot = { ...persisted,
      retrievalBinding: { ...persisted.retrievalBinding, request: {
        ...persisted.retrievalBinding.request, scope: {
          ...persisted.retrievalBinding.request.scope, memoryScopeId: "other-room" } } } };
    const leaseFor = (snapshot: QuestionBindingSnapshot) => ({ answerCandidate: null,
      attempts: 0, binding: snapshot, generation: 2, groundingPlan: null,
      jobId: "question-1", questionText: question, state: "running" as const });
    jobs.lease = leaseFor(wrongInternalScope);
    await processor.executeOnce();
    expect(scopeReads).toBe(3);
    expect(requests).toHaveLength(2);
    jobs.lease = leaseFor({ ...persisted, scopeId: "another-guild" });
    await processor.executeOnce();
    expect(scopeReads).toBe(3);
    expect(requests).toHaveLength(2);
    authorization.denyAt = "before_retrieval";
    jobs.lease = leaseFor(persisted);
    await processor.executeOnce();
    expect(scopeReads).toBe(3);
    expect(requests).toHaveLength(2);
  });

});
