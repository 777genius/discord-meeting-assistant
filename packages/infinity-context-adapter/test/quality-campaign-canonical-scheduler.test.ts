import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { DurableAttemptJournal, withOwnedAttemptJournal } from
  "../src/quality-campaign/attempt-journal.js";
import { sha256 } from "../src/quality-campaign/canonical.js";
import type { QualificationQuestionExecutorFactoryPort } from
  "../src/quality-campaign/execute-admitted-qualification-question.js";
import { executeCanonicalMainCampaignSchedule } from
  "../src/quality-campaign/production-canonical-scheduler.js";

const digest = (character: string) => character.repeat(64);
const packets = Object.freeze(Array.from({ length: 240 }, (_, index) => Object.freeze({
  locale: index % 2 === 0 ? "en" as const : "ru" as const, questionId: `q-${index}`,
  questionText: `Question q-${index}?`, scopeTopologyReference: `scope:q-${index}`,
  source: index < 200 ? "automatic" as const : "independent_review" as const })));
const questions = Object.freeze(packets.map((packet, index) => Object.freeze({
  locale: packet.locale, questionDigestSha256: sha256(packet), questionId: packet.questionId,
  rubricDigestSha256: digest(((index + 1) % 10).toString()), source: packet.source })));
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
  it("closes every owned journal across repeated success and scheduler failure", async () => {
    const close = vi.spyOn(DurableAttemptJournal.prototype, "close");
    const outcome = { citations: [], claims: [], rawRetrievalResponseSha256: digest("a"),
      reason: "zero_admissible_evidence", retrievalCandidates: [], selectedTurns: [],
      status: "abstained" as const };
    const schedule = async (factory: QualificationQuestionExecutorFactoryPort) =>
      await executeCanonicalMainCampaignSchedule({ campaignRootSha256: digest("b"),
        clock: { nowEpochMs: () => 1_000 }, concurrency: 2, deadlineEpochMs: 10_000,
        executionPackets: packets, executorFactory: factory, questions, ...await durable(),
        release, releaseRootSha256: digest("c"), spendReservationSha256ByRepetition: {
          1: digest("d"), 2: digest("e"), 3: digest("f") } });
    try {
      await schedule({ create: async () => {throw new Error("unreachable");},
        recover: async () => outcome });
      await expect(schedule({ create: async () => {throw new Error("unreachable");},
        recover: async () => {throw new Error("synthetic scheduler failure");} }))
        .rejects.toThrow("synthetic scheduler failure");
      expect(close).toHaveBeenCalledTimes(2);
    } finally {close.mockRestore();}
  });

  it.each([
    { closeFails: false, operationFails: false, expected: "operation value" },
    { closeFails: true, operationFails: false, expected: "synthetic close failure" },
    { closeFails: false, operationFails: true, expected: "synthetic operation failure" },
    { closeFails: true, operationFails: true, expected: "synthetic operation failure" },
  ])("closes once after operation=$operationFails and close=$closeFails", async ({ closeFails,
    expected, operationFails }) => {
    const close = vi.fn(async () => {if (closeFails) {throw new Error("synthetic close failure");}});
    const journal = { close } as unknown as DurableAttemptJournal;
    const result = withOwnedAttemptJournal(journal, async () => {
      if (operationFails) {throw new Error("synthetic operation failure");}
      return "operation value";
    });
    if (operationFails || closeFails) {await expect(result).rejects.toThrow(expected);}
    else {await expect(result).resolves.toBe(expected);}
    expect(close).toHaveBeenCalledOnce();
  });

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

  it("rejects same-ID question text or scope substitution before creating a provider", async () => {
    let creates = 0;
    for (const replacement of [{ ...packets[0]!, questionText: "Substituted question?" },
      { ...packets[0]!, scopeTopologyReference: "scope:substituted" }]) {
      await expect(executeCanonicalMainCampaignSchedule({ campaignRootSha256: digest("b"),
        clock: { nowEpochMs: () => 1_000 }, concurrency: 2, deadlineEpochMs: 10_000,
        executionPackets: packets.map((packet, index) => index === 0 ? replacement : packet),
        executorFactory: { create: async () => {creates += 1; throw new Error("unreachable");},
          recover: async () => null }, questions, release, releaseRootSha256: digest("c"),
        ...await durable(), spendReservationSha256ByRepetition: {
          1: digest("d"), 2: digest("e"), 3: digest("f") } }))
        .rejects.toThrow("differs from admitted questions");
    }
    expect(creates).toBe(0);
  });
});
