import { describe, expect, it, vi } from "vitest";

import {
  HistoricalFocusedLocatorRetrievalV2,
  PrepareFocusedLocatorRetrievalV2Request,
  buildHistoricalIndexPlan,
  type FocusedLocatorRetrievalV2Port,
  type HistoricalAuthorizationPort,
  type HistoricalEvidenceAuthority,
  type HistoricalOpaqueIdPort,
} from "@discord-meeting/meeting-core/meeting-knowledge";

import { AppliedStore, TestIds, makeMeeting } from
  "../../fixtures/historical-retrieval-fixtures.js";

const providerBinding = Object.freeze({
  capabilityFingerprint: "3".repeat(64),
  contractVersion: "context-retrieval.v2" as const,
  indexProfileDigest: "2".repeat(64),
  profileId: "locator-v2-qualified-profile",
  rankingPolicy: "weighted_rrf_canonical_preferences.v1" as const,
  requiredProviderLanes: Object.freeze(["postgres_keyword", "qdrant_dense"]),
  serviceRevision: "4".repeat(40),
});

function markerTurn(marker: string) {
  return [{
    endMs: 1_000,
    speakerId: "speaker",
    startMs: 0,
    text: marker,
    turnId: `turn-${marker}`,
  }];
}

function fixture() {
  const meeting = makeMeeting({ meetingId: "historical-meeting", turns: [{
    endMs: 430_000,
    speakerId: "opaque-vlad",
    startMs: 420_000,
    text: "Влад approved the launch on Tuesday",
    turnId: "turn-vlad",
  }] });
  const plan = buildHistoricalIndexPlan(meeting, new TestIds());
  const store = new AppliedStore([{ binding: meeting.binding, plan,
    remoteDocumentIds: {} }]);
  const prepare = new PrepareFocusedLocatorRetrievalV2Request({
    ids: new TestIds(),
    providerBinding,
    speakerAliases: { "opaque-vlad": ["Влад", "Vlad"] },
    store,
  });
  return { meeting, plan, prepare, store };
}

describe("persisted focused locator Retrieval V2 request", () => {
  it("orders base64url-like source identities by UTF-8 bytes", async () => {
    const identities = ["A", "a", "_", "-"];
    expect(identities.toSorted((left, right) => left.localeCompare(right)))
      .not.toEqual(identities.toSorted());
    const ids: HistoricalOpaqueIdPort = {
      keyedId: (namespace, parts) => namespace === "historical-release"
        ? (parts[2] ?? "missing")
        : new TestIds().keyedId(namespace, parts),
    };
    const records = identities.map((meetingId) => {
      const meeting = makeMeeting({ meetingId, turns: markerTurn(meetingId) });
      return { binding: meeting.binding, plan: buildHistoricalIndexPlan(meeting, ids),
        remoteDocumentIds: {} };
    });
    const request = await new PrepareFocusedLocatorRetrievalV2Request({
      ids, providerBinding, store: new AppliedStore(records),
    }).prepare({ currentMeetingId: "current-meeting", question: "What changed?",
      roomId: "room-1", scopeId: "scope-1" });

    expect(request?.filters.sourceGenerations.map(({ sourceKey }) => sourceKey))
      .toEqual(["-", "A", "_", "a"].map((identity) => `mkrelease1.${identity}`));
  });

  it.each([100, 101])(
    "admits exactly 100 historical sources and rejects %i when the current meeting is loaded",
    async (historicalCount) => {
      const meetings = [makeMeeting({
        meetingId: "current-meeting",
        turns: markerTurn("current-meeting"),
      }),
        ...Array.from({ length: historicalCount }, (_, index) =>
          makeMeeting({
            meetingId: `historical-${String(index).padStart(3, "0")}`,
            turns: markerTurn(`historical-${String(index).padStart(3, "0")}`),
          }))];
      const records = meetings.map((meeting) => ({ binding: meeting.binding,
        plan: buildHistoricalIndexPlan(meeting, new TestIds()), remoteDocumentIds: {} }));
      const request = await new PrepareFocusedLocatorRetrievalV2Request({
        ids: new TestIds(), providerBinding, store: new AppliedStore(records),
      }).prepare({ currentMeetingId: "current-meeting", question: "What changed?",
        roomId: "room-1", scopeId: "scope-1" });

      if (historicalCount === 100) {
        expect(request?.filters.sourceGenerations).toHaveLength(100);
      } else {
        expect(request).toBeNull();
      }
    },
  );

  it.each([
    "Что Влад решил с 07:00 до 08:00?",
    "What did Vlad decide between 07:00 and 08:00?",
    "Что Vlad decided с 07:00 до 08:00?",
  ])("maps exact scope, source generation, canonical speaker and time for %s",
    async (question) => {
      const { plan, prepare } = fixture();
      const request = await prepare.prepare({
        currentMeetingId: "current-meeting",
        question,
        roomId: "room-1",
        scopeId: "scope-1",
      });
      expect(request).not.toBeNull();
      expect(request?.queries[0]?.query).toBe(question);
      expect(request?.filters.actorKeys).toEqual(["opaque-vlad"]);
      expect(request?.filters.relativeTimeInterval).toEqual({
        endMs: 480_000,
        startMs: 420_000,
      });
      expect(request?.filters.sourceGenerations).toEqual([{
        projectionGeneration: plan.topology.indexGeneration,
        sourceKey: plan.topology.releaseRef,
      }]);
      expect(request?.scope).toMatchObject({
        memoryScopeId: plan.topology.roomScopeExternalRef,
        spaceId: plan.topology.spaceSlug,
        threadId: null,
      });
      expect(request?.budgets).toMatchObject({
        evidenceByteLimit: 24_000,
        neighborRadius: 0,
        resultLimit: 8,
      });
    });

  it("returns only canonical local references in provider order", async () => {
    const { meeting, plan, prepare, store } = fixture();
    const request = await prepare.prepare({
      currentMeetingId: "current-meeting",
      question: "Что Влад решил?",
      roomId: "room-1",
      scopeId: "scope-1",
    });
    if (request === null) {
      throw new Error("missing prepared request");
    }
    const locator = plan.documents[0]?.manifest.candidateLocator;
    if (locator === undefined) {
      throw new Error("missing locator");
    }
    const retrieval: FocusedLocatorRetrievalV2Port = {
      retrieve: vi.fn().mockResolvedValue({
        candidates: [{ locator, providerRank: 1, providerScore: 0.9 }],
        status: "available",
      }),
    };
    const useCase = new HistoricalFocusedLocatorRetrievalV2({
      authority: authority(meeting), authorization: authorization(), ids: new TestIds(),
      retrieval, store, turnHashes: { hash: ({ turnId }) => `hash:${turnId}` },
    });
    const result = await useCase.retrieve({
      authorizationPrincipalRef: "principal",
      currentMeetingId: "current-meeting",
      request,
      roomId: "room-1",
      scopeId: "scope-1",
    });
    expect(result).toMatchObject({ status: "current" });
    if (result.status !== "current") {
      throw new Error("retrieval failed");
    }
    expect(result.candidates).toEqual([expect.objectContaining({
      meetingId: meeting.binding.meetingId,
      transcriptId: meeting.binding.transcriptId,
      turnHash: "hash:turn-vlad",
      turnId: "turn-vlad",
    })]);
    expect(JSON.stringify(result)).not.toMatch(/approved|Tuesday/u);
  });

  it.each([
    ["meetingId", "provider-owned-meeting"],
    ["turnId", "provider-owned-turn"],
    ["text", "remote transcript text"],
  ])("rejects extra provider candidate field %s", async (field, value) => {
    const { meeting, plan, prepare, store } = fixture();
    const request = await prepare.prepare({
      currentMeetingId: "current-meeting",
      question: "What did Vlad decide?",
      roomId: "room-1",
      scopeId: "scope-1",
    });
    const locator = plan.documents[0]?.manifest.candidateLocator;
    if (request === null || locator === undefined) {
      throw new Error("missing Retrieval V2 fixture");
    }
    const result = await new HistoricalFocusedLocatorRetrievalV2({
      authority: authority(meeting), authorization: authorization(), ids: new TestIds(),
      retrieval: { retrieve: async () => ({
        candidates: [{ locator, providerRank: 1, providerScore: 0.9, [field]: value }],
        status: "available",
      }) },
      store,
      turnHashes: { hash: ({ turnId }) => `hash:${turnId}` },
    }).retrieve({ authorizationPrincipalRef: "principal",
      currentMeetingId: "current-meeting", request, roomId: "room-1",
      scopeId: "scope-1" });

    expect(result).toMatchObject({ status: "unavailable" });
  });

  it("rejects duplicate local ownership hidden by locator map construction", async () => {
    const { meeting, plan, prepare } = fixture();
    const request = await prepare.prepare({ currentMeetingId: "current-meeting",
      question: "What did Vlad decide?", roomId: "room-1", scopeId: "scope-1" });
    const locator = plan.documents[0]?.manifest.candidateLocator;
    if (request === null || locator === undefined) {
      throw new Error("missing Retrieval V2 fixture");
    }
    const duplicatedStore = new AppliedStore([
      { binding: meeting.binding, plan, remoteDocumentIds: {} },
      { binding: meeting.binding, plan, remoteDocumentIds: {} },
    ]);
    const result = await new HistoricalFocusedLocatorRetrievalV2({
      authority: authority(meeting), authorization: authorization(), ids: new TestIds(),
      retrieval: { retrieve: async () => ({
        candidates: [{ locator, providerRank: 1, providerScore: 0.9 }],
        status: "available",
      }) },
      store: duplicatedStore,
      turnHashes: { hash: ({ turnId }) => `hash:${turnId}` },
    }).retrieve({ authorizationPrincipalRef: "principal",
      currentMeetingId: "current-meeting", request, roomId: "room-1",
      scopeId: "scope-1" });

    expect(result).toMatchObject({ status: "unavailable" });
  });

  it("fails closed for foreign, stale, oversized, cancelled, or permission-lost evidence",
    async () => {
      const { meeting, plan, prepare, store } = fixture();
      const base = await prepare.prepare({ currentMeetingId: "current-meeting",
        question: "What did Vlad decide?", roomId: "room-1", scopeId: "scope-1" });
      if (base === null) {
        throw new Error("missing request");
      }
      const locator = plan.documents[0]?.manifest.candidateLocator;
      if (locator === undefined) {
        throw new Error("missing locator");
      }
      const run = async (candidateLocator: string, authorized: HistoricalAuthorizationPort,
        request = base) => await new HistoricalFocusedLocatorRetrievalV2({
          authority: authority(meeting), authorization: authorized, ids: new TestIds(),
          retrieval: { retrieve: async (_request, options) => {
            options?.signal?.throwIfAborted();
            return { candidates: [{ locator: candidateLocator, providerRank: 1,
              providerScore: 0.9 }], status: "available" };
          } },
          store,
          turnHashes: { hash: ({ turnId }) => `hash:${turnId}` },
        }).retrieve({ authorizationPrincipalRef: "principal",
          currentMeetingId: "current-meeting", request, roomId: "room-1",
          scopeId: "scope-1" });

      await expect(run("foreign-locator", authorization())).resolves
        .toMatchObject({ status: "unavailable" });
      store.current = false;
      await expect(run(locator, authorization())).resolves
        .toMatchObject({ status: "unavailable" });
      store.current = true;
      await expect(run(locator, authorization([true, false]))).resolves
        .toMatchObject({ status: "unavailable" });
      await expect(run(locator, authorization(), {
        ...base,
        budgets: { ...base.budgets, evidenceByteLimit: 1 },
      })).resolves.toMatchObject({ status: "unavailable" });
      const controller = new AbortController();
      controller.abort(new Error("cancelled"));
      await expect(new HistoricalFocusedLocatorRetrievalV2({
        authority: authority(meeting), authorization: authorization(), ids: new TestIds(),
        retrieval: { retrieve: async (_request, options) => {
          options?.signal?.throwIfAborted();
          return { candidates: [], status: "available" };
        } }, store, turnHashes: { hash: () => "hash" },
      }).retrieve({ authorizationPrincipalRef: "principal",
        currentMeetingId: "current-meeting", request: base, roomId: "room-1",
        scopeId: "scope-1", signal: controller.signal })).rejects.toThrow("cancelled");
    });
});

function authority(meeting: ReturnType<typeof makeMeeting>): HistoricalEvidenceAuthority {
  return { loadAcceptedFinalMeeting: async (binding) =>
    binding.releaseId === meeting.binding.releaseId ? meeting : null };
}

function authorization(sequence: boolean[] = [true, true]): HistoricalAuthorizationPort {
  return { authorize: async () => {
    const authorized = sequence.shift() ?? false;
    return { authorizationDigest: "authorization-1", authorizationEpoch: "epoch-1",
      authorized, policyVersion: "room-policy.v1" };
  } };
}
