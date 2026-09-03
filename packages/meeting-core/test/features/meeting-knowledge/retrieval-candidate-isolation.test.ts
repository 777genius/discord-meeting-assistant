import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  HistoricalFocusedLocatorRetrievalV2,
  PersistedFocusedMemoryRetrievalV2,
  PrepareFocusedLocatorRetrievalV2Request,
  buildHistoricalIndexPlan,
  type FocusedMemoryRetrievalResult,
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

function providerCandidate(locator: string, request: unknown, providerRank = 1) {
  const contributions = Object.freeze([Object.freeze({
    contributionScorePicos: 500_000, providerLaneId: "postgres_keyword",
    providerRank, queryId: "original-question", rawScoreKind: "bm25" as const,
    rawScoreValue: 2.5,
  })]);
  return Object.freeze({
    locator,
    retrievalProvenance: Object.freeze({
      contributions, fusedScore: 0.5,
      laneIdentity: Object.freeze({
        capabilityFingerprint: providerBinding.capabilityFingerprint,
        lane: "historical" as const,
        profileId: providerBinding.profileId,
      }),
      locator, providerRank, requestDigest: digest(request),
      responseDigest: digest({ contributions, fusedScore: 0.5, locator, providerRank }),
    }),
  });
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {return value.map(canonical);}
  if (typeof value !== "object" || value === null) {return value;}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .toSorted(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map(([key, nested]) => [key, canonical(nested)]));
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
  if (request.status !== "prepared") {throw new Error("missing retrieval request");}
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
  it("preserves history for an empty current lane while failing invalid lanes",
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
        .toEqual({ schemaVersion: 1, status: "unavailable" });
      await expect(composite(localCurrent, rejectedLane).retrieve(input)).resolves
        .toEqual({ schemaVersion: 1, status: "unavailable" });
      await expect(composite(rejectedLane, rejectedLane).retrieve(input)).resolves
        .toEqual({ schemaVersion: 1, status: "unavailable" });
      await expect(composite(unavailableLane, unavailableLane).retrieve(input)).resolves
        .toEqual({ schemaVersion: 1, status: "unavailable" });
      await expect(composite(async () => ({
        authorityGeneration: "current-generation", candidates: [],
        schemaVersion: 1, status: "current",
      }), indexedCurrent).retrieve(input)).resolves.toMatchObject({
        authorityGeneration: "current-generation", candidates: [indexed],
        status: "current",
      });
      await expect(composite(async () => ({
        authorityGeneration: "current-generation", schemaVersion: 1, status: "low_coverage",
      }), indexedCurrent).retrieve(input)).resolves.toMatchObject({
        authorityGeneration: "current-generation", candidates: [indexed],
        status: "current",
      });
      await expect(composite(async () => ({
        authorityGeneration: "wrong-generation", schemaVersion: 1, status: "low_coverage",
      }), indexedCurrent).retrieve(input)).resolves
        .toEqual({ schemaVersion: 1, status: "unavailable" });
      await expect(composite(async () => ({
        malformed: true, schemaVersion: 1, status: "low_coverage",
      } as unknown as FocusedMemoryRetrievalResult), indexedCurrent).retrieve(input)).resolves
        .toEqual({ schemaVersion: 1, status: "unavailable" });
      await expect(composite(async () => ({ schemaVersion: 1, status: "stale" }),
        indexedCurrent).retrieve(input)).resolves
        .toEqual({ schemaVersion: 1, status: "stale" });
      await expect(composite(localCurrent, async () => ({
        authorityGeneration: "historical-empty", candidates: [],
        schemaVersion: 1, status: "current",
      })).retrieve(input)).resolves
        .toMatchObject({ candidates: [local], status: "current" });
      await expect(composite(async () => ({
        authorityGeneration: "wrong-generation", candidates: [local],
        schemaVersion: 1, status: "current",
      }), indexedCurrent).retrieve(input)).resolves
        .toEqual({ schemaVersion: 1, status: "unavailable" });
      await expect(composite(async () => ({ schemaVersion: 1, status: "pending" }),
        indexedCurrent).retrieve(input)).resolves
        .toEqual({ schemaVersion: 1, status: "pending" });
      const preAbort = new AbortController();
      preAbort.abort(new Error("pre-abort"));
      let preAbortCalls = 0;
      await expect(composite(async () => { preAbortCalls += 1; return localCurrent(input); }, indexedCurrent)
        .retrieve({ ...input, signal: preAbort.signal })).rejects.toThrow("pre-abort");
      expect(preAbortCalls).toBe(0);
      const hung = new Promise<never>(() => {});
      const cancellation = new AbortController();
      const pending = composite(async () => hung, indexedCurrent).retrieve({ ...input, signal: cancellation.signal });
      cancellation.abort(new Error("hung lane cancelled"));
      await expect(pending).rejects.toThrow("hung lane cancelled");
      const controller = new AbortController();
      controller.abort(new Error("cancelled composite retrieval"));
      await expect(composite(localCurrent, indexedCurrent).retrieve({
        ...input, signal: controller.signal,
      })).rejects.toThrow("cancelled composite retrieval");
    });

  it("composes two complete lanes and lets canonical local identity win deduplication",
    async () => {
      const meeting = makeMeeting({ meetingId: "history", turns: markerTurn("fact") });
      const store = new AppliedStore([{ binding: meeting.binding,
        plan: buildHistoricalIndexPlan(meeting, new TestIds()), remoteDocumentIds: {} }]);
      const request = await requestFor(store);
      const local = Object.freeze({ meetingId: "current-meeting",
        transcriptId: "transcript-current", transcriptVersion: 1,
        turnHash: "a".repeat(64), turnId: "turn-current" });
      const localSecond = Object.freeze({ ...local, turnHash: "c".repeat(64),
        turnId: "turn-current-second" });
      const indexedOnly = Object.freeze({ historicalSource: {
        candidateLocator: "locator-history", indexGeneration: "index-history",
        releaseId: "release-history" }, meetingId: "history-meeting",
      transcriptId: "transcript-history", transcriptVersion: 1,
      turnHash: "b".repeat(64), turnId: "turn-history" });
      const indexedSecond = Object.freeze({ ...indexedOnly,
        historicalSource: { ...indexedOnly.historicalSource,
          candidateLocator: "locator-history-second" },
        turnHash: "d".repeat(64), turnId: "turn-history-second" });
      const rangedLocal = Object.freeze({ ...local,
        historicalSource: { candidateLocator: "range-specific", indexGeneration: "index",
          releaseId: "release" }, sourceEndCodePoint: 4, sourceStartCodePoint: 0 });
      const memory = composite(async () => ({ authorityGeneration: "generation",
        candidates: [local, localSecond], schemaVersion: 1, status: "current" }),
      async () => ({
        authorityGeneration: "historical", candidates: [{ ...local,
          historicalSource: { candidateLocator: "duplicate", indexGeneration: "index",
            releaseId: "release" } }, indexedOnly, rangedLocal, { ...localSecond,
          historicalSource: { candidateLocator: "duplicate-second",
            indexGeneration: "index", releaseId: "release" } }, indexedSecond],
        schemaVersion: 1, status: "current",
      }));
      const result = await memory.retrieve({ authorizationPrincipalRef: "principal",
        canonicalEvidenceHash: "c".repeat(64), expectedAuthorityGeneration: "generation",
        finalProjectionReceipt: "receipt", maximumCandidates: 10,
        meetingId: local.meetingId, meetingRevision: 1, neighborTurns: 0,
        projectionTargetContainerId: "container", question: "What changed?",
        retrievalBinding: { cutoverEpoch: "epoch", profileFingerprint: "d".repeat(64),
          request, retrievalPath: "infinity_locator_v2" }, roomId: "room-1",
        scopeId: "scope-1", transcriptId: local.transcriptId, transcriptVersion: 1 });

      expect(result).toMatchObject({
        candidates: [local, indexedOnly, localSecond, rangedLocal, indexedSecond],
        status: "current",
      });
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
      const store = new AppliedStore(records, [meetings[0]!, meetings[2]!, meetings[3]!]);
      const request = await requestFor(store);
      const locators = records.map(({ plan }) =>
        plan.documents[0]?.manifest.candidateLocator);
      if (locators.some((locator) => locator === undefined)) {
        throw new Error("missing candidate locator");
      }
      const retrieval = { retrieve: async (providerRequest) => {
        const missing = {
          ...providerCandidate("missing-provenance", providerRequest, 5),
        } as { locator: string; retrievalProvenance?: unknown };
        delete missing.retrievalProvenance;
        const malformed = structuredClone(
          providerCandidate("malformed", providerRequest, 6),
        ) as { locator: string; retrievalProvenance: { providerRank: number } };
        malformed.retrievalProvenance.providerRank = 0;
        return { candidates: [
          providerCandidate(locators[0]!, providerRequest, 1),
          providerCandidate("missing", providerRequest, 2),
          providerCandidate(locators[1]!, providerRequest, 3),
          providerCandidate(locators[2]!, providerRequest, 4),
          missing, malformed, providerCandidate(locators[3]!, providerRequest, 7),
        ], status: "available" as const };
      } } as FocusedLocatorRetrievalV2Port;
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
