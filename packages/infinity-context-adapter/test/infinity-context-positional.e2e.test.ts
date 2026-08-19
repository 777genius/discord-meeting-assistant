import { describe, expect, it } from "vitest";
import { InfinityContextClient } from "@infinity-context/sdk";
import { createHash } from "node:crypto";

import {
  DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE,
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
  PinnedMultilingualMiniLmTokenizer,
} from "../src/index.js";
import { DisposableInfinityEndpoint } from "./disposable-infinity-endpoint.js";
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

const positionalNeedles = qualificationQuestions.focused.map((question) => {
  const fact = qualificationFacts.find(({ marker }) => question.includes(marker));
  if (fact === undefined) {
    throw new Error("focused qualification question has no corpus fact");
  }
  return fact;
});

const twoHourBlockPolicy = {
  maxBlockUtf8Bytes: 1_536,
  maxBlocksPerMeeting: 500,
  maxTurnsPerBlock: 64,
  version: "meeting-knowledge.block-policy.v1",
} as const;

async function expectOverSelectionToAbstain(
  retrieval: HistoricalExhaustiveMemoryRetrieval,
  meeting: AcceptedFinalMeetingV1,
): Promise<void> {
  await expect(retrieval.retrieve({
    authorizationPrincipalRef: "principal",
    expectedAuthorityGeneration: "two-hour-authority-generation-v1",
    question: "Summarize the whole meeting",
    requestId: "two-hour-over-selection-request",
    roomId: meeting.binding.roomId,
    scopeId: meeting.binding.scopeId,
  })).resolves.toEqual({ schemaVersion: 1, status: "unsupported" });
}

async function assertExhaustiveQuestionFamilies(
  retrieval: HistoricalExhaustiveMemoryRetrieval,
  meeting: AcceptedFinalMeetingV1,
  evidenceBlockCount: number,
  examinedTurnReferenceCount: number,
): Promise<void> {
  for (const [kind, question] of Object.entries({
    absence: qualificationQuestions.absence,
    count: qualificationQuestions.count,
    universal: qualificationQuestions.universal,
  })) {
    const result = await retrieval.retrieve({
      authorizationPrincipalRef: "principal",
      expectedAuthorityGeneration: "two-hour-authority-generation-v1",
      question,
      requestId: `combined-qualification-${kind}-request`,
      roomId: meeting.binding.roomId,
      scopeId: meeting.binding.scopeId,
    });
    expect(result.status).toBe("current");
    if (result.status !== "current") {
      throw new Error(`${kind} exhaustive coverage did not reach synthesis`);
    }
    expect(result.coverageBitmap).toHaveLength(evidenceBlockCount);
    expect(result.coverageBitmap.every(Boolean)).toBe(true);
    expect(result.coverageReduction.payload).toMatchObject({
      blocksReviewed: evidenceBlockCount,
      turnsReviewed: examinedTurnReferenceCount,
    });
    if (kind === "absence") {
      expect(result.candidates).toEqual([]);
      expect(result.coverageReduction.selectionStatus).toBe("no_match");
    } else {
      expect(result.coverageReduction.selectionStatus).toBe("selected");
    }
    if (kind === "count") {
      expect(result.candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ turnId: "qualification-turn-084" }),
        expect.objectContaining({ turnId: "qualification-turn-085" }),
      ]));
    }
    if (kind === "universal") {
      expect(result.candidates).toContainEqual(expect.objectContaining({
        turnId: "qualification-turn-400",
      }));
    }
  }
}

function assertExactBoundedModelRequest(
  exactModelRequest: string,
  expectedEvidenceCount: number,
  meeting: AcceptedFinalMeetingV1,
): void {
  expect(exactModelRequest).not.toBe("");
  const parsedModelRequest = JSON.parse(exactModelRequest) as {
    readonly attemptId: string;
    readonly binding: unknown;
    readonly locale: string;
    readonly plan: { readonly evidence: readonly unknown[]; readonly mode: string };
    readonly question: string;
  };
  expect(Object.keys(parsedModelRequest).toSorted()).toEqual([
    "attemptId", "binding", "locale", "plan", "question",
  ]);
  expect(parsedModelRequest.plan.mode).toBe("exhaustive_coverage");
  expect(parsedModelRequest.plan.evidence.length).toBe(expectedEvidenceCount);
  expect(parsedModelRequest.plan.evidence.length).toBeLessThanOrEqual(256);
  const exactPromptBytes = new TextEncoder().encode(exactModelRequest).byteLength;
  expect(exactPromptBytes).toBeLessThanOrEqual(64_000);
  expect(exactPromptBytes).toBe(19_468);
  expect(createHash("sha256").update(exactModelRequest, "utf8").digest("hex"))
    .toBe("03244e18ab252baef55e21168cea729b4df7c7387106aa9cd35d252cc2a29812");
  expect(exactModelRequest).not.toContain("current_complete");
  expect(exactModelRequest).not.toContain(forbiddenPromptMaterial.summary);
  expect(exactModelRequest).not.toContain(forbiddenPromptMaterial.transcriptPrefix);
  expect(exactModelRequest).not.toContain(forbiddenPromptMaterial.rawSdkResponse);
  expect(exactModelRequest).not.toContain(forbiddenPromptMaterial.unselectedTranscriptTurn);
  expect(exactModelRequest).not.toContain(JSON.stringify(meeting.humanTurns));
}

async function assertFocusedRecall(
  focused: HistoricalFocusedRetrieval,
  meeting: AcceptedFinalMeetingV1,
  localPlan: ReturnType<typeof buildHistoricalIndexPlan>,
): Promise<void> {
  let recalled = 0;
  for (const [index, needle] of positionalNeedles.entries()) {
    const relevant = localPlan.documents.find(({ remoteText }) =>
      remoteText.includes(needle.marker)
    )?.manifest.candidateLocator;
    const result = await focused.buildPlan({
      authorizationPrincipalRef: "principal",
      currentMeetingId: meeting.binding.meetingId,
      question: qualificationQuestions.focused[index] ?? "",
      roomId: meeting.binding.roomId,
      scopeId: meeting.binding.scopeId,
      searchEnabled: true,
      servingAuthorized: true,
      sourceSet: "current",
    });
    if (
      relevant !== undefined &&
      result.status === "ready" &&
      result.plan.evidenceLocators.slice(0, 5).includes(relevant)
    ) {
      recalled += 1;
    }
    if (result.status === "ready") {
      expect(result.plan.blocks.length).toBeLessThan(localPlan.documents.length);
      expect(JSON.stringify(result.plan.blocks)).not.toContain("UNTRUSTED SDK CHUNK");
    }
  }
  expect({
    generationInvocations: 0,
    queries: positionalNeedles.length,
    recallAt5: recalled / positionalNeedles.length,
  }).toEqual({
    generationInvocations: 0,
    queries: qualificationQuestions.focused.length,
    recallAt5: 1,
  });
}

async function createPositionalRuntime() {
  const endpoint = new DisposableInfinityEndpoint();
  const exactTokenizer = new PinnedMultilingualMiniLmTokenizer();
  const ids = new HmacHistoricalOpaqueIds(new Uint8Array(32).fill(0xa5));
  const authority = new MemoryHistoricalAuthority();
  const store = new MemoryHistoricalStore();
  const meeting = combinedQualificationMeeting();
  authority.put(meeting);
  await store.acceptRelease(meeting.binding);
  const adapter = new InfinityContextHistoricalMemoryAdapter({
    baseUrl: "http://disposable.infinity.invalid",
    requestTimeoutMs: 250,
    schemaVersion: 1,
    tokenizer: () => exactTokenizer,
    transport: endpoint,
  });
  await adapter.qualifyCapabilities();
  return { adapter, authority, endpoint, exactTokenizer, ids, meeting, store } as const;
}

describe("Infinity Context positional retrieval qualification", () => {
  it("qualifies one combined >400-turn RU/EN corpus with bounded focused and exhaustive paths", async () => {
    const { adapter, authority, endpoint, exactTokenizer, ids, meeting, store } =
      await createPositionalRuntime();
    expect(meeting.humanTurns).toHaveLength(QUALIFICATION_CORPUS_TURN_COUNT);
    expect(meeting.humanTurns.at(-1)?.endMs).toBe(8_420_000);
    const worker = new HistoricalSyncWorker({
      authority,
      ids,
      memory: adapter,
      store,
      tokenizer: () => exactTokenizer,
    }, {
      blockPolicy: twoHourBlockPolicy,
      leaseDurationMs: 30_000,
      maximumIndexAttempts: 3,
      retryBackoffMs: [1],
      version: "meeting-knowledge.historical-sync.v1",
    });
    await expect(worker.executeOnce({ indexingEnabled: true })).resolves.toMatchObject({
      operation: "index",
      status: "applied",
    });
    const localPlan = buildHistoricalIndexPlan(
      meeting,
      ids,
      twoHourBlockPolicy,
      exactTokenizer,
    );
    expect(localPlan.documents.length).toBeGreaterThan(5);
    expect(localPlan.documents.length).toBeLessThanOrEqual(500);

    const officialClient = new InfinityContextClient({
      baseUrl: "http://disposable.infinity.invalid",
      retryPolicy: { maxAttempts: 1 },
      timeoutMs: 250,
      transport: endpoint,
    });
    const firstDocumentId = endpoint.documentIds()[0];
    if (firstDocumentId === undefined) {
      throw new Error("two-hour SDK index produced no document");
    }
    const untrustedChunks = await officialClient.documents.listAllDocumentChunks(
      firstDocumentId,
      { maxItems: 10, pageLimit: 1 },
    );
    expect(untrustedChunks).toHaveLength(3);
    expect(endpoint.requests.filter(({ path }) => path.endsWith("/chunks"))).toHaveLength(3);

    const focused = new HistoricalFocusedRetrieval({
      authority,
      authorization: {
        authorize: async () => ({
          authorizationDigest: "fixture-scope:fixture-room:policy-v1",
          authorizationEpoch: "1",
          authorized: true,
          policyVersion: "room-authorization.v1",
        }),
      },
      ids,
      memory: adapter,
      store,
      tokenizer: () => exactTokenizer,
    }, {
      blockPolicy: twoHourBlockPolicy,
      candidateLimitPerQuery: 40,
      maximumDecomposedQueries: 4,
      maximumEvidenceBytes: 16_000,
      maximumLocalScanBlocks: 500,
      minimumProviderScore: 0.01,
      neighborRadius: 1,
      rerankLimit: 8,
      searchTimeoutMs: 40,
      version: "meeting-knowledge.focused-retrieval.v1",
    }, {
    ...DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE,
    qualification: { evidenceSha256: "e".repeat(64), releaseRevision: "f".repeat(40), rolloutEpoch: "test-r1", schemaVersion: 1 },
  });
    await assertFocusedRecall(focused, meeting, localPlan);

    const extraction = new DeterministicExhaustiveCoverageExtraction(64);
    const exhaustiveMemory = new HistoricalExhaustiveMemoryRetrieval(
      new ExhaustiveCoverage({
        authority,
        authorization: {
          authorize: async () => ({
            authorizationDigest: "fixture-scope:fixture-room:policy-v1",
            authorizationEpoch: "1",
            authorized: true,
            policyVersion: "room-authorization.v1",
          }),
        },
        checkpoints: new MemoryCoverageCheckpoints(),
        extractor: extraction,
        ids,
        reducer: extraction,
        sync: store,
      }, {
        blockPolicy: twoHourBlockPolicy,
        checkpointRetentionSeconds: 86_400,
        maximumBlocks: 500,
        maximumCheckpointAttempts: 8,
        maximumCumulativeEvidenceUtf8Bytes: 8_388_608,
        maximumExtractPayloadUtf8Bytes: 4_096,
        maximumReduceCalls: 100,
        maximumReductionPayloadUtf8Bytes: 8_192,
        maximumSelectedTurns: 256,
        maximumSynthesisBlocks: 64,
        processingRelease: "meeting-knowledge.positional-coverage.r2",
        reduceFanIn: 8,
        version: "meeting-knowledge.exhaustive-coverage.v1",
      }, {
    ...DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE,
    qualification: { evidenceSha256: "e".repeat(64), releaseRevision: "f".repeat(40), rolloutEpoch: "test-r1", schemaVersion: 1 },
  }),
      { hash: historicalTurnHash },
    );
    const exhaustive = await exhaustiveMemory.retrieve({
      authorizationPrincipalRef: "principal",
      expectedAuthorityGeneration: "two-hour-authority-generation-v1",
      question: qualificationQuestions.all,
      requestId: "two-hour-exhaustive-request",
      roomId: meeting.binding.roomId,
      scopeId: meeting.binding.scopeId,
    });
    expect(exhaustive.status).toBe("current");
    if (exhaustive.status !== "current") {
      throw new Error("two-hour exhaustive coverage did not reach synthesis");
    }
    expect(exhaustive.coverageBitmap).toHaveLength(localPlan.documents.length);
    const examinedTurnReferenceCount = localPlan.documents.reduce(
      (total, document) => total + document.manifest.turnIds.length,
      0,
    );
    expect(new Set(localPlan.documents.flatMap(
      (document) => document.manifest.turnIds,
    )).size).toBe(QUALIFICATION_CORPUS_TURN_COUNT);
    expect(exhaustive.coverageReduction.payload).toMatchObject({
      blocksReviewed: localPlan.documents.length,
      turnsReviewed: examinedTurnReferenceCount,
    });
    expect(exhaustive.candidates.length).toBeLessThan(QUALIFICATION_CORPUS_TURN_COUNT);
    expect(exhaustive.candidates.length).toBeLessThanOrEqual(256);
    expect(exhaustive.candidates).toContainEqual(expect.objectContaining({
      turnId: "qualification-turn-420",
    }));
    expect(exhaustive.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ turnId: "qualification-turn-084" }),
      expect.objectContaining({ turnId: "qualification-turn-085" }),
      expect.objectContaining({ turnId: "qualification-turn-105" }),
      expect.objectContaining({ turnId: "qualification-turn-106" }),
      expect.objectContaining({ turnId: "qualification-turn-315" }),
    ]));

    await assertExhaustiveQuestionFamilies(
      exhaustiveMemory,
      meeting,
      localPlan.documents.length,
      examinedTurnReferenceCount,
    );

    await expectOverSelectionToAbstain(exhaustiveMemory, meeting);

    const turnsById = new Map(meeting.humanTurns.map((turn) => [turn.turnId, turn]));
    const synthesisTurns = exhaustive.candidates.map((reference) => {
      const turn = turnsById.get(reference.turnId);
      if (turn === undefined) {
        throw new Error("exhaustive candidate did not rehydrate locally");
      }
      return Object.freeze({
        ...turn,
        source: Object.freeze({
          meetingId: reference.meetingId,
          transcriptId: reference.transcriptId,
          transcriptVersion: reference.transcriptVersion,
        }),
        turnHash: historicalTurnHash(turn),
      });
    });
    const groundingPlan = createExhaustiveCoverageGroundingPlan({
      authorityGeneration: exhaustive.authorityGeneration,
      coverageBitmap: exhaustive.coverageBitmap,
      coveragePlanDigest: exhaustive.coveragePlanDigest,
      coverageReduction: exhaustive.coverageReduction,
      humanActorIds: ["human-qualification"],
      turns: synthesisTurns,
    });
    let synthesisReduction: unknown;
    let exactModelRequest = "";
    const sharedAnswer = new GroundedMeetingAnswer({
      generate: async (request) => {
        synthesisReduction = request.plan.coverageReduction;
        exactModelRequest = JSON.stringify(request);
        return {
          answer: {
            claims: [{
              evidenceIds: [request.plan.evidence[0]?.evidenceId ?? ""],
              text: "The bounded corpus contains positional marker evidence.",
            }],
            locale: "en",
            status: "answered",
          },
          status: "completed",
        };
      },
      measure: async (request) => {
        const requestBytes = new TextEncoder().encode(JSON.stringify(request)).byteLength;
        return {
          inputTokens: Math.ceil(requestBytes / 4),
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
    await expect(sharedAnswer.execute({
      attemptId: "two-hour-shared-answer-attempt",
      binding: {
        canonicalEvidenceHash: "a".repeat(64),
        memoryGeneration: exhaustive.authorityGeneration,
        transcriptVersion: meeting.binding.transcriptVersion,
      },
      locale: "en",
      plan: groundingPlan,
      question: qualificationQuestions.all,
    }, {
      beforeGenerate: async () => "continue",
    })).resolves.toMatchObject({ status: "completed" });
    expect(synthesisReduction).toEqual(exhaustive.coverageReduction);
    assertExactBoundedModelRequest(
      exactModelRequest,
      exhaustive.candidates.length,
      meeting,
    );

    endpoint.hangNextSearchUntilDeadline();
    await expect(focused.buildPlan({
      authorizationPrincipalRef: "principal",
      currentMeetingId: meeting.binding.meetingId,
      question: "Where was QUARTZ-CHARLIE discussed?",
      roomId: meeting.binding.roomId,
      scopeId: meeting.binding.scopeId,
      searchEnabled: true,
      servingAuthorized: true,
      sourceSet: "current",
    })).resolves.toMatchObject({
      plan: { retrievalSource: "local_fallback" },
      status: "ready",
    });
  // This includes four independent every-block passes plus official-SDK indexing,
  // pagination, focused recall and deadline fallback. Keep a finite outer fence.
  }, 360_000);
});


function historicalTurnHash(turn: AcceptedFinalMeetingV1["humanTurns"][number]): string {
  const value = [turn.turnId, turn.speakerId, turn.startMs, turn.endMs, turn.text]
    .join("\u0000");
  return createHash("sha256")
    .update(value, "utf8")
    .digest("hex");
}
