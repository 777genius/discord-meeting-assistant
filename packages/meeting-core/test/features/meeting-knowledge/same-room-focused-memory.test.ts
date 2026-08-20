import { describe, expect, it } from "vitest";

import {
  SameRoomFocusedMemoryRetrieval,
  buildHistoricalIndexPlan,
  rehydrateHistoricalBlock,
  type FocusedMemoryReference,
  type FocusedMemoryRetrievalPort,
  type LocallyRehydratedEvidenceBlockV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";

import {
  TestIds,
  blockPolicy,
  makeMeeting,
} from "./historical-retrieval-fixtures.js";

function historicalBlock(
  meetingId: string,
  text: string,
): LocallyRehydratedEvidenceBlockV1 {
  const meeting = makeMeeting({
    meetingId,
    turns: [{ endMs: 1_000, startMs: 0, text, turnId: `${meetingId}-turn` }],
  });
  const ids = new TestIds();
  const plan = buildHistoricalIndexPlan(meeting, ids, blockPolicy);
  return rehydrateHistoricalBlock(meeting, plan, 0, ids, blockPolicy);
}

function currentCandidate(index: number, relevanceScore?: number) {
  return {
    meetingId: "meeting-current",
    ...(relevanceScore === undefined ? {} : { relevanceScore }),
    transcriptId: "transcript-current",
    transcriptVersion: 1,
    turnHash: `current-hash-${index}`,
    turnId: `current-${index}`,
  };
}

function retrievalRequest(maximumCandidates = 4) {
  return {
    authorizationPrincipalRef: "principal",
    canonicalEvidenceHash: "a".repeat(64),
    expectedAuthorityGeneration: "authority-1",
    finalProjectionReceipt: "receipt-1",
    maximumCandidates,
    meetingId: "meeting-current",
    meetingRevision: 1,
    neighborTurns: 1,
    projectionTargetContainerId: "container-1",
    question: "What was decided about cedar?",
    roomId: "room-1",
    scopeId: "scope-1",
    transcriptId: "transcript-current",
    transcriptVersion: 1,
  } as const;
}

function sameRoom(input: {
  readonly blocks: readonly LocallyRehydratedEvidenceBlockV1[];
  readonly current: FocusedMemoryRetrievalPort;
  readonly scores: readonly number[];
  readonly sourceSets?: string[];
}) {
  return new SameRoomFocusedMemoryRetrieval({
    current: input.current,
    historical: {
      buildPlan: async (request) => {
        input.sourceSets?.push(request.sourceSet);
        return {
          plan: {
            blocks: input.blocks,
            completenessClaim: false,
            evidenceLocators: input.blocks.map(({ candidateLocator }) =>
              candidateLocator
            ),
            queries: ["cedar"],
            retrievalSource: "local_fallback" as const,
            schemaVersion: 1 as const,
            selection: "locally_rehydrated_focused_blocks_only" as const,
            sources: input.blocks.map((block, index) => ({
              kind: "historical" as const,
              locator: block.candidateLocator,
              providerRank: null,
              providerScore: null,
              qualifiedScore: input.scores[index] ?? 0,
            })),
            strategy: "focused_retrieval" as const,
          },
          status: "ready" as const,
        };
      },
      reauthorizeRoom: async () => true,
    },
    turnHashes: { hash: (turn) => `historical-hash-${turn.turnId}` },
  }, {
    historicalServingAuthorized: true,
    remoteSearchAvailable: true,
  });
}

describe("same-room focused memory merge", () => {
  it("answers a historical-only match when current recall is low", async () => {
    const block = historicalBlock(
      "meeting-historical-only",
      "cedar was approved in the earlier meeting",
    );
    const sourceSets: string[] = [];
    const result = await sameRoom({
      blocks: [block],
      current: { retrieve: async () => ({
        schemaVersion: 1,
        status: "low_coverage",
      }) },
      scores: [1],
      sourceSets,
    }).retrieve(retrievalRequest());

    expect(result).toMatchObject({
      authorityGeneration: "authority-1",
      candidates: [{ meetingId: "meeting-historical-only", relevanceScore: 1 }],
      status: "current",
    });
    expect(sourceSets).toEqual(["historical"]);
  });

  it("reserves current evidence when historical recall is dense", async () => {
    const base = historicalBlock(
      "meeting-historical",
      "cedar historical evidence",
    );
    const seed = base.turns[0];
    if (seed === undefined) {
      throw new Error("historical fixture turn missing");
    }
    const dense = Object.freeze({
      ...base,
      turns: Object.freeze(Array.from({ length: 8 }, (_, index) =>
        Object.freeze({
          ...seed,
          endMs: (index + 1) * 1_000,
          startMs: index * 1_000,
          turnId: `historical-${index}`,
        })
      )),
    });
    const current: FocusedMemoryReference[] = Array.from(
      { length: 4 },
      (_, index) => currentCandidate(index),
    );
    const result = await sameRoom({
      blocks: [dense],
      current: { retrieve: async () => ({
        authorityGeneration: "authority-1",
        candidates: current,
        schemaVersion: 1,
        status: "current",
      }) },
      scores: [1],
    }).retrieve(retrievalRequest());

    expect(result.status).toBe("current");
    if (result.status === "current") {
      expect(result.candidates).toHaveLength(4);
      expect(result.candidates[0]).toEqual(current[0]);
      expect(result.candidates.some(({ meetingId }) =>
        meetingId === "meeting-historical"
      )).toBe(true);
    }
  });

  it("reserves historical evidence when current recall fills the candidate cap", async () => {
    const historical = historicalBlock(
      "meeting-historical-low-score",
      "cedar historical correction",
    );
    const current: FocusedMemoryReference[] = Array.from(
      { length: 40 },
      (_, index) => currentCandidate(index, 1 - index / 100),
    );
    const result = await sameRoom({
      blocks: [historical],
      current: { retrieve: async () => ({
        authorityGeneration: "authority-1",
        candidates: current,
        schemaVersion: 1,
        status: "current",
      }) },
      scores: [0.2],
    }).retrieve(retrievalRequest(40));

    expect(result.status).toBe("current");
    if (result.status === "current") {
      expect(result.candidates).toHaveLength(40);
      expect(result.candidates[0]).toEqual(current[0]);
      expect(result.candidates[1]?.meetingId).toBe(
        "meeting-historical-low-score",
      );
    }
  });

  it("decays turns in one block so other evidence survives top-k", async () => {
    const baseDense = historicalBlock("meeting-dense", "dense cedar evidence");
    const separate = historicalBlock(
      "meeting-separate",
      "separate cedar evidence",
    );
    const seed = baseDense.turns[0];
    if (seed === undefined) {
      throw new Error("dense fixture turn missing");
    }
    const dense = Object.freeze({
      ...baseDense,
      turns: Object.freeze([seed, Object.freeze({
        ...seed,
        endMs: 2_000,
        startMs: 1_000,
        turnId: "dense-2",
      }), Object.freeze({
        ...seed,
        endMs: 3_000,
        startMs: 2_000,
        turnId: "dense-3",
      })]),
    });
    const current = [currentCandidate(1, 0.9), currentCandidate(2, 0.8)];
    const result = await sameRoom({
      blocks: [dense, separate],
      current: { retrieve: async () => ({
        authorityGeneration: "authority-1",
        candidates: current,
        schemaVersion: 1,
        status: "current",
      }) },
      scores: [1, 0.95],
    }).retrieve(retrievalRequest());

    expect(result.status).toBe("current");
    if (result.status === "current") {
      expect(result.candidates.map(({ turnId }) => turnId)).toEqual([
        "current-1",
        "meeting-dense-turn",
        "meeting-separate-turn",
        "current-2",
      ]);
    }
  });
});
