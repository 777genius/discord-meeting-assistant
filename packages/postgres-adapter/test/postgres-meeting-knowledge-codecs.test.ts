import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { QuestionBindingSnapshot } from
  "@discord-meeting/meeting-core/meeting-knowledge";

import { decodeGroundingPlan } from
  "../src/postgres-meeting-knowledge-codecs.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {return value.map(canonical);}
  if (typeof value !== "object" || value === null) {return value;}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => [key, canonical(item)]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8")
    .digest("hex");
}

const retrievalRequest = { binding: {
  capabilityFingerprint: "b".repeat(64), profileId: "profile-v2",
} };
const binding = {
  bindingProtocolVersion: 2,
  retrievalBinding: {
    request: retrievalRequest,
    retrievalPath: "infinity_locator_v2",
  },
} as unknown as QuestionBindingSnapshot;
const questionText = "What happened earlier?";
const contribution = {
  contributionScorePicos: 10,
  providerLaneId: "postgres_keyword",
  providerRank: 1,
  queryId: "original-question",
  rawScoreKind: "bm25" as const,
  rawScoreValue: 1,
};
const persistedHistoricalPlan = {
  authorityGeneration: "authority-1",
  evidence: [{
    endMs: 1_000,
    evidenceId: "evidence-000001",
    retrievalAudit: {
      capabilityFingerprint: "b".repeat(64),
      contributions: [contribution],
      fusedScore: 1,
      locator: "candidate-1",
      profileId: "profile-v2",
      providerRank: 1,
      requestDigest: digest(retrievalRequest),
      responseDigest: digest({ contributions: [contribution], fusedScore: 1,
        locator: "candidate-1", providerRank: 1 }),
    },
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
      binding,
      questionText,
    )).toEqual(persistedHistoricalPlan);
  });

  it("rejects a partial historical provenance triple", () => {
    const incomplete = JSON.parse(JSON.stringify(persistedHistoricalPlan)) as {
      evidence: Array<{ source: { historicalSource: Record<string, string> } }>;
    };
    delete incomplete.evidence[0]?.source.historicalSource.candidateLocator;
    expect(() => decodeGroundingPlan(incomplete, binding, questionText)).toThrow();
  });

  it("rejects bounded provenance that is not bound to the persisted request/result", () => {
    const hostile = structuredClone(persistedHistoricalPlan);
    (hostile.evidence[0].retrievalAudit as { responseDigest: string }).responseDigest =
      "f".repeat(64);
    expect(() => decodeGroundingPlan(hostile, binding, questionText)).toThrow(
      "does not bind",
    );
  });
});
