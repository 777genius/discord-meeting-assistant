import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE,
  HistoricalFocusedRetrieval,
  SameRoomFocusedMemoryRetrieval,
  admitAcceptedFinalMeeting,
  buildHistoricalIndexPlan,
  createHistoricalReleaseBinding,
  rehydrateHistoricalBlock,
  type AcceptedFinalMeetingV1,
  type FocusedRetrievalPolicyV1,
  type HistoricalAppliedPlanV1,
  type HistoricalCandidateRecordV1,
  type HistoricalEvidenceAuthority,
  type HistoricalMemoryPort,
  type HistoricalOpaqueIdPort,
  type HistoricalReleaseBindingV1,
  type HistoricalSyncStore,
} from "@discord-meeting/meeting-core/meeting-knowledge";

class TestIds implements HistoricalOpaqueIdPort {
  public keyedId(namespace: string, parts: readonly string[]): string {
    let hash = 0x811c9dc5;
    for (const character of `${namespace}:${parts.join("|")}`) {
      hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }
}

const blockPolicy = {
  maxBlockUtf8Bytes: 512,
  maxBlocksPerMeeting: 100,
  maxTurnsPerBlock: 64,
  version: "meeting-knowledge.block-policy.v1",
} as const;

const retrievalPolicy: FocusedRetrievalPolicyV1 = {
  blockPolicy,
  candidateLimitPerQuery: 8,
  maximumDecomposedQueries: 4,
  maximumEvidenceBytes: 16_000,
  maximumLocalScanBlocks: 512,
  minimumProviderScore: 0.01,
  neighborRadius: 1,
  rerankLimit: 5,
  searchTimeoutMs: 100,
  version: "meeting-knowledge.focused-retrieval.v1",
};

function makeMeeting(input: {
  readonly authoritativeDurationMs?: number;
  readonly meetingId: string;
  readonly roomId?: string;
  readonly transcriptId?: string;
  readonly turns: readonly { readonly endMs: number; readonly startMs: number; readonly text: string; readonly turnId: string }[];
}): AcceptedFinalMeetingV1 {
  const binding = createHistoricalReleaseBinding({
    acceptedMeetingRevision: 4,
    desiredGeneration: 1,
    meetingId: input.meetingId,
    roomId: input.roomId ?? "room-1",
    scopeId: "scope-1",
    transcriptId: input.transcriptId ?? `transcript-${input.meetingId}`,
    transcriptVersion: 1,
  });
  const meeting = admitAcceptedFinalMeeting({
    actors: [{ actorId: "speaker", kind: "human" }],
    authoritativeDurationMs: input.authoritativeDurationMs ?? 60_000,
    binding,
    identityProvenance: {
      actorObservationState: "consistent",
      actorSemanticsVersion: 1,
      producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
      producerRevision: "fixture-r1",
      rosterState: "sealed",
    },
    lifecycleGeneration: 3,
    meetingRevision: 4,
    roomId: binding.roomId,
    scopeId: binding.scopeId,
    transcriptId: binding.transcriptId,
    transcriptVersion: 1,
    turns: input.turns.map((turn) => ({ ...turn, speakerId: "speaker" })),
  });
  if (meeting === null) {
    throw new Error("fixture admission failed");
  }
  return meeting;
}

function twoBlockTurns(primary: string, primaryId: string) {
  return [
    { endMs: 1_000, startMs: 0, text: `${primary} ${"x".repeat(260)}`, turnId: primaryId },
    { endMs: 2_000, startMs: 1_000, text: `unrelated budget detail ${"y".repeat(260)}`, turnId: `${primaryId}-noise` },
  ];
}

class AppliedStore implements HistoricalSyncStore {
  public current = true;
  public currentSequence: boolean[] = [];

  public constructor(private readonly records: readonly HistoricalAppliedPlanV1[]) {}

  public async acceptRelease(_binding: HistoricalReleaseBindingV1): Promise<"replayed"> {
    return "replayed";
  }

  public async claimNext(): Promise<null> { return null; }
  public async recordPlan(): Promise<void> {}
  public async recordApplied(): Promise<void> {}
  public async recordRetry(): Promise<void> {}
  public async recordDeadLetter(): Promise<void> {}
  public async recordDeleted(): Promise<void> {}
  public async requestMeetingDeletion(): Promise<void> {}

  public async findCurrentCandidate(
    scopeId: string,
    roomId: string,
    candidateLocator: string,
  ): Promise<HistoricalCandidateRecordV1 | null> {
    for (const record of this.records) {
      if (record.binding.scopeId !== scopeId || record.binding.roomId !== roomId) {
        continue;
      }
      const document = record.plan.documents.find(({ manifest }) =>
        manifest.candidateLocator === candidateLocator
      );
      if (document !== undefined) {
        return { ...record, ordinal: document.manifest.ordinal };
      }
    }
    return null;
  }

  public async listCurrentRoomPlans(
    scopeId: string,
    roomId: string,
  ): Promise<readonly HistoricalAppliedPlanV1[]> {
    return this.records.filter(({ binding }) =>
      binding.scopeId === scopeId && binding.roomId === roomId
    );
  }

  public async listDesiredRoomBindings(
    scopeId: string,
    roomId: string,
  ): Promise<readonly HistoricalReleaseBindingV1[]> {
    return (await this.listCurrentRoomPlans(scopeId, roomId)).map(({ binding }) => binding);
  }

  public async isCurrentGeneration(
    _binding: HistoricalReleaseBindingV1,
    _indexGeneration: string,
  ): Promise<boolean> {
    return this.currentSequence.shift() ?? this.current;
  }
}

function authority(meetings: readonly AcceptedFinalMeetingV1[]): HistoricalEvidenceAuthority {
  const byRelease = new Map(meetings.map((meeting) => [meeting.binding.releaseId, meeting]));
  return {
    loadAcceptedFinalMeeting: async (binding) => byRelease.get(binding.releaseId) ?? null,
  };
}

function retrieval(input: {
  readonly meetings: readonly AcceptedFinalMeetingV1[];
  readonly memory: HistoricalMemoryPort;
  readonly policy?: FocusedRetrievalPolicyV1;
  readonly store: AppliedStore;
  readonly twoHourEnabled?: boolean;
}) {
  return new HistoricalFocusedRetrieval({
    authority: authority(input.meetings),
    authorization: {
      authorize: async ({ authorizationPrincipalRef, roomId }) => ({
        authorizationDigest: `${authorizationPrincipalRef}:${roomId}:v1`,
        authorizationEpoch: "1",
        authorized: authorizationPrincipalRef === "principal" && roomId === "room-1",
        policyVersion: "room-policy.v1",
      }),
    },
    ids: new TestIds(),
    memory: input.memory,
    store: input.store,
  }, input.policy ?? retrievalPolicy, {
    ...DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE,
    qualification: input.twoHourEnabled === true ? {
      evidenceSha256: "e".repeat(64),
      releaseRevision: "f".repeat(40),
      rolloutEpoch: "test-r1",
      schemaVersion: 1,
    } : null,
  });
}

describe("focused historical long-turn retrieval", () => {
  it("retains a bounded matching slice near the end of one long turn", async () => {
    const marker = "ORBITAL-CEDAR-947 launches on Friday";
    const meeting = makeMeeting({ meetingId: "long-turn-meeting", turns: [{
      endMs: 60_000, startMs: 0, text: `${"planning filler ".repeat(1_700)}${marker}`,
      turnId: "one-long-turn",
    }] });
    const plan = buildHistoricalIndexPlan(meeting, new TestIds(), blockPolicy);
    const target = plan.documents.find(({ remoteText }) => remoteText.includes(marker));
    if (target === undefined) { throw new Error("long-turn marker slice missing"); }
    const store = new AppliedStore([{ binding: meeting.binding, plan, remoteDocumentIds: {} }]);
    const result = await retrieval({
      meetings: [meeting],
      memory: { deleteMeeting: vi.fn(), indexFinalMeeting: vi.fn(),
        searchRoom: vi.fn().mockResolvedValue({ candidates: [{
          locator: target.manifest.candidateLocator, providerRank: 0, providerScore: 0.99,
        }], hybridQualified: true, status: "available" }) },
      policy: { ...retrievalPolicy, neighborRadius: 0, rerankLimit: 1 },
      store,
    }).buildPlan({
      authorizationPrincipalRef: "principal", currentMeetingId: meeting.binding.meetingId,
      question: "When does ORBITAL-CEDAR-947 launch?",
      roomId: "room-1", scopeId: "scope-1", searchEnabled: true,
      servingAuthorized: true, sourceSet: "current",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") { throw new Error("focused grounding failed"); }
    expect(result.plan.blocks).toHaveLength(1);
    expect(result.plan.blocks[0]?.turns[0]?.text).toContain(marker);
    expect(new TextEncoder().encode(JSON.stringify(result.plan.blocks)).byteLength)
      .toBeLessThanOrEqual(retrievalPolicy.maximumEvidenceBytes);
  });
});

describe("focused historical retrieval", () => {
  it("deduplicates provider locators, expands neighbors, and only prioritizes current evidence", async () => {
    const meeting = makeMeeting({
      meetingId: "meeting-1",
      turns: Array.from({ length: 10 }, (_, index) => ({
        endMs: (index + 1) * 1_000,
        startMs: index * 1_000,
        text: index === 5 ? "Maya proposed the cedar launch date Tuesday" : `discussion filler ${index}`,
        turnId: `turn-${index}`,
      })),
    });
    const plan = buildHistoricalIndexPlan(meeting, new TestIds(), blockPolicy);
    const target = plan.documents.find(({ remoteText }) => remoteText.includes("cedar"));
    if (target === undefined) {
      throw new Error("target block missing");
    }
    const record = { binding: meeting.binding, plan, remoteDocumentIds: {} };
    const store = new AppliedStore([record]);
    const searchRoom = vi.fn().mockResolvedValue({
      candidates: [
        { locator: target.manifest.candidateLocator, providerRank: 2, providerScore: 0.7 },
        { locator: target.manifest.candidateLocator, providerRank: 0, providerScore: 0.9 },
      ],
      hybridQualified: true,
      status: "available",
    });
    const result = await retrieval({
      meetings: [meeting],
      memory: { deleteMeeting: vi.fn(), indexFinalMeeting: vi.fn(), searchRoom },
      store,
    }).buildPlan({
      authorizationPrincipalRef: "principal",
      currentMeetingId: meeting.binding.meetingId,
      question: "What cedar launch date did Maya propose?",
      roomId: "room-1",
      scopeId: "scope-1",
      searchEnabled: true,
      servingAuthorized: true,
      sourceSet: "current",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error("focused plan was not ready");
    }
    expect(new Set(result.plan.evidenceLocators).size).toBe(result.plan.evidenceLocators.length);
    expect(result.plan.blocks.some(({ turns }) => turns.some(({ text }) => text.includes("cedar"))))
      .toBe(true);
    expect(result.plan.completenessClaim).toBe(false);
    expect(result.plan.selection).toBe("locally_rehydrated_focused_blocks_only");
    expect(result.plan.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "current",
        locator: target.manifest.candidateLocator,
        providerRank: 0,
        providerScore: 0.9,
      }),
    ]));
    expect(result.plan).not.toHaveProperty("currentTranscriptRequirement");
  });

  it("falls back locally on provider failure and rejects stale or cross-room candidates", async () => {
    const meeting = makeMeeting({
      meetingId: "meeting-1",
      turns: twoBlockTurns("local cedar evidence", "turn-1"),
    });
    const plan = buildHistoricalIndexPlan(meeting, new TestIds(), blockPolicy);
    const store = new AppliedStore([{ binding: meeting.binding, plan, remoteDocumentIds: {} }]);
    const searchRoom = vi.fn().mockResolvedValue({
      code: "memory.timeout",
      retryable: true,
      status: "unavailable",
    });
    const useCase = retrieval({
      meetings: [meeting],
      memory: { deleteMeeting: vi.fn(), indexFinalMeeting: vi.fn(), searchRoom },
      store,
    });

    await expect(useCase.buildPlan({
      authorizationPrincipalRef: "principal",
      question: "Where was cedar discussed?",
      roomId: "room-1",
      scopeId: "scope-1",
      searchEnabled: true,
      servingAuthorized: false,
      sourceSet: "room",
    })).resolves.toEqual({
      reason: "historical_serving_disabled",
      status: "insufficient_evidence",
    });
    expect(searchRoom).not.toHaveBeenCalled();

    const fallback = await useCase.buildPlan({
      authorizationPrincipalRef: "principal",
      question: "Where was cedar discussed?",
      roomId: "room-1",
      scopeId: "scope-1",
      searchEnabled: true,
      servingAuthorized: true,
      sourceSet: "room",
    });
    expect(fallback).toMatchObject({
      plan: { retrievalSource: "local_fallback" },
      status: "ready",
    });

    store.current = false;
    await expect(useCase.buildPlan({
      authorizationPrincipalRef: "principal",
      question: "Where was cedar discussed?",
      roomId: "room-1",
      scopeId: "scope-1",
      searchEnabled: false,
      servingAuthorized: true,
      sourceSet: "room",
    })).resolves.toMatchObject({ status: "insufficient_evidence" });
    await expect(useCase.buildPlan({
      authorizationPrincipalRef: "principal",
      question: "Where was cedar discussed?",
      roomId: "room-2",
      scopeId: "scope-1",
      searchEnabled: true,
      servingAuthorized: true,
      sourceSet: "room",
    })).resolves.toMatchObject({ status: "unauthorized" });
  });

  it("falls back locally when a qualified response contains only stale locators", async () => {
    const meeting = makeMeeting({
      meetingId: "meeting-1",
      turns: twoBlockTurns("authoritative cedar evidence", "turn-1"),
    });
    const plan = buildHistoricalIndexPlan(meeting, new TestIds(), blockPolicy);
    const store = new AppliedStore([{ binding: meeting.binding, plan, remoteDocumentIds: {} }]);

    const result = await retrieval({
      meetings: [meeting],
      memory: {
        deleteMeeting: vi.fn(),
        indexFinalMeeting: vi.fn(),
        searchRoom: vi.fn().mockResolvedValue({
          candidates: [{ locator: "mkcandidate1.stale", providerRank: 0, providerScore: 0.9 }],
          hybridQualified: true,
          status: "available",
        }),
      },
      store,
    }).buildPlan({
      authorizationPrincipalRef: "principal",
      question: "Where was cedar discussed?",
      roomId: "room-1",
      scopeId: "scope-1",
      searchEnabled: true,
      servingAuthorized: true,
      sourceSet: "room",
    });

    expect(result).toMatchObject({
      plan: { retrievalSource: "local_fallback" },
      status: "ready",
    });
  });

  it("abstains when local fallback has no qualified lexical evidence", async () => {
    const meeting = makeMeeting({
      meetingId: "meeting-low-recall",
      turns: [{
        endMs: 1_000,
        startMs: 0,
        text: "Routine budget review with no launch decision",
        turnId: "turn-1",
      }],
    });
    const plan = buildHistoricalIndexPlan(meeting, new TestIds(), blockPolicy);
    const store = new AppliedStore([{ binding: meeting.binding, plan, remoteDocumentIds: {} }]);

    await expect(retrieval({
      meetings: [meeting],
      memory: {
        deleteMeeting: vi.fn(),
        indexFinalMeeting: vi.fn(),
        searchRoom: vi.fn().mockResolvedValue({
          code: "memory.timeout",
          retryable: true,
          status: "unavailable",
        }),
      },
      store,
    }).buildPlan({
      authorizationPrincipalRef: "principal",
      question: "Who approved the zephyr migration?",
      roomId: "room-1",
      scopeId: "scope-1",
      searchEnabled: true,
      servingAuthorized: true,
      sourceSet: "room",
    })).resolves.toEqual({
      reason: "focused_evidence_budget_exhausted",
      status: "insufficient_evidence",
    });
  });

  it("rejects an authorized-room search hit whose locator belongs to another room", async () => {
    const local = makeMeeting({
      meetingId: "meeting-local-room",
      turns: twoBlockTurns("local cedar evidence", "local-turn"),
    });
    const foreign = makeMeeting({
      meetingId: "meeting-foreign-room",
      roomId: "room-2",
      turns: [{ endMs: 1_000, startMs: 0, text: "foreign quartz evidence", turnId: "foreign-turn" }],
    });
    const ids = new TestIds();
    const localPlan = buildHistoricalIndexPlan(local, ids, blockPolicy);
    const foreignPlan = buildHistoricalIndexPlan(foreign, ids, blockPolicy);
    const foreignLocator = foreignPlan.documents[0]?.manifest.candidateLocator;
    if (foreignLocator === undefined) {
      throw new Error("foreign locator missing");
    }
    const store = new AppliedStore([
      { binding: local.binding, plan: localPlan, remoteDocumentIds: {} },
      { binding: foreign.binding, plan: foreignPlan, remoteDocumentIds: {} },
    ]);
    const result = await retrieval({
      meetings: [local, foreign],
      memory: {
        deleteMeeting: vi.fn(),
        indexFinalMeeting: vi.fn(),
        searchRoom: vi.fn().mockResolvedValue({
          candidates: [{ locator: foreignLocator, providerRank: 0, providerScore: 0.9 }],
          hybridQualified: true,
          status: "available",
        }),
      },
      store,
    }).buildPlan({
      authorizationPrincipalRef: "principal",
      question: "Where was cedar discussed?",
      roomId: "room-1",
      scopeId: "scope-1",
      searchEnabled: true,
      servingAuthorized: true,
      sourceSet: "room",
    });

    expect(result).toMatchObject({
      plan: { retrievalSource: "local_fallback" },
      status: "ready",
    });
    if (result.status === "ready") {
      expect(result.plan.blocks.every(({ binding }) => binding.roomId === "room-1"))
        .toBe(true);
      expect(JSON.stringify(result.plan.blocks)).not.toContain("foreign quartz evidence");
    }
  });
});

describe("same-room focused memory merge", () => {
  it("answers a historical-only match when the current meeting has low recall", async () => {
    const historicalMeeting = makeMeeting({
      meetingId: "meeting-historical-only",
      turns: [{
        endMs: 1_000,
        startMs: 0,
        text: "cedar was approved in the earlier meeting",
        turnId: "historical-only-turn",
      }],
    });
    const historicalPlan = buildHistoricalIndexPlan(
      historicalMeeting,
      new TestIds(),
      blockPolicy,
    );
    const block = rehydrateHistoricalBlock(
      historicalMeeting,
      historicalPlan,
      0,
      new TestIds(),
      blockPolicy,
    );
    const requestedSourceSets: string[] = [];
    const sameRoom = new SameRoomFocusedMemoryRetrieval({
      current: {
        retrieve: async () => ({ schemaVersion: 1, status: "low_coverage" }),
      },
      historical: {
        buildPlan: async (input) => {
          requestedSourceSets.push(input.sourceSet);
          return ({
          plan: {
            blocks: [block],
            completenessClaim: false,
            evidenceLocators: [block.candidateLocator],
            queries: ["cedar"],
            retrievalSource: "local_fallback",
            schemaVersion: 1,
            selection: "locally_rehydrated_focused_blocks_only",
            sources: [{
              kind: "historical",
              locator: block.candidateLocator,
              providerRank: null,
              providerScore: null,
              qualifiedScore: 1,
            }],
            strategy: "focused_retrieval",
          },
          status: "ready",
          });
        },
        reauthorizeRoom: async () => true,
      },
      turnHashes: { hash: (turn) => `historical-hash-${turn.turnId}` },
    }, {
      historicalServingAuthorized: true,
      remoteSearchAvailable: true,
    });

    const result = await sameRoom.retrieve({
      authorizationPrincipalRef: "principal",
      canonicalEvidenceHash: "a".repeat(64),
      expectedAuthorityGeneration: "authority-1",
      finalProjectionReceipt: "receipt-1",
      maximumCandidates: 4,
      meetingId: "meeting-current",
      meetingRevision: 1,
      neighborTurns: 1,
      projectionTargetContainerId: "container-1",
      question: "What was approved about cedar?",
      roomId: "room-1",
      scopeId: "scope-1",
      transcriptId: "transcript-current",
      transcriptVersion: 1,
    });

    expect(result).toMatchObject({
      authorityGeneration: "authority-1",
      candidates: [{ meetingId: "meeting-historical-only" }],
      status: "current",
    });
    expect(requestedSourceSets).toEqual(["historical"]);
  });

  it("reserves current-meeting evidence when historical recall is dense", async () => {
    const historicalMeeting = makeMeeting({
      meetingId: "meeting-historical",
      turns: Array.from({ length: 8 }, (_, index) => ({
        endMs: (index + 1) * 1_000,
        startMs: index * 1_000,
        text: `cedar historical evidence ${index} ${"x".repeat(300)}`,
        turnId: `historical-turn-${index}`,
      })),
    });
    const historicalPlan = buildHistoricalIndexPlan(
      historicalMeeting,
      new TestIds(),
      blockPolicy,
    );
    const historicalBlocks = historicalPlan.documents.map((_, ordinal) =>
      rehydrateHistoricalBlock(
        historicalMeeting,
        historicalPlan,
        ordinal,
        new TestIds(),
        blockPolicy,
      )
    );
    const currentCandidates = Array.from({ length: 4 }, (_, index) => ({
      meetingId: "meeting-current",
      transcriptId: "transcript-current",
      transcriptVersion: 1,
      turnHash: `current-hash-${index}`,
      turnId: `current-turn-${index}`,
    }));
    const sameRoom = new SameRoomFocusedMemoryRetrieval({
      current: {
        retrieve: async () => ({
          authorityGeneration: "authority-1",
          candidates: currentCandidates,
          schemaVersion: 1,
          status: "current",
        }),
      },
      historical: {
        buildPlan: async () => ({
          plan: {
            blocks: historicalBlocks,
            completenessClaim: false,
            evidenceLocators: historicalBlocks.map(({ candidateLocator }) => candidateLocator),
            queries: ["cedar"],
            retrievalSource: "local_fallback",
            schemaVersion: 1,
            selection: "locally_rehydrated_focused_blocks_only",
            sources: historicalBlocks.map(({ candidateLocator }) => ({
              kind: "historical" as const,
              locator: candidateLocator,
              providerRank: null,
              providerScore: null,
              qualifiedScore: 1,
            })),
            strategy: "focused_retrieval",
          },
          status: "ready",
        }),
        reauthorizeRoom: async () => true,
      },
      turnHashes: { hash: (turn) => `historical-hash-${turn.turnId}` },
    }, {
      historicalServingAuthorized: true,
      remoteSearchAvailable: true,
    });

    const result = await sameRoom.retrieve({
      authorizationPrincipalRef: "principal",
      canonicalEvidenceHash: "a".repeat(64),
      expectedAuthorityGeneration: "authority-1",
      finalProjectionReceipt: "receipt-1",
      maximumCandidates: 4,
      meetingId: "meeting-current",
      meetingRevision: 1,
      neighborTurns: 1,
      projectionTargetContainerId: "container-1",
      question: "What was decided about cedar?",
      roomId: "room-1",
      scopeId: "scope-1",
      transcriptId: "transcript-current",
      transcriptVersion: 1,
    });

    expect(result.status).toBe("current");
    if (result.status === "current") {
      expect(result.candidates).toHaveLength(4);
      expect(result.candidates[0]).toEqual(currentCandidates[0]);
      expect(result.candidates[2]).toEqual(currentCandidates[1]);
      expect(result.candidates.some(({ meetingId }) => meetingId === "meeting-historical"))
        .toBe(true);
    }
  });
});

describe("focused historical retrieval fencing and qualification", () => {
  it("revalidates the exact selected generation before evidence can leave the use case", async () => {
    const meeting = makeMeeting({
      meetingId: "meeting-generation-race",
      turns: [{ endMs: 1_000, startMs: 0, text: "cedar race evidence", turnId: "turn-1" }],
    });
    const plan = buildHistoricalIndexPlan(meeting, new TestIds(), blockPolicy);
    const target = plan.documents[0];
    if (target === undefined) {
      throw new Error("target block missing");
    }
    const store = new AppliedStore([{ binding: meeting.binding, plan, remoteDocumentIds: {} }]);
    store.currentSequence = [true, false];

    await expect(retrieval({
      meetings: [meeting],
      memory: {
        deleteMeeting: vi.fn(),
        indexFinalMeeting: vi.fn(),
        searchRoom: vi.fn().mockResolvedValue({
          candidates: [{
            locator: target.manifest.candidateLocator,
            providerRank: 0,
            providerScore: 0.9,
          }],
          hybridQualified: true,
          status: "available",
        }),
      },
      store,
    }).buildPlan({
      authorizationPrincipalRef: "principal",
      currentMeetingId: meeting.binding.meetingId,
      question: "Where is the cedar race evidence?",
      roomId: "room-1",
      scopeId: "scope-1",
      searchEnabled: true,
      servingAuthorized: true,
      sourceSet: "current",
    })).resolves.toEqual({
      reason: "selected_evidence_became_stale",
      status: "insufficient_evidence",
    });
  });

  it("never returns a ready plan when no canonical block fits the evidence budget", async () => {
    const meeting = makeMeeting({
      meetingId: "meeting-budget",
      turns: [{
        endMs: 1_000,
        startMs: 0,
        text: `cedar ${"x".repeat(300)}`,
        turnId: "turn-1",
      }],
    });
    const plan = buildHistoricalIndexPlan(meeting, new TestIds(), blockPolicy);
    const store = new AppliedStore([{ binding: meeting.binding, plan, remoteDocumentIds: {} }]);

    await expect(retrieval({
      meetings: [meeting],
      memory: { deleteMeeting: vi.fn(), indexFinalMeeting: vi.fn(), searchRoom: vi.fn() },
      policy: { ...retrievalPolicy, maximumEvidenceBytes: 256 },
      store,
    }).buildPlan({
      authorizationPrincipalRef: "principal",
      question: "Where was cedar discussed?",
      roomId: "room-1",
      scopeId: "scope-1",
      searchEnabled: false,
      servingAuthorized: true,
      sourceSet: "room",
    })).resolves.toEqual({
      reason: "focused_evidence_budget_exhausted",
      status: "insufficient_evidence",
    });
  });

  it("measures recall@5 on a two-hour positional corpus independently of generation", async () => {
    const positions = [0, 12, 30, 60, 90, 108, 119];
    const meeting = makeMeeting({
      authoritativeDurationMs: 7_200_000,
      meetingId: "two-hour-meeting",
      turns: Array.from({ length: 120 }, (_, index) => ({
        endMs: (index + 1) * 60_000,
        startMs: index * 60_000,
        text: positions.includes(index)
          ? `positional evidence marker-p${index} at minute ${index}`
          : `synthetic distractor at minute ${index}`,
        turnId: `turn-${index.toString().padStart(3, "0")}`,
      })),
    });
    expect(meeting.humanTurns.at(-1)?.endMs).toBe(7_200_000);
    const plan = buildHistoricalIndexPlan(meeting, new TestIds(), blockPolicy);
    const store = new AppliedStore([{ binding: meeting.binding, plan, remoteDocumentIds: {} }]);
    let remoteSearchCalls = 0;
    const memory: HistoricalMemoryPort = {
      deleteMeeting: vi.fn(),
      indexFinalMeeting: vi.fn(),
      searchRoom: async ({ candidateLimit, query }) => {
        remoteSearchCalls += 1;
        const marker = query.match(/marker-p\d+/u)?.[0];
        const matches = marker === undefined
          ? []
          : plan.documents.filter(({ remoteText }) => remoteText.includes(marker));
        return {
          candidates: matches.slice(0, candidateLimit).map(({ manifest }, providerRank) => ({
            locator: manifest.candidateLocator,
            providerRank,
            providerScore: 1,
          })),
          hybridQualified: true,
          status: "available",
        };
      },
    };
    const blocked = await retrieval({ meetings: [meeting], memory, store }).buildPlan({
      authorizationPrincipalRef: "principal",
      currentMeetingId: meeting.binding.meetingId,
      question: "Where was marker-p0 discussed?",
      roomId: "room-1",
      scopeId: "scope-1",
      searchEnabled: true,
      servingAuthorized: true,
      sourceSet: "current",
    });
    expect(blocked).toMatchObject({
      reason: "no_current_authorized_evidence",
      status: "insufficient_evidence",
    });
    expect(remoteSearchCalls).toBe(0);

    const useCase = retrieval({
      meetings: [meeting],
      memory,
      store,
      twoHourEnabled: true,
    });
    let recalled = 0;
    for (const position of positions) {
      const result = await useCase.buildPlan({
        authorizationPrincipalRef: "principal",
        currentMeetingId: meeting.binding.meetingId,
        question: `Where was marker-p${position} discussed?`,
        roomId: "room-1",
        scopeId: "scope-1",
        searchEnabled: true,
        servingAuthorized: true,
        sourceSet: "current",
      });
      if (
        result.status === "ready" &&
        result.plan.blocks.slice(0, 5).some(({ turns }) =>
          turns.some(({ text }) => text.includes(`marker-p${position}`))
        )
      ) {
        recalled += 1;
      }
    }
    const retrievalMetric = {
      generationInvocations: 0,
      queries: positions.length,
      recallAt5: recalled / positions.length,
    };

    expect(retrievalMetric).toEqual({
      generationInvocations: 0,
      queries: 7,
      recallAt5: 1,
    });
  });
});
