import { describe, expect, it } from "vitest";

import { decodeGroundingPlan } from
  "../src/postgres-meeting-knowledge-codecs.js";

const persistedHistoricalPlan = {
  authorityGeneration: "authority-1",
  evidence: [{
    endMs: 1_000,
    evidenceId: "evidence-000001",
    source: {
      historicalSource: {
        candidateLocator: "candidate-1",
        indexGeneration: "generation-1",
        releaseId: "release-1",
      },
      meetingId: "historical-meeting",
      sourceEndCodePoint: 12,
      sourceStartCodePoint: 0,
      transcriptId: "historical-transcript",
      transcriptVersion: 1,
    },
    speakerId: "speaker-1",
    startMs: 0,
    text: "Earlier fact",
    turnHash: "a".repeat(64),
    turnId: "turn-1",
  }],
  mode: "focused_retrieval",
} as const;

describe("persisted grounding plan historical provenance", () => {
  it("round-trips the exact release, generation, and candidate locator", () => {
    expect(decodeGroundingPlan(
      JSON.parse(JSON.stringify(persistedHistoricalPlan)),
    )).toEqual(persistedHistoricalPlan);
  });

  it("rejects a partial historical provenance triple", () => {
    const incomplete = JSON.parse(JSON.stringify(persistedHistoricalPlan)) as {
      evidence: Array<{ source: { historicalSource: Record<string, string> } }>;
    };
    delete incomplete.evidence[0]?.source.historicalSource.candidateLocator;
    expect(() => decodeGroundingPlan(incomplete)).toThrow();
  });
});
