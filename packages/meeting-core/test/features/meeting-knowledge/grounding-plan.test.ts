import { describe, expect, it } from "vitest";

import {
  MeetingKnowledgeInvariantError,
  admitGroundingRequest,
  createExhaustiveCoverageGroundingPlan,
  createFocusedRetrievalGroundingPlan,
  focusedMemoryGeneration,
  type RehydratedEvidenceTurn,
} from "@discord-meeting/meeting-core/meeting-knowledge";

function turn(
  index: number,
  text = `Evidence at position ${index}`,
  speakerId = index % 2 === 0 ? "speaker-a" : "speaker-b",
): RehydratedEvidenceTurn {
  const startMs = index * 10_000;
  return {
    endMs: startMs + 2_000,
    speakerId,
    startMs,
    text,
    turnHash: index.toString(16).padStart(64, "0"),
    turnId: `turn-${String(index).padStart(4, "0")}`,
  };
}

describe("Meeting Knowledge GroundingPlan", () => {
  it("builds only a bounded, locally rehydrated focused selection", () => {
    const plan = createFocusedRetrievalGroundingPlan({
      authorityGeneration: focusedMemoryGeneration("a".repeat(64)),
      coverage: "sufficient",
      humanActorIds: ["speaker-a", "speaker-b"],
      turns: [turn(719), turn(72), turn(648)],
    });

    expect(plan.mode).toBe("focused_retrieval");
    expect(plan.evidence.map(({ evidenceId }) => evidenceId)).toEqual([
      "evidence-000001",
      "evidence-000002",
      "evidence-000003",
    ]);
    expect(plan.evidence.map(({ turnId }) => turnId)).toEqual([
      "turn-0072",
      "turn-0648",
      "turn-0719",
    ]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.evidence)).toBe(true);
  });

  it("preserves two distant slices from the same long authoritative turn", () => {
    const source = {
      meetingId: "meeting-long",
      transcriptId: "transcript-long",
      transcriptVersion: 1,
    } as const;
    const base = turn(1, "first distant fact", "speaker-a");
    const plan = createFocusedRetrievalGroundingPlan({
      authorityGeneration: focusedMemoryGeneration("c".repeat(64)),
      coverage: "sufficient",
      humanActorIds: ["speaker-a"],
      turns: [{
        ...base,
        source: { ...source, sourceEndCodePoint: 118, sourceStartCodePoint: 100 },
        turnHash: "d".repeat(64),
      }, {
        ...base,
        source: { ...source, sourceEndCodePoint: 20_019, sourceStartCodePoint: 20_000 },
        text: "second distant fact",
        turnHash: "e".repeat(64),
      }],
    });

    expect(plan.evidence).toHaveLength(2);
    expect(plan.evidence.map(({ source: evidenceSource }) =>
      evidenceSource?.sourceStartCodePoint
    )).toEqual([100, 20_000]);
    expect(plan.evidence.reduce((bytes, evidence) =>
      bytes + new TextEncoder().encode(evidence.text).byteLength, 0
    )).toBeLessThan(1_000);
  });

  it("rejects low coverage, duplicate turns, and non-human canonical evidence", () => {
    const base = {
      authorityGeneration: focusedMemoryGeneration("a".repeat(64)),
      humanActorIds: ["speaker-a"],
    } as const;
    expect(() => createFocusedRetrievalGroundingPlan({
      ...base,
      coverage: "low",
      turns: [turn(0, "evidence", "speaker-a")],
    })).toThrow(MeetingKnowledgeInvariantError);
    expect(() => createFocusedRetrievalGroundingPlan({
      ...base,
      coverage: "sufficient",
      turns: [turn(0, "evidence", "speaker-a"), turn(0, "evidence", "speaker-a")],
    })).toThrow(MeetingKnowledgeInvariantError);
    expect(() => createFocusedRetrievalGroundingPlan({
      ...base,
      coverage: "sufficient",
      turns: [turn(0, "automation", "botik")],
    })).toThrow(MeetingKnowledgeInvariantError);
  });

  it("keeps exhaustive coverage explicit and fail-closed", () => {
    const input = {
      authorityGeneration: focusedMemoryGeneration("b".repeat(64)),
      humanActorIds: ["speaker-a", "speaker-b"],
      turns: [turn(0), turn(1), turn(2)],
    } as const;
    const exhaustive = createExhaustiveCoverageGroundingPlan({
      ...input,
      coverageBitmap: [true, true, true],
      coveragePlanDigest: "coverage-plan-1",
      coverageReduction: {
        evidenceBlockCount: 3,
        payload: { blocksReviewed: 3 },
        schemaVersion: 1,
        selectionStatus: "selected",
        selectedCanonicalTurnCount: 3,
        selectedEvidenceBlockCount: 3,
      },
    });
    expect(exhaustive.mode).toBe("exhaustive_coverage");
    expect(() => createExhaustiveCoverageGroundingPlan({
      ...input,
      coverageBitmap: [true, false, true],
      coveragePlanDigest: "coverage-plan-1",
      coverageReduction: {
        evidenceBlockCount: 3,
        payload: { blocksReviewed: 3 },
        schemaVersion: 1,
        selectionStatus: "selected",
        selectedCanonicalTurnCount: 3,
        selectedEvidenceBlockCount: 3,
      },
    })).toThrow(MeetingKnowledgeInvariantError);
  });

  it("admits exact-limit input with explicit headroom and rejects one token or byte over", () => {
    const limits = {
      maximumRequestBytes: 100_000,
      modelContextTokens: 128_000,
      outputTokensReserved: 2_048,
      reasoningTokensReserved: 4_096,
      safeInputTokens: 100_000,
      tokenDriftReserve: 8_192,
    } as const;
    expect(admitGroundingRequest({
      inputTokens: 100_000,
      requestBytes: 100_000,
    }, limits)).toEqual({
      headroomTokens: 13_664,
      status: "admitted",
    });
    expect(admitGroundingRequest({
      inputTokens: 100_001,
      requestBytes: 100_000,
    }, limits).status).toBe("unsupported_size");
    expect(admitGroundingRequest({
      inputTokens: 100_000,
      requestBytes: 100_001,
    }, limits).status).toBe("unsupported_size");
  });
});
