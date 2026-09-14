import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFocusedRetrievalGroundingPlan } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { SubscriptionRuntimeGroundedAnswerAdapter } from
  "@discord-meeting/subscription-runtime-adapter";

import { ExecuteAdmittedQualificationQuestion, type QualificationCanonicalTurn } from
  "../src/quality-campaign/execute-admitted-qualification-question.js";
import { selectCanonicalTurnsWithinModelInputLimit } from
  "../src/quality-campaign/production-canonical-evidence-port.js";
import { canonicalAnswerFitsPreparedInput } from
  "../src/quality-campaign/production-canonical-question-chain.js";

function boundTurn(turnId: string, text: string, sourceLocatorId = "loc-" + turnId):
QualificationCanonicalTurn {
  return Object.freeze({ endMs: 20, sourceLocatorId, speakerId: "speaker", startMs: 10, text,
    turnHash: createHash("sha256").update(turnId).digest("hex"), turnId });
}
function boundBinding(turns: readonly QualificationCanonicalTurn[]) {
  return { canonicalEvidenceHash: createHash("sha256").update(JSON.stringify(
    turns.map(({ turnHash }) => turnHash))).digest("hex"), memoryGeneration: "generation",
  transcriptVersion: 1 };
}

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
      outcome: { record: async () => {} },
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

  it("rehydrates neighbor evidence while retaining seed-only ranked metrics", async () => {
    let rehydrated: readonly string[] = [];
    const useCase = new ExecuteAdmittedQualificationQuestion({
      answer: { generate: async () => ({ citations: ["turn-neighbor"], claims: ["Supported."],
        status: "answered" as const }) },
      evidence: { rehydrate: async ({ locatorIds }) => {
        rehydrated = locatorIds;
        return { authorityGeneration: "generation-7", canonicalEvidenceHash: "e".repeat(64),
          transcriptVersion: 3, turns: [boundTurn("turn-neighbor", "Supported.",
            "loc-neighbor")] };
      } },
      outcome: { record: async () => {} },
      retrieval: { retrieve: async () => ({ candidates: [{ contributions: [], fusedScore: 0.9,
        locatorId: "loc-seed", providerRank: 1 }, { contributions: [], fusedScore: 0.8,
        locatorId: "loc-seed-2", providerRank: 2 }],
      expandedNeighbors: [{ distance: 1 as const, locatorId: "loc-neighbor", providerRank: 1,
        seedLocatorId: "loc-seed" }], rawResponseSha256: "a".repeat(64),
      status: "completed" as const }) },
    });
    const result = await useCase.execute(packet, { attemptId: "attempt-neighbor",
      signal: new AbortController().signal });
    expect(rehydrated).toEqual(["loc-seed", "loc-neighbor", "loc-seed-2"]);
    expect(result.retrievalCandidates.map(({ locatorId }) => locatorId))
      .toEqual(["loc-seed", "loc-seed-2"]);
    expect(result.selectedTurns.map(({ sourceLocatorId }) => sourceLocatorId))
      .toEqual(["loc-neighbor"]);
  });

  it("deterministically abstains without calling the answer runtime when no evidence exists",
    async () => {
      let answerCalls = 0;
      const useCase = new ExecuteAdmittedQualificationQuestion({
        answer: { generate: async () => {answerCalls += 1; throw new Error("unreachable");} },
        evidence: { rehydrate: async () => ({ authorityGeneration: "generation-7",
          canonicalEvidenceHash: "e".repeat(64), transcriptVersion: 3, turns: [] }) },
        outcome: { record: async () => {} },
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

  it("propagates cancellation when evidence rehydration rejects after abort", async () => {
    const cancellation = new Error("diagnostic timeout");
    const controller = new AbortController();
    let answerCalls = 0;
    let outcomeCalls = 0;
    const useCase = new ExecuteAdmittedQualificationQuestion({
      answer: { generate: async () => {answerCalls += 1; throw new Error("unreachable");} },
      evidence: { rehydrate: async () => {
        controller.abort(cancellation);
        throw new Error("rehydration interrupted");
      } },
      outcome: { record: async () => {outcomeCalls += 1;} },
      retrieval: { retrieve: async () => ({ candidates: [{ contributions: [], fusedScore: 0.9,
        locatorId: "loc-2", providerRank: 2 }], rawResponseSha256: "a".repeat(64),
      status: "completed" as const }) },
    });

    await expect(useCase.execute(packet, { attemptId: "attempt-1", signal: controller.signal }))
      .rejects.toBe(cancellation);
    expect(answerCalls).toBe(0);
    expect(outcomeCalls).toBe(0);
  });

  it("rejects citations outside the selected canonical turns", async () => {
    const useCase = new ExecuteAdmittedQualificationQuestion({
      answer: { generate: async () => ({ citations: ["unselected-turn"], claims: ["bad"],
        status: "answered" as const }) },
      evidence: { rehydrate: async () => ({ authorityGeneration: "generation-7",
        canonicalEvidenceHash: "e".repeat(64), transcriptVersion: 3, turns: [{ endMs: 20,
          sourceLocatorId: "loc-2", speakerId: "speaker-1", startMs: 10, text: "Approved.",
          turnHash: "f".repeat(64), turnId: "turn-2" }] }) },
      outcome: { record: async () => {} },
      retrieval: { retrieve: async () => ({ candidates: [{ contributions: [], fusedScore: 0.9,
        locatorId: "loc-2", providerRank: 2 }], rawResponseSha256: "a".repeat(64),
        status: "completed" as const }) },
    });
    await expect(useCase.execute(packet, { attemptId: "attempt-1",
      signal: new AbortController().signal }))
      .rejects.toThrow("outside selected prompt evidence");
  });

  it("selects ranked whole turns under exact original and repair UTF-8 model-input bounds",
    async () => {
    let providerCalls = 0;
    const answer = new SubscriptionRuntimeGroundedAnswerAdapter({
      checkHealth: async () => ({ launcherSha256: "a".repeat(64), runtimeEngine: "synthetic",
        runtimeVersion: "synthetic", status: "serving", warningCodes: [] }),
      execute: async () => {providerCalls += 1; throw new Error("provider call forbidden");},
    }, { expectedLauncherSha256: "a".repeat(64) });
    const fits = (turns: readonly QualificationCanonicalTurn[]) =>
      canonicalAnswerFitsPreparedInput(answer, packet, boundBinding(turns), turns, "attempt-bound");

    const rawBoundary = boundTurn("raw-boundary", "");
    const rawFixedBytes = new TextEncoder().encode(JSON.stringify([rawBoundary])).byteLength;
    const rawLimitTurn = boundTurn("raw-boundary", "a".repeat(16_000 - rawFixedBytes));
    expect(new TextEncoder().encode(JSON.stringify([rawLimitTurn])).byteLength).toBe(16_000);
    expect(selectCanonicalTurnsWithinModelInputLimit([[rawLimitTurn]], fits)).toEqual([]);

    let low = 0, high = 16_000;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits([boundTurn("multibyte", "Ж".repeat(middle))])) {low = middle;}
      else {high = middle - 1;}
    }
    const boundary = boundTurn("multibyte", "Ж".repeat(low));
    const prepared = answer.prepare({ attemptId: "attempt-bound", binding: boundBinding([boundary]),
      locale: packet.locale, plan: createFocusedRetrievalGroundingPlan({ authorityGeneration:
        "generation", coverage: "sufficient", humanActorIds: ["speaker"], turns: [boundary] }),
      question: packet.questionText });
    expect(prepared.exactInput.original.fullInputBytes).toBeLessThanOrEqual(16_000);
    expect(prepared.exactInput.repair.fullInputBytes).toBeLessThanOrEqual(16_000);
    expect(fits([boundTurn("multibyte", `${boundary.text}Ж`)])).toBe(false);

    const oversized = boundTurn("multibyte", `${boundary.text}Ж`, "loc-ranked-1");
    const later = boundTurn("later", "😀", "loc-ranked-2");
    expect(selectCanonicalTurnsWithinModelInputLimit([[oversized], [later]], fits)).toEqual([later]);

    const selected = selectCanonicalTurnsWithinModelInputLimit([[oversized]], fits);
    const outcome = await new ExecuteAdmittedQualificationQuestion({
      answer: { generate: async () => {providerCalls += 1; throw new Error("unreachable");} },
      evidence: { rehydrate: async () => ({ authorityGeneration: "generation",
        canonicalEvidenceHash: boundBinding(selected).canonicalEvidenceHash, transcriptVersion: 1,
        turns: selected }) },
      outcome: { record: async () => {} },
      retrieval: { retrieve: async () => ({ candidates: [{ contributions: [], fusedScore: 1,
        locatorId: "loc-ranked-1", providerRank: 0 }], rawResponseSha256: "a".repeat(64),
        status: "completed" as const }) },
    }).execute(packet, { attemptId: "attempt-oversized",
      signal: new AbortController().signal });
    expect(outcome).toMatchObject({ reason: "zero_admissible_evidence", status: "abstained" });
    expect(providerCalls).toBe(0);
  });

  it("deduplicates overlapping exact turns and rejects incompatible overlap", () => {
    const first = Object.freeze({ endMs: 20, sourceLocatorId: "loc-1", speakerId: "speaker",
      startMs: 10, text: "Approved.", turnHash: "f".repeat(64), turnId: "turn-1" });
    const duplicate = Object.freeze({ ...first, sourceLocatorId: "loc-2" });
    expect(selectCanonicalTurnsWithinModelInputLimit([[first], [duplicate]], () => true))
      .toEqual([first]);
    expect(() => selectCanonicalTurnsWithinModelInputLimit([[first],
      [{ ...duplicate, turnHash: "e".repeat(64) }]], () => true))
      .toThrow(/incompatible slices/u);
  });

  it("has no gold-bearing execute boundary", async () => {
    const useCase = new ExecuteAdmittedQualificationQuestion({
      answer: { generate: async () => ({ citations: [], claims: [], status: "abstained" as const }) },
      evidence: { rehydrate: async () => ({ authorityGeneration: "generation-7",
        canonicalEvidenceHash: "e".repeat(64), transcriptVersion: 3, turns: [] }) },
      outcome: { record: async () => {} },
      retrieval: { retrieve: async () => ({ candidates: [], rawResponseSha256: "a".repeat(64),
        status: "completed" as const }) },
    });
    await expect(useCase.execute({ ...packet, goldPath: "/private/gold.json" } as never,
      { attemptId: "attempt-1", signal: new AbortController().signal }))
      .rejects.toThrow("execution packet");
  });
});
