import { describe, expect, it } from "vitest";

import { ExecuteAdmittedQualificationQuestion } from
  "../src/quality-campaign/execute-admitted-qualification-question.js";

const packet = Object.freeze({
  locale: "en" as const,
  questionId: "q-1",
  questionText: "What was approved?",
  scopeTopologyReference: "signed-scope:v1:abc",
  source: "independent_review" as const,
});

describe("canonical admitted qualification question execution", () => {
  it("preserves provider ordering and provenance and admits only selected evidence", async () => {
    const calls: string[] = [];
    const useCase = new ExecuteAdmittedQualificationQuestion({
      answer: { generate: async (input) => {
        calls.push(`answer:${input.evidence.map(({ turnId }) => turnId).join(",")}`);
        return { citations: ["turn-2"], claims: ["The proposal was approved."],
          status: "answered" as const };
      } },
      evidence: { rehydrate: async (input) => {
        calls.push(`postgres:${input.locatorIds.join(",")}`);
        return { authorityGeneration: "generation-7", canonicalEvidenceHash: "e".repeat(64),
          transcriptVersion: 3, turns: [{ endMs: 20, sourceLocatorId: "loc-2",
            speakerId: "speaker-1", startMs: 10, text: "Approved.", turnHash: "f".repeat(64),
            turnId: "turn-2" }] };
      } },
      outcome: { record: async () => undefined },
      retrieval: { retrieve: async () => {
        calls.push("infinity");
        return { candidates: [{ contributions: [{ contributionScorePicos: 11,
          providerLaneId: "dense", providerRank: 4, queryId: "original-question",
          rawScoreKind: "cosine", rawScoreValue: 0.8 }], fusedScore: 0.9,
          locatorId: "loc-2", providerRank: 2 }, { contributions: [], fusedScore: 0.7,
          locatorId: "loc-1", providerRank: 5 }], rawResponseSha256: "a".repeat(64),
          status: "completed" as const };
      } },
    });

    const result = await useCase.execute(packet, { attemptId: "attempt-1",
      signal: new AbortController().signal });

    expect(calls).toEqual(["infinity", "postgres:loc-2,loc-1", "answer:turn-2"]);
    expect(result).toMatchObject({ citations: ["turn-2"], status: "answered" });
    expect(result.retrievalCandidates).toEqual([
      expect.objectContaining({ fusedScore: 0.9, locatorId: "loc-2", providerRank: 2 }),
      expect.objectContaining({ fusedScore: 0.7, locatorId: "loc-1", providerRank: 5 }),
    ]);
  });

  it("deterministically abstains without calling the answer runtime when no evidence exists",
    async () => {
      let answerCalls = 0;
      const useCase = new ExecuteAdmittedQualificationQuestion({
        answer: { generate: async () => {answerCalls += 1; throw new Error("unreachable");} },
        evidence: { rehydrate: async () => ({ authorityGeneration: "generation-7",
          canonicalEvidenceHash: "e".repeat(64), transcriptVersion: 3, turns: [] }) },
        outcome: { record: async () => undefined },
        retrieval: { retrieve: async () => ({ candidates: [], rawResponseSha256: "a".repeat(64),
          status: "completed" as const }) },
      });
      await expect(useCase.execute(packet, { attemptId: "attempt-1",
        signal: new AbortController().signal }))
        .resolves.toMatchObject({ citations: [], claims: [], reason: "zero_admissible_evidence",
          status: "abstained" });
      expect(answerCalls).toBe(0);
    });

  it("keeps rejected PostgreSQL evidence in the qualification denominator", async () => {
    const recorded: unknown[] = [];
    const useCase = new ExecuteAdmittedQualificationQuestion({
      answer: { generate: async () => {throw new Error("answer must not run");} },
      evidence: { rehydrate: async () => {throw new Error("stale cross-room locator");} },
      outcome: { record: async (_attemptId, outcome) => {recorded.push(outcome);} },
      retrieval: { retrieve: async () => ({ candidates: [{ contributions: [], fusedScore: 0.9,
        locatorId: "loc-2", providerRank: 2 }], rawResponseSha256: "a".repeat(64),
      status: "completed" as const }) },
    });

    await expect(useCase.execute(packet, { attemptId: "attempt-1",
      signal: new AbortController().signal })).resolves.toMatchObject({
      rawRetrievalResponseSha256: "a".repeat(64), reason: "evidence_rehydration_failed",
      retrievalCandidates: [expect.objectContaining({ locatorId: "loc-2" })], status: "failed",
    });
    expect(recorded).toHaveLength(1);
  });

  it("rejects citations outside the selected canonical turns", async () => {
    const useCase = new ExecuteAdmittedQualificationQuestion({
      answer: { generate: async () => ({ citations: ["unselected-turn"], claims: ["bad"],
        status: "answered" as const }) },
      evidence: { rehydrate: async () => ({ authorityGeneration: "generation-7",
        canonicalEvidenceHash: "e".repeat(64), transcriptVersion: 3, turns: [{ endMs: 20,
          sourceLocatorId: "loc-2", speakerId: "speaker-1", startMs: 10, text: "Approved.",
          turnHash: "f".repeat(64), turnId: "turn-2" }] }) },
      outcome: { record: async () => undefined },
      retrieval: { retrieve: async () => ({ candidates: [{ contributions: [], fusedScore: 0.9,
        locatorId: "loc-2", providerRank: 2 }], rawResponseSha256: "a".repeat(64),
        status: "completed" as const }) },
    });
    await expect(useCase.execute(packet, { attemptId: "attempt-1",
      signal: new AbortController().signal }))
      .rejects.toThrow("outside selected prompt evidence");
  });

  it("has no gold-bearing execute boundary", async () => {
    const useCase = new ExecuteAdmittedQualificationQuestion({
      answer: { generate: async () => ({ citations: [], claims: [], status: "abstained" as const }) },
      evidence: { rehydrate: async () => ({ authorityGeneration: "generation-7",
        canonicalEvidenceHash: "e".repeat(64), transcriptVersion: 3, turns: [] }) },
      outcome: { record: async () => undefined },
      retrieval: { retrieve: async () => ({ candidates: [], rawResponseSha256: "a".repeat(64),
        status: "completed" as const }) },
    });
    await expect(useCase.execute({ ...packet, goldPath: "/private/gold.json" } as never,
      { attemptId: "attempt-1", signal: new AbortController().signal }))
      .rejects.toThrow("execution packet");
  });
});
