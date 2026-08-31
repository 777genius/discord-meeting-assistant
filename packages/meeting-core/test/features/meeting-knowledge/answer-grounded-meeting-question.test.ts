import {
  AnswerGroundedMeetingQuestion,
  GroundedMeetingAnswer,
  type GroundedAnswerGenerator,
  type LiveFinalizedMemoryQueryPort,
  type HistoricalAuthorizationPort,
  type FocusedHistoricalEvidenceV2Port,
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

function mixedLaneLive(): LiveFinalizedMemoryQueryPort {
  const query = live();
  query.rehydrateHotTail = async () => ({
    context, schemaVersion: 1, status: "current" as const, turns: [{
      endMs: 2_000, speakerId: "participant-1", startMs: 1_000,
      text: "CURRENT-ANCHOR confirms Project Atlas is active.",
      turnHash: "b".repeat(64), turnId: "turn-1",
    }],
  });
  return query;
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

function barrier(): {
  readonly promise: Promise<void>;
  readonly release: () => void;
} {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {release = resolve;});
  return { promise, release };
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

  it("makes no answer call when configured history runtime is absent", async () => {
    const answerGenerator = generator();
    const generate = vi.spyOn(answerGenerator, "generate");
    const answer = new AnswerGroundedMeetingQuestion({
      answers: new GroundedMeetingAnswer(answerGenerator, limits),
      historicalRequired: true,
      ids: { digest: () => "c".repeat(64) },
      live: live(),
      turnHashes: { hash: () => "b".repeat(64) },
    });

    await expect(answer.execute({ ...request,
      authorizationPrincipalRef: "opaque-principal" }, {
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      reason: "historical_authority_unavailable",
      status: "unavailable",
    });
    expect(generate).not.toHaveBeenCalled();
  });

});

describe("published grounded meeting question failure fencing", () => {
  it("keeps historical failure, revocation, and malformed outcomes fail closed",
    async () => {
      const historicalOutcomes: Array<() => Promise<unknown>> = [
        async () => ({ reason: "authorization_changed", status: "unavailable" }),
        async () => {throw new Error("synthetic historical timeout");},
        async () => ({ authorityGeneration: "", status: "current", turns: "malformed" }),
      ];
      for (const retrieve of historicalOutcomes) {
        const answerGenerator = generator();
        const generate = vi.spyOn(answerGenerator, "generate");
        const answer = new AnswerGroundedMeetingQuestion({
          answers: new GroundedMeetingAnswer(answerGenerator, limits),
          authorization: { authorize: async () => ({
            authorizationDigest: "authorization-1",
            authorizationEpoch: "epoch-1",
            authorized: true,
            policyVersion: "policy-1",
          }) },
          historical: { retrieve } as unknown as FocusedHistoricalEvidenceV2Port,
          historicalRequired: true,
          ids: { digest: () => "c".repeat(64) },
          live: live(),
          turnHashes: { hash: () => "b".repeat(64) },
        });

        await expect(answer.execute({
          ...request,
          authorizationPrincipalRef: "opaque-principal",
        }, { signal: new AbortController().signal })).resolves.toMatchObject({
          reason: "historical_authority_unavailable",
          status: "unavailable",
        });
        expect(generate).not.toHaveBeenCalled();
      }
    });
});

describe("published grounded meeting question authority fences", () => {

  it("regresses the host failure with independently useful mixed-lane generator evidence",
    async () => {
      const observedPlans: string[][] = [];
      const observedSources: (string | undefined)[][] = [];
      const historicalCompleted = barrier();
      const releaseLiveLookup = barrier();
      const liveQuery = mixedLaneLive();
      const searchHotTail = liveQuery.searchHotTail.bind(liveQuery);
      let firstLiveLookup = true;
      liveQuery.searchHotTail = async (input) => {
        if (firstLiveLookup) {
          firstLiveLookup = false;
          await releaseLiveLookup.promise;
        }
        return searchHotTail(input);
      };
      const retrieve = vi.fn<FocusedHistoricalEvidenceV2Port["retrieve"]>(
        async (input) => {
          expect(input.signal.aborted).toBe(false);
          historicalCompleted.release();
          return {
            authorityGeneration: "historical-generation-1",
            status: "current" as const,
            turns: [{
              endMs: 4_000,
              source: {
                historicalSource: {
                  candidateLocator: "opaque-locator",
                  indexGeneration: "index-generation-1",
                  releaseId: "release-1",
                },
                meetingId: "historical-meeting-1",
                sourceEndCodePoint: 31,
                sourceStartCodePoint: 0,
                transcriptId: "historical-transcript-1",
                transcriptVersion: 1,
              },
              speakerId: "opaque-actor",
              startMs: 3_000,
              text: "PINE-GOLF records that Project Atlas deployment was approved for Monday.",
              turnHash: "d".repeat(64),
              turnId: "historical-turn-1",
            }],
          };
        },
      );
      const historical: FocusedHistoricalEvidenceV2Port = {
        retrieve,
      };
      const generated: GroundedAnswerGenerator = {
        ...generator(),
        generate: async (generationRequest) => {
          observedPlans.push(generationRequest.plan.evidence.map(({ text }) => text));
          observedSources.push(generationRequest.plan.evidence.map(({ source }) =>
            source?.meetingId
          ));
          return {
            answer: {
              claims: [{ evidenceIds: ["evidence-000001", "evidence-000002"],
                text: "CURRENT-ANCHOR confirms Atlas is active; PINE-GOLF records Monday approval." }],
              locale: "en" as const,
              status: "answered" as const,
            },
            status: "completed" as const,
          };
        },
      };
      const answer = new AnswerGroundedMeetingQuestion({
        answers: new GroundedMeetingAnswer(generated, limits),
        authorization: { authorize: async () => ({
          authorizationDigest: "authorization-1",
          authorizationEpoch: "epoch-1",
          authorized: true,
          policyVersion: "policy-1",
        }) },
        historical,
        ids: { digest: () => "c".repeat(64) },
        live: liveQuery,
        turnHashes: { hash: () => "b".repeat(64) },
      });

      const execution = answer.execute({
        ...request,
        authorizationPrincipalRef: "opaque-principal",
        question: "What does CURRENT-ANCHOR confirm about Project Atlas, and which deployment day does PINE-GOLF record?",
      }, { signal: new AbortController().signal });
      await historicalCompleted.promise;
      releaseLiveLookup.release();
      await expect(execution).resolves.toMatchObject({
        status: "answered",
      });
      expect(observedPlans).toEqual([[
        "CURRENT-ANCHOR confirms Project Atlas is active.",
        "PINE-GOLF records that Project Atlas deployment was approved for Monday.",
      ]]);
      expect(observedPlans[0]?.[0]).not.toContain("PINE-GOLF");
      expect(observedPlans[0]?.[1]).not.toContain("CURRENT-ANCHOR");
      expect(observedSources).toEqual([[
        "meeting-1",
        "historical-meeting-1",
      ]]);
      expect(retrieve).toHaveBeenCalledTimes(3);
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

  it("propagates the active cancellation signal into authorization", async () => {
    const controller = new AbortController();
    const authorize = vi.fn<HistoricalAuthorizationPort["authorize"]>(async (authorizationRequest) => {
      expect(authorizationRequest.signal).toBe(controller.signal);
      controller.abort("barge-in");
      controller.signal.throwIfAborted();
      throw new Error("unreachable");
    });
    const answer = new AnswerGroundedMeetingQuestion({
      answers: new GroundedMeetingAnswer(generator(), limits),
      authorization: { authorize },
      ids: { digest: () => "c".repeat(64) },
      live: live(),
      turnHashes: { hash: () => "b".repeat(64) },
    });

    await expect(answer.execute({
      ...request,
      authorizationPrincipalRef: "opaque",
    }, { signal: controller.signal })).rejects.toBe("barge-in");
    expect(authorize).toHaveBeenCalledOnce();
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

});
