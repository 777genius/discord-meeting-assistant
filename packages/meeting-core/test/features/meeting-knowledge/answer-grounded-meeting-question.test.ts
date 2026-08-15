import {
  AnswerGroundedMeetingQuestion,
  GroundedMeetingAnswer,
  type GroundedAnswerGenerator,
  type LiveFinalizedMemoryQueryPort,
  type HistoricalAuthorizationPort,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { describe, expect, it, vi } from "vitest";

const context = {
  appliedGeneration: 1,
  humanActorIds: ["participant-1"],
  identityGeneration: 1,
  knowledgeEpoch: `live-memory:v1:${"a".repeat(64)}`,
  meetingId: "meeting-1",
  roomId: "room-1",
  scopeId: "scope-1",
  sourceGeneration: 1,
} as const;

function live(): LiveFinalizedMemoryQueryPort {
  return {
    resolveContext: async (input) => input.roomId === context.roomId
      ? context
      : null,
    searchHotTail: async () => ({
      candidates: [{
        meetingId: "meeting-1",
        sourceGeneration: 1,
        turnHash: "b".repeat(64),
        turnId: "turn-1",
      }],
      context,
      schemaVersion: 1,
      status: "current",
    }),
    rehydrateHotTail: async () => ({
      context,
      schemaVersion: 1,
      status: "current",
      turns: [{
        endMs: 2_000,
        speakerId: "participant-1",
        startMs: 1_000,
        text: "The launch is Friday.",
        turnHash: "b".repeat(64),
        turnId: "turn-1",
      }],
    }),
  };
}

function generator(): GroundedAnswerGenerator {
  return {
    measure: async () => ({
      inputTokens: 100,
      requestBytes: 1_000,
      runtimeProfile: "fixture",
    }),
    generate: async () => ({
      answer: {
        claims: [{ evidenceIds: ["evidence-000001"], text: "The launch is Friday." }],
        locale: "en",
        status: "answered",
      },
      status: "completed",
    }),
  };
}

const limits = {
  maximumRequestBytes: 10_000,
  modelContextTokens: 10_000,
  outputTokensReserved: 100,
  reasoningTokensReserved: 100,
  safeInputTokens: 8_000,
  tokenDriftReserve: 100,
} as const;

function useCase(query = live()) {
  return new AnswerGroundedMeetingQuestion({
    answers: new GroundedMeetingAnswer(generator(), limits),
    ids: { digest: () => "c".repeat(64) },
    live: query,
    turnHashes: { hash: () => "b".repeat(64) },
  });
}

const request = {
  activeParticipantId: "participant-1",
  locale: "en-US",
  meetingId: "meeting-1",
  question: "When is the launch?",
  roomId: "room-1",
} as const;

describe("published grounded meeting question", () => {
  it("separates text-free lookup from canonical rehydration and returns cited plain text", async () => {
    await expect(useCase().execute(request, {
      signal: new AbortController().signal,
    })).resolves.toEqual({
      answer: {
        citations: [{ turnId: "turn-1" }],
        evidenceEpoch: `room-memory:v1:${"c".repeat(64)}`,
        knowledgeEpoch: `room-memory:v1:${"c".repeat(64)}`,
        plainText: "The launch is Friday.",
      },
      schemaVersion: 1,
      status: "answered",
    });
  });

  it("propagates one signal through context, search and canonical rehydration", async () => {
    const query = live();
    const resolveContext = vi.spyOn(query, "resolveContext");
    const searchHotTail = vi.spyOn(query, "searchHotTail");
    const rehydrateHotTail = vi.spyOn(query, "rehydrateHotTail");
    const signal = new AbortController().signal;

    await useCase(query).execute(request, { signal });

    expect(resolveContext.mock.calls.every(([input]) => input.signal === signal)).toBe(true);
    expect(searchHotTail.mock.calls.every(([input]) => input.signal === signal)).toBe(true);
    expect(rehydrateHotTail.mock.calls.every(([input]) => input.signal === signal)).toBe(true);
  });

  it("rebuilds the canonical watermark for the final playback authority fence", async () => {
    const query = live();
    const answer = useCase(query);
    const signal = new AbortController().signal;
    await expect(answer.recheckPlaybackAuthority({
      ...request,
      citationTurnIds: ["turn-1"],
      evidenceEpoch: `room-memory:v1:${"c".repeat(64)}`,
      knowledgeEpoch: `room-memory:v1:${"c".repeat(64)}`,
    }, { signal })).resolves.toEqual({ schemaVersion: 1, status: "current" });

    vi.spyOn(query, "resolveContext").mockResolvedValue(null);
    await expect(answer.recheckPlaybackAuthority({
      ...request,
      citationTurnIds: ["turn-1"],
      evidenceEpoch: `room-memory:v1:${"c".repeat(64)}`,
      knowledgeEpoch: `room-memory:v1:${"c".repeat(64)}`,
    }, { signal })).resolves.toMatchObject({
      reason: "playback_authority_denied",
      status: "stale",
    });
  });

  it("denies a cross-room requester before retrieval or generation", async () => {
    const query = live();
    const search = vi.spyOn(query, "searchHotTail");
    await expect(useCase(query).execute({ ...request, roomId: "room-2" }, {
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ status: "unavailable" });
    expect(search).not.toHaveBeenCalled();
  });

  it("never turns a live exhaustive request into a completeness claim", async () => {
    const exhaustive = { buildPlan: vi.fn(async () => ({
      plan: {
        coverageBitmap: [true] as const,
        coveragePlanDigest: "plan-1",
        finalSynthesisAllowed: true as const,
        reduction: {
          evidenceLocators: [],
          payload: {},
          selectedTurns: [],
          selectionStatus: "no_match" as const,
          schemaVersion: 1 as const,
        },
        schemaVersion: 1 as const,
        selectedBlocks: [],
        strategy: "exhaustive_coverage" as const,
        synthesisRequiresCanonicalRehydration: true as const,
      },
      status: "ready" as const,
    })) };
    const answer = new AnswerGroundedMeetingQuestion({
      answers: new GroundedMeetingAnswer(generator(), limits),
      exhaustive,
      ids: { digest: () => "c".repeat(64) },
      live: live(),
      turnHashes: { hash: () => "b".repeat(64) },
    });
    await expect(answer.execute({
      ...request,
      authorizationPrincipalRef: "opaque",
      question: "List every decision",
    }, { signal: new AbortController().signal })).resolves.toMatchObject({
      reason: "active_meeting_not_final_for_exhaustive_claim",
      status: "insufficient_evidence",
    });
    expect(exhaustive.buildPlan).toHaveBeenCalledTimes(1);
  });

  it("rechecks source-room authorization before generation and publication", async () => {
    let observations = 0;
    const authorization: HistoricalAuthorizationPort = {
      authorize: async () => {
        observations += 1;
        return {
          authorizationDigest: "authorization-1",
          authorizationEpoch: "epoch-1",
          authorized: observations < 3,
          policyVersion: "policy-1",
        };
      },
    };
    const answer = new AnswerGroundedMeetingQuestion({
      answers: new GroundedMeetingAnswer(generator(), limits),
      authorization,
      ids: { digest: () => "c".repeat(64) },
      live: live(),
      turnHashes: { hash: () => "b".repeat(64) },
    });

    await expect(answer.execute({
      ...request,
      authorizationPrincipalRef: "opaque",
    }, { signal: new AbortController().signal })).resolves.toMatchObject({
      reason: "authority_changed_before_publication",
      status: "cancelled",
    });
    expect(observations).toBe(3);
  });

  it("does not ignore a focused retriever route_required outcome", async () => {
    const exhaustive = { buildPlan: vi.fn(async () => ({
      plan: {
        coverageBitmap: [true] as const,
        coveragePlanDigest: "plan-1",
        finalSynthesisAllowed: true as const,
        reduction: {
          evidenceLocators: [],
          payload: {},
          selectedTurns: [],
          selectionStatus: "no_match" as const,
          schemaVersion: 1 as const,
        },
        schemaVersion: 1 as const,
        selectedBlocks: [],
        strategy: "exhaustive_coverage" as const,
        synthesisRequiresCanonicalRehydration: true as const,
      },
      status: "ready" as const,
    })) };
    const answer = new AnswerGroundedMeetingQuestion({
      answers: new GroundedMeetingAnswer(generator(), limits),
      exhaustive,
      focusedHistorical: {
        buildPlan: async () => ({
          mode: "exhaustive_coverage" as const,
          status: "route_required" as const,
        }),
      },
      historicalSearchEnabled: () => true,
      historicalServingAuthorized: () => true,
      ids: { digest: () => "c".repeat(64) },
      live: live(),
      turnHashes: { hash: () => "b".repeat(64) },
    });

    await expect(answer.execute({
      ...request,
      authorizationPrincipalRef: "opaque",
    }, { signal: new AbortController().signal })).resolves.toMatchObject({
      reason: "active_meeting_not_final_for_exhaustive_claim",
      status: "insufficient_evidence",
    });
    expect(exhaustive.buildPlan).toHaveBeenCalledOnce();
  });
});
