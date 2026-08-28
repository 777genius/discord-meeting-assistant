import { describe, expect, it } from "vitest";

import {
  HistoricalFocusedLocatorRetrievalV2,
  PersistedFocusedMemoryRetrievalV2,
  PrepareFocusedLocatorRetrievalV2Request,
  buildHistoricalIndexPlan,
  type FocusedLocatorRetrievalV2Port,
  type FocusedMemoryRetrievalPort,
  type HistoricalAuthorizationPort,
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

function providerCandidate(locator: string, providerRank = 1) {
  return Object.freeze({
    locator,
    retrievalProvenance: Object.freeze({
      contributions: Object.freeze([Object.freeze({
        contributionScorePicos: 500_000, providerLaneId: "postgres_keyword",
        providerRank, queryId: "original-question", rawScoreKind: "bm25" as const,
        rawScoreValue: 2.5,
      })]),
      fusedScore: 0.5, providerRank,
    }),
  });
}

function markerTurn(marker: string) {
  return [{ endMs: 1_000, speakerId: "speaker", startMs: 0, text: marker,
    turnId: `turn-${marker}` }];
}

function authorization(): HistoricalAuthorizationPort {
  return { authorize: async () => ({
    authorizationDigest: "authorization-1",
    authorizationEpoch: "epoch-1",
    authorized: true,
    policyVersion: "room-policy.v1",
  }) };
}

async function requestFor(store: AppliedStore) {
  const request = await new PrepareFocusedLocatorRetrievalV2Request({
    ids: new TestIds(), providerBinding, store,
  }).prepare({ currentMeetingId: "current-meeting", question: "What changed?",
    roomId: "room-1", scopeId: "scope-1" });
  if (request === null) {throw new Error("missing retrieval request");}
  return request;
}

function rejectedLane(): Promise<never> {
  return Promise.reject(new Error("lane unavailable"));
}

function unavailableLane() {
  return Promise.resolve({ schemaVersion: 1 as const, status: "unavailable" as const });
}

function composite(
  current: FocusedMemoryRetrievalPort["retrieve"],
  historical: FocusedMemoryRetrievalPort["retrieve"],
) {
  return new PersistedFocusedMemoryRetrievalV2({
    current: { retrieve: current },
    historical: { retrieve: historical, reauthorizeRoom: async () => true } as
      unknown as HistoricalFocusedLocatorRetrievalV2,
  });
}

describe("focused retrieval candidate and lane isolation", () => {
  it("keeps either settled source lane and returns unavailable only when both fail",
    async () => {
      const meeting = makeMeeting({ meetingId: "history", turns: markerTurn("fact") });
      const store = new AppliedStore([{ binding: meeting.binding,
        plan: buildHistoricalIndexPlan(meeting, new TestIds()), remoteDocumentIds: {} }]);
      const request = await requestFor(store);
      const local = Object.freeze({ meetingId: "current-meeting",
        transcriptId: "transcript-current", transcriptVersion: 1,
        turnHash: "a".repeat(64), turnId: "turn-local" });
      const indexed = Object.freeze({ historicalSource: {
        candidateLocator: "locator-history", indexGeneration: "index-history",
        releaseId: "release-history" }, meetingId: "history-meeting",
      transcriptId: "transcript-history", transcriptVersion: 1,
      turnHash: "b".repeat(64), turnId: "turn-indexed" });
      const input = { authorizationPrincipalRef: "principal",
        canonicalEvidenceHash: "c".repeat(64),
        expectedAuthorityGeneration: "current-generation",
        finalProjectionReceipt: "receipt", maximumCandidates: 10,
        meetingId: local.meetingId, meetingRevision: 1, neighborTurns: 0,
        projectionTargetContainerId: "container", question: "What changed?",
        retrievalBinding: { cutoverEpoch: "epoch", profileFingerprint: "d".repeat(64),
          request, retrievalPath: "infinity_locator_v2" as const }, roomId: "room-1",
        scopeId: "scope-1", transcriptId: local.transcriptId, transcriptVersion: 1 };
      const localCurrent: FocusedMemoryRetrievalPort["retrieve"] = async () => ({
        authorityGeneration: "current-generation", candidates: [local],
        schemaVersion: 1, status: "current",
      });
      const indexedCurrent: FocusedMemoryRetrievalPort["retrieve"] = async () => ({
        authorityGeneration: "indexed-generation", candidates: [indexed],
        schemaVersion: 1, status: "current",
      });

      await expect(composite(rejectedLane, indexedCurrent).retrieve(input)).resolves
        .toMatchObject({ candidates: [indexed], status: "current" });
      await expect(composite(localCurrent, rejectedLane).retrieve(input)).resolves
        .toMatchObject({ candidates: [local], status: "current" });
      await expect(composite(rejectedLane, rejectedLane).retrieve(input)).resolves
        .toEqual({ schemaVersion: 1, status: "unavailable" });
      await expect(composite(unavailableLane, unavailableLane).retrieve(input)).resolves
        .toEqual({ schemaVersion: 1, status: "unavailable" });
      await expect(composite(async () => ({ schemaVersion: 1, status: "stale" }),
        indexedCurrent).retrieve(input)).resolves
        .toEqual({ schemaVersion: 1, status: "stale" });
      const controller = new AbortController();
      controller.abort(new Error("cancelled composite retrieval"));
      await expect(composite(localCurrent, indexedCurrent).retrieve({
        ...input, signal: controller.signal,
      })).rejects.toThrow("cancelled composite retrieval");
    });

  it("composes partial lanes and lets canonical local identity win deduplication",
    async () => {
      const meeting = makeMeeting({ meetingId: "history", turns: markerTurn("fact") });
      const store = new AppliedStore([{ binding: meeting.binding,
        plan: buildHistoricalIndexPlan(meeting, new TestIds()), remoteDocumentIds: {} }]);
      const request = await requestFor(store);
      const local = Object.freeze({ meetingId: "current-meeting",
        transcriptId: "transcript-current", transcriptVersion: 1,
        turnHash: "a".repeat(64), turnId: "turn-current" });
      const indexedOnly = Object.freeze({ historicalSource: {
        candidateLocator: "locator-history", indexGeneration: "index-history",
        releaseId: "release-history" }, meetingId: "history-meeting",
      transcriptId: "transcript-history", transcriptVersion: 1,
      turnHash: "b".repeat(64), turnId: "turn-history" });
      const memory = composite(async () => ({ authorityGeneration: "generation",
        candidates: [local], schemaVersion: 1, status: "current" }), async () => ({
        authorityGeneration: "historical", candidates: [{ ...local,
          historicalSource: { candidateLocator: "duplicate", indexGeneration: "index",
            releaseId: "release" } }, indexedOnly], schemaVersion: 1, status: "current",
      }));
      const result = await memory.retrieve({ authorizationPrincipalRef: "principal",
        canonicalEvidenceHash: "c".repeat(64), expectedAuthorityGeneration: "generation",
        finalProjectionReceipt: "receipt", maximumCandidates: 10,
        meetingId: local.meetingId, meetingRevision: 1, neighborTurns: 0,
        projectionTargetContainerId: "container", question: "What changed?",
        retrievalBinding: { cutoverEpoch: "epoch", profileFingerprint: "d".repeat(64),
          request, retrievalPath: "infinity_locator_v2" }, roomId: "room-1",
        scopeId: "scope-1", transcriptId: local.transcriptId, transcriptVersion: 1 });

      expect(result).toMatchObject({ candidates: [local, indexedOnly], status: "current" });
    });

  it("isolates stale, missing, oversized, and bad-provenance candidates in order",
    async () => {
      const meetings = [
        makeMeeting({ meetingId: "valid-a", turns: markerTurn("alpha fact") }),
        makeMeeting({ meetingId: "stale", turns: markerTurn("stale fact") }),
        makeMeeting({ meetingId: "oversized", turns: markerTurn("x".repeat(100)) }),
        makeMeeting({ meetingId: "valid-b", turns: markerTurn("beta fact") }),
      ];
      const records = meetings.map((meeting) => ({ binding: meeting.binding,
        plan: buildHistoricalIndexPlan(meeting, new TestIds()), remoteDocumentIds: {} }));
      const store = new AppliedStore(records);
      const request = await requestFor(store);
      const locators = records.map(({ plan }) =>
        plan.documents[0]?.manifest.candidateLocator);
      if (locators.some((locator) => locator === undefined)) {
        throw new Error("missing candidate locator");
      }
      store.currentSequence = [true, false, true, true];
      const missing = { ...providerCandidate("missing-provenance", 5) } as
        { locator: string; retrievalProvenance?: unknown };
      delete missing.retrievalProvenance;
      const malformed = structuredClone(providerCandidate("malformed", 6)) as
        { locator: string; retrievalProvenance: { providerRank: number } };
      malformed.retrievalProvenance.providerRank = 0;
      const retrieval = { retrieve: async () => ({ candidates: [
        providerCandidate(locators[0]!, 1), providerCandidate("missing", 2),
        providerCandidate(locators[1]!, 3), providerCandidate(locators[2]!, 4),
        missing, malformed, providerCandidate(locators[3]!, 7),
      ], status: "available" }) } as FocusedLocatorRetrievalV2Port;
      const result = await new HistoricalFocusedLocatorRetrievalV2({
        authority: { loadAcceptedFinalMeeting: async (binding) =>
          meetings.find((meeting) => meeting.binding.releaseId === binding.releaseId) ?? null },
        authorization: authorization(), ids: new TestIds(), retrieval, store,
        turnHashes: { hash: ({ turnId }) => `hash:${turnId}` },
      }).retrieve({ authorizationPrincipalRef: "principal",
        currentMeetingId: "current-meeting", request: { ...request,
          budgets: { ...request.budgets, evidenceByteLimit: 32 } }, roomId: "room-1",
        scopeId: "scope-1" });

      expect(result).toMatchObject({ status: "current" });
      if (result.status === "current") {
        expect(result.candidates.map(({ meetingId }) => meetingId))
          .toEqual(["valid-a", "valid-b"]);
        expect(result.candidates.map(({ retrievalAudit }) => retrievalAudit?.providerRank))
          .toEqual([1, 7]);
        expect(JSON.stringify(result)).not.toContain('"text"');
      }
    });
});
