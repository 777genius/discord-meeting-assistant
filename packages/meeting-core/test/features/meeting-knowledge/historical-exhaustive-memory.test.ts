import { describe, expect, it } from "vitest";

import {
  HistoricalExhaustiveMemoryRetrieval,
  createHistoricalReleaseBinding,
  type LocallyRehydratedEvidenceBlockV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";

const binding = createHistoricalReleaseBinding({
  acceptedMeetingRevision: 1,
  desiredGeneration: 1,
  meetingId: "meeting-split",
  roomId: "room-1",
  scopeId: "scope-1",
  transcriptId: "transcript-split",
  transcriptVersion: 1,
});

function block(ordinal: number, start: number, end: number): LocallyRehydratedEvidenceBlockV1 {
  return Object.freeze({
    binding,
    candidateLocator: `block-${ordinal}`,
    contentHash: `hash-${ordinal}`,
    indexGeneration: "generation-1",
    ordinal,
    turns: Object.freeze([Object.freeze({
      endMs: 1_000,
      sourceEndCodePoint: end,
      sourceRef: "source-split",
      sourceStartCodePoint: start,
      speakerId: "speaker-1",
      startMs: 0,
      text: `slice-${start}-${end}`,
      turnId: "turn-split",
    })]),
  });
}

describe("historical exhaustive memory exact slice serving", () => {
  it("preserves distinct selected ranges from the same canonical turn", async () => {
    const blocks = [block(0, 0, 5), block(1, 5, 10)];
    const selectedTurns = blocks.map((candidate) => {
      const turn = candidate.turns[0]!;
      return {
        blockLocator: candidate.candidateLocator,
        relevance: "direct" as const,
        sourceEndCodePoint: turn.sourceEndCodePoint,
        sourceRef: turn.sourceRef,
        sourceStartCodePoint: turn.sourceStartCodePoint,
        turnId: turn.turnId,
      };
    });
    const retrieval = new HistoricalExhaustiveMemoryRetrieval({
      buildPlan: async () => ({
        plan: {
          coverageBitmap: [true, true],
          coveragePlanDigest: "coverage-plan-split",
          finalSynthesisAllowed: true,
          reduction: {
            evidenceLocators: blocks.map(({ candidateLocator }) => candidateLocator),
            payload: { selectedTurnCount: 2 },
            selectedTurns,
            selectionStatus: "selected",
            schemaVersion: 1,
          },
          schemaVersion: 1,
          selectedBlocks: blocks,
          strategy: "exhaustive_coverage",
          synthesisRequiresCanonicalRehydration: true,
        },
        status: "ready",
      }),
    }, { hash: ({ text }) => `hash:${text}` });

    const result = await retrieval.retrieve({
      authorizationPrincipalRef: "principal",
      expectedAuthorityGeneration: "authority-1",
      question: "List every split slice",
      requestId: "request-split",
      roomId: "room-1",
      scopeId: "scope-1",
    });

    expect(result.status).toBe("current");
    if (result.status === "current") {
      expect(result.candidates.map(({ sourceEndCodePoint, sourceStartCodePoint }) =>
        [sourceStartCodePoint, sourceEndCodePoint]
      )).toEqual([[0, 5], [5, 10]]);
      expect(result.coverageReduction.selectedCanonicalTurnCount).toBe(2);
    }
  });
});
