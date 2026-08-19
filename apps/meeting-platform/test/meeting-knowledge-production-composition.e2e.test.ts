import { createHash } from "node:crypto";

import {
  startDisposableInfinityHttpService,
  type DisposableInfinityHttpService,
} from "@discord-meeting/infinity-context-adapter/test-support";
import {
  AnswerGroundedMeetingQuestion,
  GroundedMeetingAnswer,
  HistoricalExhaustiveMemoryRetrieval,
  LiveFinalizedMemoryWorker,
  QuestionBinding,
  SameRoomFocusedMemoryRetrieval,
  createExhaustiveCoverageGroundingPlan,
  createFocusedRetrievalGroundingPlan,
  type HistoricalAuthorizationPort,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { LiveMeeting } from "@discord-meeting/meeting-core/live-meeting";
import type { MeetingSnapshot } from "@discord-meeting/meeting-core/meeting-lifecycle";
import {
  PostgresFinalReplyEvidence,
  PostgresFocusedMemoryRetrieval,
  PostgresLiveFinalizedMemoryLifecycle,
  PostgresLiveFinalizedMemoryQuery,
  PostgresLiveFinalizedMemoryStore,
  PostgresLiveMeetingRepository,
  PostgresMeetingRepository,
  PostgresMigrationRunner,
  canonicalFinalReplyTurnHash,
} from "@discord-meeting/postgres-adapter";
import { Pool } from "pg";
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import {
  type PlatformHistoricalMemoryRuntime,
} from "../src/composition/historical-memory.js";
import { MeetingKnowledgeGroundedAnswerAcl } from
  "../src/adapters/outbound/meeting-knowledge-grounded-answer-acl.js";
import { localFinalReplyPolicy } from "../src/composition/meeting-knowledge.js";
import {
  allowOnlySyntheticRoom,
  botApplicationIdentity,
  checkpointAttempts,
  currentMeeting,
  currentMeetingId,
  historicalMeetingId,
  historicalRows,
  historicalTwoHourMeeting,
  humanActorsFor,
  persistPublishedMeeting,
  positionalNeedles,
  requiredHistoricalRuntime,
  resultsContainerId,
  roomId,
  scopeId,
} from "./meeting-knowledge-production-composition-fixtures.js";
import { proveComposedGroundedVoice } from "./meeting-knowledge-composed-voice-e2e.js";
import { qualifyLiveProjectionReply } from "./meeting-knowledge-live-reply-e2e.js";
import {
  assertAggregateStageBudget,
  assertPersistedCoverageAnalysis,
  assertProviderWire,
  focusedReferenceKey,
  qualifySupersessionAndDeletion,
  runQualificationStage,
  waitForHistoricalRows,
  type QualificationStageTiming,
} from "./meeting-knowledge-production-composition-diagnostics.js";

const postgresImage = "postgres:18.4-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15";
const postgresPort = 5_432;
const qualificationOuterBudgetMs = 600_000;
const qualificationStageBudgets = Object.freeze({
  composedGroundedVoice: 100_000,
  focusedRetrievalRecall: 160_000,
  indexRestartReplay: 40_000,
  sharedFocusedAndExhaustiveAnswer: 160_000,
  liveProjectionReply: 30_000,
  supersessionAndDisabledDeletionDrain: 100_000,
});
assertAggregateStageBudget(
  qualificationOuterBudgetMs,
  Object.values(qualificationStageBudgets),
);
let container: StartedTestContainer | undefined;
let database: Pool | undefined;

describe("Meeting Knowledge production-composition qualification", () => {
  it("leases one provider attempt across selector, answer, and safety deadlines", () => {
    expect(localFinalReplyPolicy.jobLeaseSeconds).toBe(360);
  });

  it("degrades transient Infinity health without blocking application readiness", async () => {
    const transientPool = new Pool({
      connectionString: "postgresql://synthetic.invalid/never-connected",
    });
    const infinity = await startDisposableInfinityHttpService();
    const runtime = requiredHistoricalRuntime(
      transientPool,
      infinity,
      true,
      true,
    );
    await infinity.close();
    try {
      await expect(runtime.assertReady()).resolves.toBeUndefined();
      expect(runtime.searchEnabled()).toBe(false);
    } finally {
      await runtime.close();
      await transientPool.end();
    }
  });
});

describe("Meeting Knowledge mandatory PostgreSQL qualification", () => {
  beforeAll(async () => {
    container = await new GenericContainer(postgresImage)
      .withEnvironment({
        POSTGRES_DB: "meeting_knowledge_e2e",
        POSTGRES_PASSWORD: "synthetic-only",
        POSTGRES_USER: "meeting_knowledge_e2e",
      })
      .withExposedPorts(postgresPort)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/u, 2),
      )
      .withStartupTimeout(120_000)
      .start();
    database = new Pool({
      database: "meeting_knowledge_e2e",
      host: container.getHost(),
      password: "synthetic-only",
      port: container.getMappedPort(postgresPort),
      user: "meeting_knowledge_e2e",
    });
    await database.query("SELECT 1");
    await new PostgresMigrationRunner(database).migrate();
  }, 150_000);

  afterAll(async () => {
    await database?.end();
    await container?.stop();
  });

  it("runs two-hour Postgres -> official SDK HTTP -> local rehydrate -> shared answer -> supersede -> disabled deletion", async () => {
    const pool = requiredDatabase();
    const infinity = await startDisposableInfinityHttpService();
    let runtime: PlatformHistoricalMemoryRuntime | undefined;
    const timings: QualificationStageTiming[] = [];
    try {
      const indexed = await runQualificationStage(
        "index_restart_replay",
        qualificationStageBudgets.indexRestartReplay,
        timings,
        (signal) => indexAndRestart(pool, infinity, signal),
      );
      const qualifiedRuntime = indexed.runtime;
      runtime = qualifiedRuntime;
      const authorization = allowOnlySyntheticRoom();
      const historicalRetrieval = await runQualificationStage(
        "focused_retrieval_recall",
        qualificationStageBudgets.focusedRetrievalRecall,
        timings,
        (signal) => qualifyFocusedRetrieval(qualifiedRuntime, infinity, signal),
      );
      await runQualificationStage("shared_focused_and_exhaustive_answer", qualificationStageBudgets.sharedFocusedAndExhaustiveAnswer, timings, (signal) =>
        qualifySharedAnswers({
          authorization,
          current: indexed.current,
          historicalRetrieval,
          pool,
          runtime: qualifiedRuntime,
          signal,
        })
      );
      await runQualificationStage(
        "live_projection_reply",
        qualificationStageBudgets.liveProjectionReply,
        timings,
        (signal) => qualifyLiveProjectionReply({
          infinity,
          pool,
          runtime: qualifiedRuntime,
          signal,
        }),
      );
      await runQualificationStage("composed_grounded_voice", qualificationStageBudgets.composedGroundedVoice, timings, (signal) =>
        qualifyComposedGroundedVoice({
          current: indexed.current,
          pool,
          runtime: qualifiedRuntime,
          signal,
        })
      );
      await qualifiedRuntime.close();
      runtime = undefined;
      await runQualificationStage(
        "supersession_and_disabled_deletion_drain",
        qualificationStageBudgets.supersessionAndDisabledDeletionDrain,
        timings,
        (signal) => qualifySupersessionAndDeletion(
          pool,
          infinity,
          indexed.repository,
          indexed.historical,
          signal,
        ),
      );
      expect(timings.map(({ stage }) => stage)).toEqual([
        "index_restart_replay",
        "focused_retrieval_recall",
        "shared_focused_and_exhaustive_answer",
        "live_projection_reply",
        "composed_grounded_voice",
        "supersession_and_disabled_deletion_drain",
      ]);
      assertProviderWire(infinity, [scopeId, roomId, historicalMeetingId]);
    } finally {
      await runtime?.close();
      await infinity.close();
    }
  }, 600_000);
});

type FocusedHistoricalRetrieval = ReturnType<PlatformHistoricalMemoryRuntime["createFocusedRetrieval"]>;

interface IndexedComposition { readonly current: MeetingSnapshot; readonly historical: MeetingSnapshot; readonly repository: PostgresMeetingRepository; readonly runtime: PlatformHistoricalMemoryRuntime; }

async function indexAndRestart(
  pool: Pool,
  infinity: DisposableInfinityHttpService,
  signal: AbortSignal,
): Promise<IndexedComposition> {
  signal.throwIfAborted();
  const repository = new PostgresMeetingRepository(pool);
  const historical = await persistPublishedMeeting(
    repository,
    historicalTwoHourMeeting(),
  );
  const current = await persistPublishedMeeting(repository, currentMeeting());
  expect(historical.transcript?.turns.at(-2)?.endMs).toBe(7_200_000);
  infinity.endpoint.loseNextIngestResponse();
  infinity.endpoint.loseNextProcessResponse();
  const firstRuntime = requiredHistoricalRuntime(pool, infinity, true, true);
  await firstRuntime.assertReady();
  await firstRuntime.start();
  await waitForHistoricalRows(pool, ({ state }) => state === "applied", 2, signal);
  await firstRuntime.close();
  const initialRows = await historicalRows(pool);
  expect(initialRows.filter(({ state }) => state === "applied")).toHaveLength(2);
  const indexedAfterFirstPass = infinity.endpoint.documentCount();
  expect(indexedAfterFirstPass).toBeGreaterThan(2);
  expect(infinity.endpoint.indexedTexts().join("\n"))
    .not.toContain("BOTIK INTERIM TRANSCRIPT MUST NEVER BE INDEXED");

  const runtime = requiredHistoricalRuntime(pool, infinity, true, true);
  expect(runtime.searchEnabled()).toBe(false);
  expect(runtime.servingAuthorized()).toBe(false);
  await runtime.assertReady();
  expect(runtime.searchEnabled()).toBe(true);
  expect(runtime.servingAuthorized()).toBe(true);
  expect(infinity.endpoint.documentCount()).toBe(indexedAfterFirstPass);
  return { current, historical, repository, runtime };
}

async function qualifyFocusedRetrieval(
  runtime: PlatformHistoricalMemoryRuntime,
  infinity: DisposableInfinityHttpService,
  signal: AbortSignal,
): Promise<FocusedHistoricalRetrieval> {
  const historicalRetrieval = runtime.createFocusedRetrieval(
    allowOnlySyntheticRoom(),
  );
  let recalled = 0;
  for (const needle of positionalNeedles) {
    const result = await historicalRetrieval.buildPlan({
      authorizationPrincipalRef: "synthetic-principal",
      currentMeetingId,
      question: `Where was positional marker ${needle.marker} discussed?`,
      roomId,
      signal,
      scopeId,
      searchEnabled: runtime.searchEnabled(),
      servingAuthorized: runtime.servingAuthorized(),
      sourceSet: "historical",
    });
    if (
      result.status === "ready" &&
      result.plan.blocks.slice(0, 5).some(({ turns }) =>
        turns.some(({ text }) => text.includes(needle.marker))
      )
    ) {
      recalled += 1;
    }
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.plan.blocks.length).toBeLessThan(25);
      expect(result.plan.selection)
        .toBe("locally_rehydrated_focused_blocks_only");
      expect(result.plan.sources.some(({ providerScore }) =>
        typeof providerScore === "number"
      )).toBe(true);
      expect(JSON.stringify(result.plan.blocks))
        .not.toContain("UNTRUSTED SDK CHUNK TEXT");
    }
  }
  expect({
    generationInvocations: 0,
    queries: positionalNeedles.length,
    recallAt5: recalled / positionalNeedles.length,
  }).toEqual({ generationInvocations: 0, queries: 7, recallAt5: 1 });
  await expect(historicalRetrieval.buildPlan({
    authorizationPrincipalRef: "synthetic-principal",
    currentMeetingId,
    question: "Meteorological zephyr calibration?",
    roomId,
    signal,
    scopeId,
    searchEnabled: runtime.searchEnabled(),
    servingAuthorized: runtime.servingAuthorized(),
    sourceSet: "historical",
  })).resolves.toMatchObject({ status: "insufficient_evidence" });

  const requestsBeforeCrossRoom = infinity.endpoint.requests.length;
  await expect(historicalRetrieval.buildPlan({
    authorizationPrincipalRef: "synthetic-principal",
    currentMeetingId,
    question: "Where was PINE-GOLF discussed?",
    roomId: "555555555555555555",
    signal,
    scopeId,
    searchEnabled: runtime.searchEnabled(),
    servingAuthorized: runtime.servingAuthorized(),
    sourceSet: "historical",
  })).resolves.toMatchObject({ status: "unauthorized" });
  expect(infinity.endpoint.requests).toHaveLength(requestsBeforeCrossRoom);
  await qualifyRetrievalRevocation(runtime, signal);
  return historicalRetrieval;
}

async function qualifyRetrievalRevocation(
  runtime: PlatformHistoricalMemoryRuntime,
  signal: AbortSignal,
): Promise<void> {
  let observations = 0;
  const revoked: HistoricalAuthorizationPort = {
    authorize: async () => {
      observations += 1;
      return {
        authorizationDigest: `authorization-${observations}`,
        authorizationEpoch: String(observations),
        authorized: observations === 1,
        policyVersion: "synthetic-room-policy.v1",
      };
    },
  };
  await expect(runtime.createFocusedRetrieval(revoked).buildPlan({
    authorizationPrincipalRef: "synthetic-principal",
    currentMeetingId,
    question: "Where was PINE-GOLF discussed?",
    roomId,
    signal,
    scopeId,
    searchEnabled: runtime.searchEnabled(),
    servingAuthorized: runtime.servingAuthorized(),
    sourceSet: "historical",
  })).resolves.toMatchObject({ status: "unauthorized" });
  expect(observations).toBe(2);
}

async function qualifySharedAnswers(input: {
  readonly authorization: HistoricalAuthorizationPort;
  readonly current: MeetingSnapshot;
  readonly historicalRetrieval: FocusedHistoricalRetrieval;
  readonly pool: Pool;
  readonly runtime: PlatformHistoricalMemoryRuntime;
  readonly signal: AbortSignal;
}): Promise<void> {
  input.signal.throwIfAborted();
  const evidence = new PostgresFinalReplyEvidence(
    input.pool,
    botApplicationIdentity,
  );
  const currentAuthority = await evidence.findCurrentBinding({
    finalProjectionReceipt: input.current.publication?.externalPublicationId ?? "",
    projectionTargetContainerId: resultsContainerId,
  });
  if (currentAuthority === null) {
    throw new Error("synthetic current meeting did not yield final-reply authority");
  }
  const binding = QuestionBinding.create({
    authorizationDigest: "a".repeat(64),
    authorizationPolicyVersion: "synthetic-room-policy.v1",
    authorizationPrincipalRef: "synthetic-principal",
    ...currentAuthority,
    deliveryContainerId: currentAuthority.projectionTargetContainerId,
    expectedLocale: "en",
    policyVersion: "meeting-knowledge.focused-memory-final-reply.v2",
    questionHash: "b".repeat(64),
    questionId: "synthetic-question-1",
    requesterSubject: "c".repeat(64),
  }).toSnapshot();
  const sameRoom = new SameRoomFocusedMemoryRetrieval({
    current: new PostgresFocusedMemoryRetrieval(
      input.pool,
      botApplicationIdentity,
    ),
    historical: input.historicalRetrieval,
    turnHashes: { hash: canonicalFinalReplyTurnHash },
  }, {
    historicalServingAuthorized: () => input.runtime.servingAuthorized(),
    remoteSearchAvailable: () => input.runtime.searchEnabled(),
  });
  const merged = await sameRoom.retrieve({
    authorizationPrincipalRef: binding.authorizationPrincipalRef,
    canonicalEvidenceHash: binding.canonicalEvidenceHash,
    expectedAuthorityGeneration: binding.memoryGeneration,
    finalProjectionReceipt: binding.finalProjectionReceipt,
    maximumCandidates: 8,
    meetingId: binding.meetingId,
    meetingRevision: binding.meetingRevision,
    neighborTurns: 1,
    projectionTargetContainerId: binding.projectionTargetContainerId,
    question: "What connects CURRENT-ANCHOR and PINE-GOLF?",
    roomId: binding.roomId,
    scopeId: binding.scopeId,
    transcriptId: binding.transcriptId,
    transcriptVersion: binding.transcriptVersion,
  });
  expect(merged.status).toBe("current");
  if (merged.status !== "current") {
    throw new Error("same-room retrieval unexpectedly failed");
  }
  expect(merged.candidates.length).toBeLessThanOrEqual(8);
  expect(new Set(merged.candidates.map(({ meetingId }) => meetingId)))
    .toEqual(new Set([currentMeetingId, historicalMeetingId]));
  expect(merged.candidates[0]?.meetingId).toBe(currentMeetingId);
  expect(merged.candidates[1]?.meetingId).toBe(historicalMeetingId);
  const hydrationReferences = [...new Map(merged.candidates.map((reference) => [
    focusedReferenceKey(reference),
    reference,
  ])).values()];
  const hydrated = await evidence.rehydrateSelectedEvidence(
    binding,
    hydrationReferences,
  );
  if (hydrated.status !== "current") {
    throw new Error("same-room candidates did not rehydrate locally");
  }
  expect(hydrated.turns).toHaveLength(hydrationReferences.length);
  expect(JSON.stringify(hydrated.turns)).not.toContain("UNTRUSTED SDK");
  const focusedPlan = createFocusedRetrievalGroundingPlan({
    authorityGeneration: merged.authorityGeneration,
    coverage: "sufficient",
    humanActorIds: humanActorsFor(hydrated.turns, binding.humanActorIds),
    turns: hydrated.turns,
  });
  expect(focusedPlan.mode).toBe("focused_retrieval");
  await qualifyFocusedAndExhaustiveGeneration({
    authorization: input.authorization,
    binding,
    evidence,
    focusedPlan,
    pool: input.pool,
    runtime: input.runtime,
    signal: input.signal,
  });
}

async function qualifyFocusedAndExhaustiveGeneration(input: {
  readonly authorization: HistoricalAuthorizationPort;
  readonly binding: ReturnType<QuestionBinding["toSnapshot"]>;
  readonly evidence: PostgresFinalReplyEvidence;
  readonly focusedPlan: ReturnType<typeof createFocusedRetrievalGroundingPlan>;
  readonly pool: Pool;
  readonly runtime: PlatformHistoricalMemoryRuntime;
  readonly signal: AbortSignal;
}): Promise<void> {
  let generationInvocations = 0;
  let lastGenerationMode: string | undefined;
  const sharedAnswer = new GroundedMeetingAnswer({
    generate: async (request) => {
      generationInvocations += 1;
      lastGenerationMode = request.plan.mode;
      return {
        answer: {
          claims: [{
            evidenceIds: request.plan.mode === "exhaustive_coverage"
              ? request.plan.evidence.map(({ evidenceId }) => evidenceId)
              : [request.plan.evidence[0]?.evidenceId ?? ""],
            text: request.plan.mode === "exhaustive_coverage"
              ? "Exactly seven positional marker turns occur in the complete authorized corpus."
              : "The bounded local evidence connects current and historical context.",
          }],
          locale: "en" as const,
          status: "answered" as const,
        },
        status: "completed" as const,
      };
    },
    measure: async (request) => ({
      inputTokens: Math.ceil(JSON.stringify(request).length / 4),
      requestBytes: new TextEncoder().encode(JSON.stringify(request)).byteLength,
      runtimeProfile: "synthetic-shared-grounded-answer.v1",
    }),
  }, localFinalReplyPolicy.groundingSafety);
  const focusedAnswer = await sharedAnswer.execute({
    attemptId: "synthetic-focused-attempt-1",
    binding: input.binding,
    locale: "en",
    plan: input.focusedPlan,
    question: "What connects CURRENT-ANCHOR and PINE-GOLF?",
  });
  expect(focusedAnswer.status).toBe("completed");
  if (focusedAnswer.status === "completed") {
    expect(focusedAnswer.answer.claims[0]?.evidenceIds).toEqual([
      input.focusedPlan.evidence[0]?.evidenceId,
    ]);
  }
  const exhaustiveMemory = new HistoricalExhaustiveMemoryRetrieval(
    input.runtime.createExhaustiveCoverage(input.authorization),
    { hash: canonicalFinalReplyTurnHash },
  );
  const exhaustiveRequest = {
    authorizationPrincipalRef: input.binding.authorizationPrincipalRef,
    expectedAuthorityGeneration: input.binding.memoryGeneration,
    question: "Count every positional marker across all meetings",
    requestId: "synthetic-exhaustive-request-1",
    roomId,
    scopeId,
  } as const;
  const exhaustive = await exhaustiveMemory.retrieve({
    ...exhaustiveRequest,
    signal: input.signal,
  });
  if (exhaustive.status !== "current") {
    throw new Error("exhaustive coverage did not reach synthesis");
  }
  expect(exhaustive.coverageBitmap.every(Boolean)).toBe(true);
  const uniqueAuthorizedSlices = await assertPersistedCoverageAnalysis(
    input.pool,
    scopeId,
    roomId,
    input.signal,
  );
  expect(exhaustive.coverageReduction.payload).toMatchObject({
    turnsReviewed: uniqueAuthorizedSlices,
  });
  expect(exhaustive.candidates.length).toBeLessThanOrEqual(256);
  expect(exhaustive.candidates).toContainEqual(expect.objectContaining({
    turnId: "history-turn-0719",
  }));
  const hydrated = await input.evidence.rehydrateSelectedEvidence(
    input.binding,
    exhaustive.candidates,
  );
  if (hydrated.status !== "current") {
    throw new Error("exhaustive candidates did not rehydrate locally");
  }
  const exhaustivePlan = createExhaustiveCoverageGroundingPlan({
    authorityGeneration: exhaustive.authorityGeneration,
    coverageBitmap: exhaustive.coverageBitmap,
    coveragePlanDigest: exhaustive.coveragePlanDigest,
    coverageReduction: exhaustive.coverageReduction,
    humanActorIds: humanActorsFor(hydrated.turns, input.binding.humanActorIds),
    turns: hydrated.turns,
  });
  const attemptsBeforeReplay = await checkpointAttempts(input.pool);
  const exhaustiveAnswer = await sharedAnswer.execute({
    attemptId: "synthetic-exhaustive-attempt-1",
    binding: input.binding,
    locale: "en",
    plan: exhaustivePlan,
    question: exhaustiveRequest.question,
  }, {
    beforeGenerate: async () => "continue",
  });
  expect(exhaustiveAnswer).toMatchObject({ status: "completed" });
  if (exhaustiveAnswer.status === "completed") {
    expect(exhaustiveAnswer.answer.toSnapshot()).toEqual({
      claims: [{
        evidenceIds: exhaustivePlan.evidence.map(({ evidenceId }) => evidenceId),
        text: "Exactly seven positional marker turns occur in the complete authorized corpus.",
      }],
      locale: "en",
      status: "answered",
    });
  }
  expect(lastGenerationMode).toBe("exhaustive_coverage");
  await expect(exhaustiveMemory.retrieve({ ...exhaustiveRequest, signal: input.signal }))
    .resolves.toMatchObject({ status: "current" });
  expect(await checkpointAttempts(input.pool)).toEqual(attemptsBeforeReplay);
  expect(generationInvocations).toBe(2);
}

async function qualifyComposedGroundedVoice(input: {
  readonly current: MeetingSnapshot;
  readonly pool: Pool;
  readonly runtime: PlatformHistoricalMemoryRuntime;
  readonly signal: AbortSignal;
}): Promise<void> {
  input.signal.throwIfAborted();
  if (input.current.transcript === null) {
    throw new Error("synthetic current meeting has no transcript for live memory");
  }
  const participantId = "human-current";
  const liveMeetings = new PostgresLiveMeetingRepository(input.pool);
  await liveMeetings.save(LiveMeeting.start({
    meetingId: currentMeetingId,
    publicationTargetId: resultsContainerId,
    startedAtMs: 0,
  }).toSnapshot(), null);
  for (const turn of input.current.transcript.turns) {
    await liveMeetings.appendFinalizedTurn(currentMeetingId, turn);
  }
  const lifecycle = new PostgresLiveFinalizedMemoryLifecycle(input.pool);
  await expect(lifecycle.registerMeeting({
    actors: [{ actorId: participantId, kind: "human" }],
    identityProvenance: {
      actorObservationState: "consistent",
      actorSemanticsVersion: 1,
      producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
      producerRevision: "f".repeat(40),
      rosterState: "unsealed",
    },
    lifecycleGeneration: 3,
    meetingId: currentMeetingId,
    roomId,
    scopeId,
  })).resolves.toBe("accepted");
  const liveWorker = new LiveFinalizedMemoryWorker(
    new PostgresLiveFinalizedMemoryStore(input.pool),
    { hash: canonicalFinalReplyTurnHash },
  );
  for (;;) {
    const projected = await liveWorker.executeOnce({ meetingId: currentMeetingId });
    if (projected.status === "idle") {
      break;
    }
    expect(projected.status).toBe("applied");
  }
  const live = new PostgresLiveFinalizedMemoryQuery(input.pool);
  await expect(live.resolveContext({
    meetingId: currentMeetingId,
    requesterActorId: participantId,
    roomId,
  })).resolves.toMatchObject({
    appliedGeneration: input.current.transcript.turns.length,
    sourceGeneration: input.current.transcript.turns.length,
  });

  const authorization = allowOnlySyntheticRoom();
  // Avoid treating the fixture label "current" as a semantic query term: every
  // ordinary current-meeting turn contains that word, which deliberately makes
  // the bounded hot-tail selector fall back to full-transcript coverage.
  const question = "how does ANCHOR connect to PINE-GOLF?";
  const liveSearch = await live.searchHotTail({
    maximumCandidates: 24,
    meetingId: currentMeetingId,
    neighborTurns: 2,
    question,
    requesterActorId: participantId,
    roomId,
    scopeId,
  });
  expect(liveSearch).toMatchObject({ status: "current" });
  if (liveSearch.status !== "current") {
    throw new Error(`live finalized search was ${liveSearch.status}`);
  }
  const liveEvidence = await live.rehydrateHotTail({
    candidates: liveSearch.candidates,
    expectedGeneration: liveSearch.context.sourceGeneration,
    meetingId: currentMeetingId,
    requesterActorId: participantId,
    roomId,
    scopeId,
  });
  expect(liveEvidence).toMatchObject({ status: "current" });
  if (liveEvidence.status === "current") {
    expect(liveEvidence.turns.map(({ text }) => text)).toContain(
      "CURRENT-ANCHOR confirms Project Atlas is active and connects to PINE-GOLF.",
    );
  }
  let validatedAnswers = 0;
  let qualifiedModelCalls = 0;
  let lastGenerationMarkers = { current: false, historical: false };
  let lastCurrentTexts: readonly string[] = [];
  const groundedAnswer = new GroundedMeetingAnswer({
    generate: async (request) => {
      qualifiedModelCalls += 1;
      const currentEvidence = request.plan.evidence.find(({ source, text }) =>
        source?.meetingId === currentMeetingId && text.includes("CURRENT-ANCHOR")
      );
      const historicalEvidence = request.plan.evidence.find(({ source, text }) =>
        source?.meetingId === historicalMeetingId && text.includes("PINE-GOLF")
      );
      lastCurrentTexts = request.plan.evidence
        .filter(({ source }) => source?.meetingId === currentMeetingId)
        .map(({ text }) => text);
      lastGenerationMarkers = {
        current: currentEvidence !== undefined,
        historical: historicalEvidence !== undefined,
      };
      return {
        answer: {
          claims: [{
            evidenceIds: [currentEvidence, historicalEvidence]
              .filter((evidence) => evidence !== undefined)
              .map(({ evidenceId }) => evidenceId),
            text: "CURRENT-ANCHOR links Project Atlas to historical PINE-GOLF evidence.",
          }],
          locale: "en" as const,
          status: "answered" as const,
        },
        status: "completed" as const,
      };
    },
    measure: async (request) => ({
      inputTokens: Math.ceil(JSON.stringify(request).length / 4),
      requestBytes: new TextEncoder().encode(JSON.stringify(request)).byteLength,
      runtimeProfile: "qualified-deterministic-composed-grounding.v1",
    }),
  }, localFinalReplyPolicy.groundingSafety);
  const published = new AnswerGroundedMeetingQuestion({
    answers: groundedAnswer,
    authorization,
    focusedHistorical: input.runtime.createFocusedRetrieval(authorization),
    historicalSearchEnabled: () => input.runtime.searchEnabled(),
    historicalServingAuthorized: () => input.runtime.servingAuthorized(),
    ids: {
      digest: (namespace, parts) => createHash("sha256")
        .update(JSON.stringify([namespace, ...parts]), "utf8")
        .digest("hex"),
    },
    live,
    turnHashes: { hash: canonicalFinalReplyTurnHash },
  });
  const directAnswer = await published.execute({
    activeParticipantId: participantId,
    authorizationPrincipalRef: "synthetic-principal",
    locale: "en-US",
    meetingId: currentMeetingId,
    question,
    roomId,
  }, { signal: input.signal });
  expect(lastCurrentTexts).toContain(
    "CURRENT-ANCHOR confirms Project Atlas is active and connects to PINE-GOLF.",
  );
  expect(lastGenerationMarkers).toEqual({ current: true, historical: true });
  expect(directAnswer).toMatchObject({ status: "answered" });
  if (directAnswer.status !== "answered") {
    throw new Error(`composed grounded answer was ${directAnswer.status}`);
  }
  await expect(published.recheckPlaybackAuthority({
    activeParticipantId: participantId,
    authorizationPrincipalRef: "synthetic-principal",
    citationTurnIds: directAnswer.answer.citations.map(({ turnId }) => turnId),
    evidenceEpoch: directAnswer.answer.evidenceEpoch,
    knowledgeEpoch: directAnswer.answer.knowledgeEpoch,
    locale: "en-US",
    meetingId: currentMeetingId,
    question,
    roomId,
  }, { signal: input.signal })).resolves.toEqual({
    schemaVersion: 1,
    status: "current",
  });
  qualifiedModelCalls = 0;
  const playbackAuthorityResults: unknown[] = [];
  const groundedAnswers = new MeetingKnowledgeGroundedAnswerAcl({
    execute: async (request, options) => {
      const result = await published.execute({
        ...request,
        authorizationPrincipalRef: "synthetic-principal",
      }, options);
      if (result.status === "answered") {
        validatedAnswers += 1;
      }
      return result;
    },
    recheckPlaybackAuthority: async (request, options) => {
      const result = await published.recheckPlaybackAuthority({
        ...request,
        authorizationPrincipalRef: "synthetic-principal",
      }, options);
      playbackAuthorityResults.push(result);
      return result;
    },
  });
  try {
    await proveComposedGroundedVoice({
      groundedAnswers,
      meetingId: currentMeetingId,
      participantId,
      question,
      roomId,
      validatedAnswerCount: () => validatedAnswers,
    });
  } catch (error) {
    throw new Error(
      `composed voice failed after playback authority results ${JSON.stringify(playbackAuthorityResults)}`,
      { cause: error },
    );
  }
  expect(validatedAnswers).toBe(2);
  expect(qualifiedModelCalls).toBe(2);
}

function requiredDatabase(): Pool {
  if (database === undefined) { throw new Error("mandatory PostgreSQL qualification database was not initialized"); }
  return database;
}
