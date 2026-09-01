import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { QualificationQuestionExecutorFactoryPort } from
  "../src/quality-campaign/execute-admitted-qualification-question.js";
import { executeCanonicalMainCampaignSchedule } from
  "../src/quality-campaign/production-canonical-scheduler.js";

const digest = (character: string) => character.repeat(64);
const questions = Object.freeze(Array.from({ length: 240 }, (_, index) => Object.freeze({
  locale: index % 2 === 0 ? "en" as const : "ru" as const,
  questionDigestSha256: digest((index % 10).toString()), questionId: `q-${index}`,
  rubricDigestSha256: digest(((index + 1) % 10).toString()),
  source: index < 200 ? "automatic" as const : "independent_review" as const,
})));
const packets = Object.freeze(questions.map((question) => Object.freeze({ locale: question.locale,
  questionId: question.questionId, questionText: `Question ${question.questionId}?`,
  scopeTopologyReference: `scope:${question.questionId}`, source: question.source })));
const release = Object.freeze({ answerProcessIdentitySha256: digest("1"),
  infinityCapabilitySha256: digest("2"), mapperSha256: digest("3"),
  tokenizerSha256: digest("4") });
const spendReservations = ([1, 2, 3] as const).map((repetition) => ({ payload: {
  allowedCallKinds: ["answer", "capability", "retrieval"], campaignRootSha256: digest("b"),
  maxCalls: 1_000, maxCallsByKind: { answer: 240, capability: 240, retrieval: 240 },
  maxEncryptedBytes: 100_000_000, maxTokens: 10_000_000, releaseRootSha256: digest("c"),
  repetition }, spendReservationSha256: [digest("d"), digest("e"), digest("f")][repetition - 1],
})) as never;
const durable = async () => ({ journalRoot: await mkdtemp(join(tmpdir(), "canonical-schedule-")),
  policy: {} as never, reservations: spendReservations });

describe("installed canonical main scheduler", () => {
  it("executes exactly three stable repetitions through only the canonical executor", async () => {
    const attempts: string[] = [];
    const factory: QualificationQuestionExecutorFactoryPort = { create: async (binding) => ({
      execute: async (packet, context) => {
        expect(context.attemptId).toBe(binding.attemptId);
        attempts.push(`${binding.repetition}:${packet.questionId}:${context.attemptId}`);
        return { citations: [], claims: [], rawRetrievalResponseSha256: digest("a"),
          reason: "zero_admissible_evidence", retrievalCandidates: [{ contributions: [{
            contributionScorePicos: 2, providerLaneId: "postgres_keyword", providerRank: 0,
            queryId: "original-question", rawScoreKind: "ts_rank", rawScoreValue: 0.125 }],
          fusedScore: 0.75, locatorId: `locator:${packet.questionId}`, providerRank: 0 }],
        selectedTurns: [],
          status: "abstained" as const };
      },
    }), recover: async () => null };
    const result = await executeCanonicalMainCampaignSchedule({ campaignRootSha256: digest("b"),
      clock: { nowEpochMs: () => 1_000 }, concurrency: 8, deadlineEpochMs: 10_000,
      executionPackets: packets, executorFactory: factory, questions, ...await durable(),
      release, releaseRootSha256: digest("c"), spendReservationSha256ByRepetition: {
        1: digest("d"), 2: digest("e"), 3: digest("f") } });
    expect(result).toMatchObject({ completedOutcomes: 720, outcomeUnknown: false });
    expect(attempts).toHaveLength(720);
    expect(new Set(result.terminalAttemptIds)).toHaveLength(720);
  });

  it("makes an unknown external effect terminal without recreating that attempt", async () => {
    const creates = new Map<string, number>();
    const factory: QualificationQuestionExecutorFactoryPort = { create: async (binding) => {
      creates.set(binding.attemptId, (creates.get(binding.attemptId) ?? 0) + 1);
      return { execute: async () => {throw new Error(
        "grounded answer external effect is unknown and terminal");} };
    }, recover: async () => null };
    const result = await executeCanonicalMainCampaignSchedule({ campaignRootSha256: digest("b"),
      clock: { nowEpochMs: () => 1_000 }, concurrency: 2, deadlineEpochMs: 10_000,
      executionPackets: packets, executorFactory: factory, questions, ...await durable(),
      release, releaseRootSha256: digest("c"), spendReservationSha256ByRepetition: {
        1: digest("d"), 2: digest("e"), 3: digest("f") } });
    expect(result.outcomeUnknown).toBe(true);
    expect([...creates.values()].every((count) => count === 1)).toBe(true);
    expect(result.terminalAttemptIds.length).toBeGreaterThan(0);
  });

  it("rejects an execution corpus that differs from admitted question metadata", async () => {
    await expect(executeCanonicalMainCampaignSchedule({ campaignRootSha256: digest("b"),
      clock: { nowEpochMs: () => 1_000 }, concurrency: 2, deadlineEpochMs: 10_000,
      executionPackets: packets.map((packet, index) => index === 0 ?
        { ...packet, locale: "ru" as const } : packet), executorFactory: { create: async () => {
          throw new Error("unreachable");}, recover: async () => null }, questions, release,
      releaseRootSha256: digest("c"), ...await durable(),
      spendReservationSha256ByRepetition: { 1: digest("d"), 2: digest("e"), 3: digest("f") } }))
      .rejects.toThrow("differs from admitted questions");
  });
});
