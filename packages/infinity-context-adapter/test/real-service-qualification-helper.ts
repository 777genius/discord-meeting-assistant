import { createHash } from "node:crypto";

import { expect } from "vitest";

import {
  DeterministicExhaustiveCoverageExtraction,
  ExhaustiveCoverage,
  GroundedMeetingAnswer,
  HistoricalExhaustiveMemoryRetrieval,
  HistoricalFocusedRetrieval,
  HistoricalSyncWorker,
  buildHistoricalIndexPlan,
  createExhaustiveCoverageGroundingPlan,
  type AcceptedFinalMeetingV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";

import {
  HmacHistoricalOpaqueIds,
  InfinityContextHistoricalMemoryAdapter,
} from "../src/index.js";
import {
  MemoryCoverageCheckpoints,
  MemoryHistoricalAuthority,
  MemoryHistoricalStore,
} from "./historical-e2e-test-kit.js";
import {
  QUALIFICATION_CORPUS_TURN_COUNT,
  combinedQualificationMeeting,
  forbiddenPromptMaterial,
  qualificationFacts,
  qualificationQuestions,
} from "./infinity-context-qualification-corpus.js";

const blockPolicy = {
  maxBlockUtf8Bytes: 1_536,
  maxBlocksPerMeeting: 100,
  maxTurnsPerBlock: 64,
  version: "meeting-knowledge.block-policy.v1",
} as const;
const firstFocusedQuestion: string = requiredFirstFocusedQuestion();

export interface RealServiceQualificationConfig {
  readonly baseUrl: string;
  readonly requestTimeoutMs: number;
  readonly token?: string;
}

export interface RealServiceQualificationMetrics {
  readonly boundedModelInput: {
    readonly evidenceCount: number;
    readonly inputTokens: number;
    readonly maximumRequestBytes: number;
    readonly requestBytes: number;
    readonly requestSha256: string;
  };
  readonly exhaustive: {
    readonly absenceEvidenceCount: number;
    readonly allEvidenceCount: number;
    readonly blocksReviewed: number;
    readonly countEvidenceCount: number;
    readonly turnsReviewed: number;
    readonly universalEvidenceCount: number;
  };
  readonly exhaustiveBlockCount: number;
  readonly focusedQuestionCount: number;
  readonly focusedRecallAt: 5;
  readonly remoteCleanupVerified: true;
  readonly turnCount: number;
}

export async function runRealServiceQualification(
  config: RealServiceQualificationConfig,
): Promise<RealServiceQualificationMetrics> {
  const ids = new HmacHistoricalOpaqueIds(new Uint8Array(32).fill(0xa5));
  const authority = new MemoryHistoricalAuthority();
  const store = new MemoryHistoricalStore();
  const meeting = combinedQualificationMeeting();
  const adapter = new InfinityContextHistoricalMemoryAdapter({
    baseUrl: config.baseUrl,
    requestTimeoutMs: config.requestTimeoutMs,
    schemaVersion: 1,
    ...(config.token === undefined ? {} : { token: config.token }),
  });
  const worker = new HistoricalSyncWorker({ authority, ids, memory: adapter, store }, {
    blockPolicy,
    leaseDurationMs: 120_000,
    maximumIndexAttempts: 3,
    retryBackoffMs: [1_000, 5_000],
    version: "meeting-knowledge.historical-sync.v1",
  });

  expect(meeting.humanTurns).toHaveLength(QUALIFICATION_CORPUS_TURN_COUNT);
  expect(meeting.humanTurns.at(-1)?.endMs).toBe(8_420_000);
  authority.put(meeting);
  await store.acceptRelease(meeting.binding);

  let boundedModelInput: RealServiceQualificationMetrics["boundedModelInput"] | null = null;
  let exhaustiveMetrics: RealServiceQualificationMetrics["exhaustive"] | null = null;
  let cleanupRequested = false;
  try {
    let capabilities: Awaited<ReturnType<
      InfinityContextHistoricalMemoryAdapter["qualifyCapabilities"]
    >>;
    try {
      capabilities = await adapter.qualifyCapabilities();
    } catch (error) {
      throw new Error(
        `real Infinity Context E2E could not reach or authenticate to ${config.baseUrl}`,
        { cause: error },
      );
    }
    expect(capabilities.supports_qdrant).toBe(true);
    expect(capabilities.enabled_adapters).toContain("qdrant");
    expect(officialQdrantCapability(capabilities)).toMatchObject({
      enabled: true,
      healthy: true,
      supports_search: true,
      supports_upsert: true,
    });

    await expect(worker.executeOnce({ indexingEnabled: true })).resolves.toMatchObject({
      operation: "index",
      status: "applied",
    });
    const localPlan = buildHistoricalIndexPlan(meeting, ids, blockPolicy);
    expect(localPlan.documents.length).toBeGreaterThan(5);

    let authorizationCalls = 0;
    const focused = focusedRetrieval(adapter, authority, store, ids, async () => {
      authorizationCalls += 1;
      return true;
    });
    await assertFocusedHybridRecall(focused, meeting, localPlan);
    expect(authorizationCalls).toBeGreaterThanOrEqual(qualificationQuestions.focused.length);

    const denied = focusedRetrieval(adapter, authority, store, ids, async () => false);
    await expect(denied.buildPlan({
      authorizationPrincipalRef: "denied-principal",
      currentMeetingId: meeting.binding.meetingId,
      question: firstFocusedQuestion,
      roomId: meeting.binding.roomId,
      scopeId: meeting.binding.scopeId,
      searchEnabled: true,
      servingAuthorized: true,
      sourceSet: "current",
    })).resolves.toMatchObject({ status: "unauthorized" });

    const exhaustive = exhaustiveRetrieval(authority, store, ids);
    const all = await retrieveExhaustively(exhaustive, meeting, qualificationQuestions.all, "all");
    expect(all.coverageBitmap).toHaveLength(localPlan.documents.length);
    expect(all.coverageBitmap.every(Boolean)).toBe(true);
    expect(all.coverageReduction.payload).toMatchObject({
      blocksReviewed: localPlan.documents.length,
      turnsReviewed: QUALIFICATION_CORPUS_TURN_COUNT,
    });
    expect(all.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ turnId: "qualification-turn-084" }),
      expect.objectContaining({ turnId: "qualification-turn-085" }),
      expect.objectContaining({ turnId: "qualification-turn-105" }),
      expect.objectContaining({ turnId: "qualification-turn-106" }),
      expect.objectContaining({ turnId: "qualification-turn-315" }),
      expect.objectContaining({ turnId: "qualification-turn-420" }),
    ]));

    const exhaustiveCandidateCounts: Record<"absence" | "count" | "universal", number> = {
      absence: 0,
      count: 0,
      universal: 0,
    };
    for (const [kind, question] of Object.entries({
      absence: qualificationQuestions.absence,
      count: qualificationQuestions.count,
      universal: qualificationQuestions.universal,
    })) {
      const result = await retrieveExhaustively(exhaustive, meeting, question, kind);
      expect(result.coverageBitmap).toHaveLength(localPlan.documents.length);
      expect(result.coverageBitmap.every(Boolean)).toBe(true);
      expect(result.coverageReduction.payload).toMatchObject({
        blocksReviewed: localPlan.documents.length,
        turnsReviewed: QUALIFICATION_CORPUS_TURN_COUNT,
      });
      exhaustiveCandidateCounts[kind as keyof typeof exhaustiveCandidateCounts] =
        result.candidates.length;
      if (kind === "absence") {
        expect(result.candidates).toEqual([]);
        expect(result.coverageReduction.selectionStatus).toBe("no_match");
      } else if (kind === "count") {
        expect(result.candidates).toEqual(expect.arrayContaining([
          expect.objectContaining({ turnId: "qualification-turn-084" }),
          expect.objectContaining({ turnId: "qualification-turn-085" }),
        ]));
      } else {
        expect(result.candidates).toContainEqual(expect.objectContaining({
          turnId: "qualification-turn-400",
        }));
      }
    }

    exhaustiveMetrics = {
      absenceEvidenceCount: exhaustiveCandidateCounts.absence,
      allEvidenceCount: all.candidates.length,
      blocksReviewed: localPlan.documents.length,
      countEvidenceCount: exhaustiveCandidateCounts.count,
      turnsReviewed: QUALIFICATION_CORPUS_TURN_COUNT,
      universalEvidenceCount: exhaustiveCandidateCounts.universal,
    };

    boundedModelInput = await assertBoundedModelInput(all, meeting);
  } finally {
    await store.requestMeetingDeletion(meeting.binding.meetingId);
    cleanupRequested = true;
    await expect(worker.executeOnce({ indexingEnabled: false })).resolves.toMatchObject({
      operation: "delete_meeting",
      status: "deleted",
    });
  }
  expect(cleanupRequested).toBe(true);

  const topology = buildHistoricalIndexPlan(meeting, ids, blockPolicy).topology;
  await expectEventually(async () => {
    const result = await adapter.searchRoom({
      candidateLimit: 5,
      query: firstFocusedQuestion,
      roomScopeExternalRef: topology.roomScopeExternalRef,
      schemaVersion: 1,
      spaceSlug: topology.spaceSlug,
      timeoutMs: config.requestTimeoutMs,
    });
    return result.status === "available" && result.hybridQualified && result.candidates.length === 0;
  }, 60_000, "deleted Infinity Context evidence remained remotely searchable");
  if (boundedModelInput === null) {
    throw new Error("bounded model-input qualification did not complete");
  }
  if (exhaustiveMetrics === null) {
    throw new Error("exhaustive qualification metrics did not complete");
  }
  return {
    boundedModelInput,
    exhaustive: exhaustiveMetrics,
    exhaustiveBlockCount: buildHistoricalIndexPlan(meeting, ids, blockPolicy).documents.length,
    focusedQuestionCount: qualificationQuestions.focused.length,
    focusedRecallAt: 5,
    remoteCleanupVerified: true,
    turnCount: QUALIFICATION_CORPUS_TURN_COUNT,
  };
}

function officialQdrantCapability(capabilities: unknown): unknown {
  if (typeof capabilities !== "object" || capabilities === null) {
    return undefined;
  }
  const adapters = Reflect.get(capabilities, "adapters");
  return typeof adapters === "object" && adapters !== null
    ? Reflect.get(adapters, "qdrant")
    : undefined;
}

function focusedRetrieval(
  adapter: InfinityContextHistoricalMemoryAdapter,
  authority: MemoryHistoricalAuthority,
  store: MemoryHistoricalStore,
  ids: HmacHistoricalOpaqueIds,
  authorize: () => Promise<boolean>,
): HistoricalFocusedRetrieval {
  return new HistoricalFocusedRetrieval({
    authority,
    authorization: {
      authorize: async () => ({
        authorizationDigest: "fixture-scope:fixture-room:policy-v1",
        authorizationEpoch: "1",
        authorized: await authorize(),
        policyVersion: "room-authorization.v1",
      }),
    },
    ids,
    memory: adapter,
    store,
  }, {
    blockPolicy,
    candidateLimitPerQuery: 8,
    maximumDecomposedQueries: 4,
    maximumEvidenceBytes: 16_000,
    maximumLocalScanBlocks: 100,
    minimumProviderScore: 0.01,
    neighborRadius: 1,
    rerankLimit: 5,
    searchTimeoutMs: 30_000,
    version: "meeting-knowledge.focused-retrieval.v1",
  });
}

async function assertFocusedHybridRecall(
  focused: HistoricalFocusedRetrieval,
  meeting: AcceptedFinalMeetingV1,
  localPlan: ReturnType<typeof buildHistoricalIndexPlan>,
): Promise<void> {
  for (const question of qualificationQuestions.focused) {
    const fact = qualificationFacts.find(({ marker }) => question.includes(marker));
    if (fact === undefined) {
      throw new Error(`missing corpus fact for ${question}`);
    }
    const expected = localPlan.documents.find(({ remoteText }) => remoteText.includes(fact.marker));
    if (expected === undefined) {
      throw new Error(`missing local evidence block for ${fact.marker}`);
    }
    let result: Awaited<ReturnType<HistoricalFocusedRetrieval["buildPlan"]>> | null = null;
    await expectEventually(async () => {
      result = await focused.buildPlan({
        authorizationPrincipalRef: "principal",
        currentMeetingId: meeting.binding.meetingId,
        question,
        roomId: meeting.binding.roomId,
        scopeId: meeting.binding.scopeId,
        searchEnabled: true,
        servingAuthorized: true,
        sourceSet: "current",
      });
      return result.status === "ready" && result.plan.retrievalSource === "qualified_hybrid" &&
        result.plan.evidenceLocators.slice(0, 5).includes(expected.manifest.candidateLocator);
    }, 120_000, `hybrid recall@5 did not find ${fact.marker}`);
    const observed = result as Awaited<
      ReturnType<HistoricalFocusedRetrieval["buildPlan"]>
    > | null;
    expect(observed?.status).toBe("ready");
    if (observed?.status !== "ready") {
      throw new Error("focused result was not ready");
    }
    expect(observed.plan.blocks).toContainEqual(expect.objectContaining({
      candidateLocator: expected.manifest.candidateLocator,
    }));
    const exactCanonicalTexts = expected.manifest.turnIds.map((turnId) =>
      meeting.humanTurns.find((turn) => turn.turnId === turnId)?.text
    );
    const rehydrated = observed.plan.blocks.find(({ candidateLocator }) =>
      candidateLocator === expected.manifest.candidateLocator
    );
    expect(rehydrated?.turns.map(({ text }) => text)).toEqual(exactCanonicalTexts);
    expect(JSON.stringify(observed.plan.blocks)).not.toContain(forbiddenPromptMaterial.rawSdkResponse);
  }
}

function exhaustiveRetrieval(
  authority: MemoryHistoricalAuthority,
  store: MemoryHistoricalStore,
  ids: HmacHistoricalOpaqueIds,
): HistoricalExhaustiveMemoryRetrieval {
  const extraction = new DeterministicExhaustiveCoverageExtraction(64);
  return new HistoricalExhaustiveMemoryRetrieval(new ExhaustiveCoverage({
    authority,
    authorization: { authorize: async () => ({
      authorizationDigest: "fixture-scope:fixture-room:policy-v1",
      authorizationEpoch: "1",
      authorized: true,
      policyVersion: "room-authorization.v1",
    }) },
    checkpoints: new MemoryCoverageCheckpoints(),
    extractor: extraction,
    ids,
    reducer: extraction,
    sync: store,
  }, {
    blockPolicy,
    checkpointRetentionSeconds: 86_400,
    maximumBlocks: 100,
    maximumCheckpointAttempts: 8,
    maximumCumulativeEvidenceUtf8Bytes: 8_388_608,
    maximumExtractPayloadUtf8Bytes: 4_096,
    maximumReduceCalls: 100,
    maximumReductionPayloadUtf8Bytes: 8_192,
    maximumSelectedTurns: 256,
    maximumSynthesisBlocks: 64,
    processingRelease: "meeting-knowledge.real-service-coverage.r1",
    reduceFanIn: 8,
    version: "meeting-knowledge.exhaustive-coverage.v1",
  }), { hash: historicalTurnHash });
}

async function retrieveExhaustively(
  retrieval: HistoricalExhaustiveMemoryRetrieval,
  meeting: AcceptedFinalMeetingV1,
  question: string,
  label: string,
) {
  const result = await retrieval.retrieve({
    authorizationPrincipalRef: "principal",
    expectedAuthorityGeneration: "real-service-authority-generation-v1",
    question,
    requestId: `real-service-${label}-request`,
    roomId: meeting.binding.roomId,
    scopeId: meeting.binding.scopeId,
  });
  expect(result.status).toBe("current");
  if (result.status !== "current") {
    throw new Error(`${label} exhaustive coverage was not current`);
  }
  return result;
}

async function assertBoundedModelInput(
  exhaustive: Extract<
    Awaited<ReturnType<HistoricalExhaustiveMemoryRetrieval["retrieve"]>>,
    { readonly status: "current" }
  >,
  meeting: AcceptedFinalMeetingV1,
): Promise<RealServiceQualificationMetrics["boundedModelInput"]> {
  const turnsById = new Map(meeting.humanTurns.map((turn) => [turn.turnId, turn]));
  const turns = exhaustive.candidates.map((reference) => {
    const turn = turnsById.get(reference.turnId);
    if (turn === undefined) {
      throw new Error("candidate failed canonical local rehydration");
    }
    return { ...turn, source: {
      meetingId: reference.meetingId,
      transcriptId: reference.transcriptId,
      transcriptVersion: reference.transcriptVersion,
    }, turnHash: historicalTurnHash(turn) };
  });
  const plan = createExhaustiveCoverageGroundingPlan({
    authorityGeneration: exhaustive.authorityGeneration,
    coverageBitmap: exhaustive.coverageBitmap,
    coveragePlanDigest: exhaustive.coveragePlanDigest,
    coverageReduction: exhaustive.coverageReduction,
    humanActorIds: ["human-qualification"],
    turns,
  });
  let exact = "";
  let measuredInputTokens = 0;
  let measuredRequestBytes = 0;
  const answer = new GroundedMeetingAnswer({
    generate: async (request) => {
      exact = JSON.stringify(request);
      return { answer: { claims: [{
        evidenceIds: [request.plan.evidence[0]?.evidenceId ?? ""],
        text: "The bounded corpus contains qualified evidence.",
      }], locale: "en", status: "answered" }, status: "completed" };
    },
    measure: async (request) => {
      const requestBytes = new TextEncoder().encode(JSON.stringify(request)).byteLength;
      measuredInputTokens = Math.ceil(requestBytes / 4);
      measuredRequestBytes = requestBytes;
      return {
        inputTokens: measuredInputTokens,
        requestBytes,
        runtimeProfile: "synthetic-exact-prompt-bound.v1",
      };
    },
  }, {
    maximumRequestBytes: 64_000,
    modelContextTokens: 32_000,
    outputTokensReserved: 2_048,
    reasoningTokensReserved: 2_048,
    safeInputTokens: 24_000,
    tokenDriftReserve: 2_048,
  });
  await expect(answer.execute({ attemptId: "real-service-bounded-input", binding: {
    canonicalEvidenceHash: "a".repeat(64),
    memoryGeneration: exhaustive.authorityGeneration,
    transcriptVersion: meeting.binding.transcriptVersion,
  }, locale: "en", plan, question: qualificationQuestions.all })).resolves.toMatchObject({
    status: "completed",
  });
  const parsed = JSON.parse(exact) as { readonly plan: { readonly evidence: readonly unknown[] } };
  expect(Object.keys(parsed).toSorted()).toEqual([
    "attemptId", "binding", "locale", "plan", "question",
  ]);
  expect(parsed.plan.evidence).toHaveLength(exhaustive.candidates.length);
  expect(new TextEncoder().encode(exact).byteLength).toBeLessThanOrEqual(64_000);
  expect(exact).not.toContain("current_complete");
  expect(exact).not.toContain(forbiddenPromptMaterial.summary);
  expect(exact).not.toContain(forbiddenPromptMaterial.transcriptPrefix);
  expect(exact).not.toContain(forbiddenPromptMaterial.rawSdkResponse);
  expect(exact).not.toContain(forbiddenPromptMaterial.unselectedTranscriptTurn);
  expect(exact).not.toContain(JSON.stringify(meeting.humanTurns));
  expect(measuredRequestBytes).toBe(new TextEncoder().encode(exact).byteLength);
  return {
    evidenceCount: exhaustive.candidates.length,
    inputTokens: measuredInputTokens,
    maximumRequestBytes: 64_000,
    requestBytes: measuredRequestBytes,
    requestSha256: createHash("sha256").update(exact, "utf8").digest("hex"),
  };
}

async function expectEventually(
  probe: () => Promise<boolean>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await probe()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1_000);
    });
  } while (Date.now() < deadline);
  throw new Error(message);
}

function historicalTurnHash(turn: AcceptedFinalMeetingV1["humanTurns"][number]): string {
  return createHash("sha256")
    .update([turn.turnId, turn.speakerId, turn.startMs, turn.endMs, turn.text].join("\u0000"), "utf8")
    .digest("hex");
}

function requiredFirstFocusedQuestion(): string {
  const question = qualificationQuestions.focused[0];
  if (question === undefined) {
    throw new Error("qualification corpus must contain a focused question");
  }
  return question;
}
