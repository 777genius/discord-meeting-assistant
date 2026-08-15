import {
  startDisposableInfinityHttpService,
  type DisposableInfinityHttpService,
} from "@discord-meeting/infinity-context-adapter/test-support";
import {
  GroundedMeetingAnswer,
  HistoricalExhaustiveMemoryRetrieval,
  QuestionBinding,
  SameRoomFocusedMemoryRetrieval,
  createExhaustiveCoverageGroundingPlan,
  createFocusedRetrievalGroundingPlan,
  type FocusedMemoryReference,
  type HistoricalAuthorizationPort,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { MeetingSnapshot } from "@discord-meeting/meeting-core/meeting-lifecycle";
import {
  PostgresFinalReplyEvidence,
  PostgresFocusedMemoryRetrieval,
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

function focusedReferenceKey(reference: FocusedMemoryReference): string {
  return [
    reference.meetingId,
    reference.transcriptId,
    reference.transcriptVersion,
    reference.turnId,
    reference.turnHash,
  ].join("\u0000");
}

import {
  type PlatformHistoricalMemoryRuntime,
} from "../src/composition/historical-memory.js";
import { localFinalReplyPolicy } from "../src/composition/meeting-knowledge.js";
import {
  allowOnlySyntheticRoom,
  botApplicationIdentity,
  checkpointAttempts,
  correctedHistoricalSnapshot,
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

const postgresImage = "postgres:18.4-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15";
const postgresPort = 5_432;
let container: StartedTestContainer | undefined;
let database: Pool | undefined;

describe("Meeting Knowledge production-composition qualification", () => {
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
    try {
      const indexed = await indexAndRestart(pool, infinity);
      runtime = indexed.runtime;
      const authorization = allowOnlySyntheticRoom();
      const historicalRetrieval = await qualifyFocusedRetrieval(
        runtime,
        infinity,
      );
      await qualifySharedAnswers({
        authorization,
        current: indexed.current,
        historicalRetrieval,
        pool,
        runtime,
      });
      await runtime.close();
      runtime = undefined;
      await qualifySupersessionAndDeletion(
        pool,
        infinity,
        indexed.repository,
        indexed.historical,
      );
      assertProviderWire(infinity);
    } finally {
      await runtime?.close();
      await infinity.close();
    }
  }, 180_000);
});

type FocusedHistoricalRetrieval = ReturnType<
  PlatformHistoricalMemoryRuntime["createFocusedRetrieval"]
>;

interface IndexedComposition {
  readonly current: MeetingSnapshot;
  readonly historical: MeetingSnapshot;
  readonly repository: PostgresMeetingRepository;
  readonly runtime: PlatformHistoricalMemoryRuntime;
}

async function indexAndRestart(
  pool: Pool,
  infinity: DisposableInfinityHttpService,
): Promise<IndexedComposition> {
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
  await firstRuntime.close();
  const initialRows = await historicalRows(pool);
  expect(initialRows.filter(({ state }) => state === "applied")).toHaveLength(2);
  const indexedAfterFirstPass = infinity.endpoint.documentCount();
  expect(indexedAfterFirstPass).toBeGreaterThan(2);
  expect(infinity.endpoint.indexedTexts().join("\n"))
    .not.toContain("BOTIK INTERIM TRANSCRIPT MUST NEVER BE INDEXED");

  const runtime = requiredHistoricalRuntime(pool, infinity, true, true);
  await runtime.assertReady();
  await runtime.start();
  expect(infinity.endpoint.documentCount()).toBe(indexedAfterFirstPass);
  return { current, historical, repository, runtime };
}

async function qualifyFocusedRetrieval(
  runtime: PlatformHistoricalMemoryRuntime,
  infinity: DisposableInfinityHttpService,
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
    scopeId,
    searchEnabled: runtime.searchEnabled(),
    servingAuthorized: runtime.servingAuthorized(),
    sourceSet: "historical",
  })).resolves.toMatchObject({ status: "unauthorized" });
  expect(infinity.endpoint.requests).toHaveLength(requestsBeforeCrossRoom);
  await qualifyRetrievalRevocation(runtime);
  return historicalRetrieval;
}

async function qualifyRetrievalRevocation(
  runtime: PlatformHistoricalMemoryRuntime,
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
}): Promise<void> {
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
  });
}

async function qualifyFocusedAndExhaustiveGeneration(input: {
  readonly authorization: HistoricalAuthorizationPort;
  readonly binding: ReturnType<QuestionBinding["toSnapshot"]>;
  readonly evidence: PostgresFinalReplyEvidence;
  readonly focusedPlan: ReturnType<typeof createFocusedRetrievalGroundingPlan>;
  readonly pool: Pool;
  readonly runtime: PlatformHistoricalMemoryRuntime;
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
  const exhaustive = await exhaustiveMemory.retrieve(exhaustiveRequest);
  if (exhaustive.status !== "current") {
    throw new Error("exhaustive coverage did not reach synthesis");
  }
  expect(exhaustive.coverageBitmap.every(Boolean)).toBe(true);
  expect(exhaustive.coverageReduction.payload).toMatchObject({ turnsReviewed: 736 });
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
  await expect(exhaustiveMemory.retrieve(exhaustiveRequest))
    .resolves.toMatchObject({ status: "current" });
  expect(await checkpointAttempts(input.pool)).toEqual(attemptsBeforeReplay);
  expect(generationInvocations).toBe(2);
}

async function qualifySupersessionAndDeletion(
  pool: Pool,
  infinity: DisposableInfinityHttpService,
  repository: PostgresMeetingRepository,
  historical: MeetingSnapshot,
): Promise<void> {
  const corrected = correctedHistoricalSnapshot(historical);
  await repository.save(corrected, historical.revision);
  infinity.endpoint.loseNextDocumentDeleteResponse();
  const superseding = requiredHistoricalRuntime(pool, infinity, true, true);
  await superseding.assertReady();
  await superseding.start();
  await superseding.close();
  const correctedText = infinity.endpoint.indexedTexts().join("\n");
  expect(correctedText).toContain("PINE-GOLF-V2");
  expect(correctedText).not.toMatch(/PINE-GOLF(?:\s|$)/u);
  const supersededRows = (await historicalRows(pool)).filter(({ meeting_id }) =>
    meeting_id === historicalMeetingId
  );
  expect(supersededRows.map(({ state }) => state).toSorted())
    .toEqual(["applied", "deleted"]);

  const deleting = requiredHistoricalRuntime(pool, infinity, false, false);
  expect(deleting.servingAuthorized()).toBe(false);
  expect(deleting.searchEnabled()).toBe(false);
  await deleting.requestMeetingDeletion(historicalMeetingId);
  infinity.endpoint.loseNextThreadDeleteResponse();
  await deleting.start();
  await deleting.close();
  expect((await historicalRows(pool)).filter(({ meeting_id }) =>
    meeting_id === historicalMeetingId
  ).every(({ state }) => state === "deleted")).toBe(true);
  expect(infinity.endpoint.indexedTexts().join("\n"))
    .not.toContain("PINE-GOLF-V2");
  expect(infinity.endpoint.documentCount()).toBeGreaterThan(0);
}

function assertProviderWire(infinity: DisposableInfinityHttpService): void {
  const paths = infinity.endpoint.requests.map(({ method, path }) =>
    `${method} ${path}`
  );
  expect(paths).toEqual(expect.arrayContaining([
    "GET /v1/capabilities",
    "POST /v1/documents",
    "POST /v1/search",
    "DELETE /v1/thread-memory",
    "POST /v1/thread-memory/status",
  ]));
  const wire = JSON.stringify(infinity.endpoint.requests);
  expect(wire).not.toContain(scopeId);
  expect(wire).not.toContain(roomId);
  expect(wire).not.toContain(historicalMeetingId);
}

function requiredDatabase(): Pool {
  if (database !== undefined) {
    return database;
  }
  throw new Error("mandatory PostgreSQL qualification database was not initialized");
}
