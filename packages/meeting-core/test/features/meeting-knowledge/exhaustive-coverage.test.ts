import { describe, expect, it, vi } from "vitest";

import {
  DeterministicExhaustiveCoverageExtraction,
  ExhaustiveCoverage,
  admitAcceptedFinalMeeting,
  buildHistoricalIndexPlan,
  createHistoricalReleaseBinding,
  type AcceptedFinalMeetingV1,
  type CoverageCheckpointLeaseV1,
  type CoverageExtractV1,
  type CoverageReductionV1,
  type ExhaustiveCoverageStore,
  type HistoricalAppliedPlanV1,
  type HistoricalAuthorizationObservationV1,
  type HistoricalCandidateRecordV1,
  type HistoricalEvidenceAuthority,
  type HistoricalEmbeddingTokenizerPort,
  type HistoricalOpaqueIdPort,
  type HistoricalReleaseBindingV1,
  type HistoricalSyncStore,
} from "@discord-meeting/meeting-core/meeting-knowledge";

type TestExtract = Omit<CoverageExtractV1, "selectedTurns" | "selectionStatus">;

class TestIds implements HistoricalOpaqueIdPort {
  public keyedId(namespace: string, parts: readonly string[]): string {
    let hash = 5381;
    for (const character of `${namespace}:${parts.join("|")}`) {
      hash = (Math.imul(hash, 33) ^ (character.codePointAt(0) ?? 0)) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }
}

const blockPolicy = {
  maxBlockUtf8Bytes: 256,
  maxBlocksPerMeeting: 100,
  maxTurnsPerBlock: 64,
  version: "meeting-knowledge.block-policy.v1",
} as const;

const impossibleTokenizer: HistoricalEmbeddingTokenizerPort = Object.freeze({
  countTokens: () => 97,
  profile: Object.freeze({
    conformanceVectorSetSha256: `sha256:${"c".repeat(64)}`,
    embeddingModelRevision: "a".repeat(40),
    id: "impossible-test-tokenizer",
    maxInputTokens: 96,
    servingRuntimeRevision: "b".repeat(40),
    tokenizerArtifactSha256: `sha256:${"d".repeat(64)}`,
    tokenizerConfigSha256: `sha256:${"e".repeat(64)}`,
  }),
});

const qualifiedTwoHourProfile = {
  minimumDurationMs: 7_200_000,
  minimumHumanTurnCount: 400,
  qualification: {
    evidenceSha256: "a".repeat(64),
    releaseRevision: "b".repeat(40),
    rolloutEpoch: "test",
    schemaVersion: 1,
  },
  version: "meeting-knowledge.two-hour-historical-retrieval.v1",
} as const;

function makeMeeting(meetingId: string, transcriptVersion = 1): AcceptedFinalMeetingV1 {
  const binding = createHistoricalReleaseBinding({
    acceptedMeetingRevision: transcriptVersion + 2,
    desiredGeneration: transcriptVersion,
    meetingId,
    roomId: "room-1",
    scopeId: "scope-1",
    transcriptId: `transcript-${meetingId}-${transcriptVersion}`,
    transcriptVersion,
  });
  const admitted = admitAcceptedFinalMeeting({
    actors: [{ actorId: "speaker", kind: "human" }],
    binding,
    identityProvenance: {
      actorObservationState: "consistent",
      actorSemanticsVersion: 1,
      producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
      producerRevision: "fixture-r1",
      rosterState: "sealed",
    },
    lifecycleGeneration: 3,
    meetingRevision: binding.acceptedMeetingRevision,
    roomId: binding.roomId,
    scopeId: binding.scopeId,
    transcriptId: binding.transcriptId,
    transcriptVersion,
    turns: Array.from({ length: 12 }, (_, index) => ({
      endMs: (index + 1) * 1_000,
      speakerId: "speaker",
      startMs: index * 1_000,
      text: index % 3 === 0 ? `cedar decision ${index}` : `ordinary discussion ${index}`,
      turnId: `${meetingId}-turn-${index}`,
    })),
  });
  if (admitted === null) {
    throw new Error("fixture admission failed");
  }
  return admitted;
}

function makeLargeMeeting(
  meetingId: string,
  turnCount: number,
  text: (index: number) => string,
): AcceptedFinalMeetingV1 {
  const binding = createHistoricalReleaseBinding({
    acceptedMeetingRevision: 3,
    desiredGeneration: 1,
    meetingId,
    roomId: "room-1",
    scopeId: "scope-1",
    transcriptId: `transcript-${meetingId}`,
    transcriptVersion: 1,
  });
  const admitted = admitAcceptedFinalMeeting({
    actors: [{ actorId: "speaker", kind: "human" }],
    binding,
    identityProvenance: {
      actorObservationState: "consistent",
      actorSemanticsVersion: 1,
      producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
      producerRevision: "fixture-r1",
      rosterState: "sealed",
    },
    lifecycleGeneration: 3,
    meetingRevision: 3,
    roomId: binding.roomId,
    scopeId: binding.scopeId,
    transcriptId: binding.transcriptId,
    transcriptVersion: 1,
    turns: Array.from({ length: turnCount }, (_, index) => ({
      endMs: (index + 1) * 1_000,
      speakerId: "speaker",
      startMs: index * 1_000,
      text: text(index),
      turnId: `${meetingId}-turn-${String(index).padStart(4, "0")}`,
    })),
  });
  if (admitted === null) {
    throw new Error("large fixture admission failed");
  }
  return admitted;
}

class MemoryCheckpoints implements ExhaustiveCoverageStore {
  readonly #rows = new Map<string, CoverageCheckpointLeaseV1>();
  public readonly observedAttempts: number[] = [];
  public completed = false;
  public extractsRecorded = 0;
  public reduction: CoverageReductionV1 | null = null;

  public get rowCount(): number {
    return this.#rows.size;
  }

  public async open(input: {
    readonly blockLocators: readonly string[];
    readonly checkpointId: string;
    readonly planDigest: string;
  }): Promise<CoverageCheckpointLeaseV1> {
    const existing = this.#rows.get(input.checkpointId);
    if (existing !== undefined) {
      if (existing.state !== "active") {
        this.observedAttempts.push(existing.attempt);
        return existing;
      }
      const next = {
        ...existing,
        attempt: existing.attempt + 1,
        fence: existing.fence + 1,
      };
      this.#rows.set(input.checkpointId, next);
      this.observedAttempts.push(next.attempt);
      return next;
    }
    const created = {
      attempt: 1,
      bitmap: input.blockLocators.map(() => false),
      checkpointId: input.checkpointId,
      extracts: {},
      fence: 1,
      planDigest: input.planDigest,
      reduction: null,
      state: "active" as const,
      terminalReason: null,
    };
    this.#rows.set(input.checkpointId, created);
    this.observedAttempts.push(created.attempt);
    return created;
  }

  public async recordExtract(input: {
    readonly blockOrdinal: number;
    readonly checkpointId: string;
    readonly extract: CoverageExtractV1;
    readonly fence: number;
  }): Promise<CoverageCheckpointLeaseV1> {
    const row = this.#rows.get(input.checkpointId);
    if (row === undefined || row.fence !== input.fence) {
      throw new Error("stale checkpoint fence");
    }
    const bitmap = [...row.bitmap];
    bitmap[input.blockOrdinal] = true;
    this.extractsRecorded += 1;
    const next = {
      ...row,
      bitmap,
      extracts: { ...row.extracts, [input.extract.blockLocator]: input.extract },
    };
    this.#rows.set(input.checkpointId, next);
    return next;
  }

  public async recordReduction(input: {
    readonly checkpointId: string;
    readonly fence: number;
    readonly reduction: CoverageReductionV1;
  }): Promise<void> {
    const row = this.#rows.get(input.checkpointId);
    if (row === undefined || row.fence !== input.fence) {
      throw new Error("stale checkpoint fence");
    }
    this.reduction = input.reduction;
    this.#rows.set(input.checkpointId, {
      ...row,
      reduction: input.reduction,
    });
  }

  public async complete(input: { readonly checkpointId: string; readonly fence: number }): Promise<void> {
    const row = this.#rows.get(input.checkpointId);
    if (
      row === undefined ||
      row.fence !== input.fence ||
      row.bitmap.some((value) => !value) ||
      this.reduction === null
    ) {
      throw new Error("checkpoint is incomplete");
    }
    this.#rows.set(input.checkpointId, {
      ...row,
      reduction: this.reduction,
      state: "completed",
      terminalReason: null,
    });
    this.completed = true;
  }

  public async terminate(input: {
    readonly checkpointId: string;
    readonly fence: number;
    readonly reason: string;
    readonly state: "failed" | "invalidated";
  }): Promise<void> {
    const row = this.#rows.get(input.checkpointId);
    if (row === undefined || row.fence !== input.fence) {
      throw new Error("stale checkpoint fence");
    }
    this.#rows.set(input.checkpointId, {
      ...row,
      state: input.state,
      terminalReason: input.reason,
    });
  }

  public scrubExpired(): Promise<number> {
    return Promise.resolve(0);
  }
}

class BindingStore implements HistoricalSyncStore {
  public current = true;
  public bindingSnapshots: readonly (readonly HistoricalReleaseBindingV1[])[];

  public constructor(bindings: readonly HistoricalReleaseBindingV1[]) {
    this.bindingSnapshots = [bindings];
  }

  public async acceptRelease(): Promise<"replayed"> { return "replayed"; }
  public async enqueueAppliedProfileRebuilds() {
    return { enqueued: 0, remaining: false } as const;
  }
  public async claimNext(): Promise<null> { return null; }
  public async recordPlan(): Promise<void> {}
  public async recordApplied(): Promise<void> {}
  public async recordRetry(): Promise<void> {}
  public async recordDeadLetter(): Promise<void> {}
  public async recordDeleted(): Promise<void> {}
  public async requestMeetingDeletion(): Promise<void> {}
  public async findCurrentCandidate(): Promise<HistoricalCandidateRecordV1 | null> { return null; }
  public async listCurrentRoomPlans(): Promise<readonly HistoricalAppliedPlanV1[]> { return []; }

  public async listDesiredRoomBindings(): Promise<readonly HistoricalReleaseBindingV1[]> {
    const [head, ...tail] = this.bindingSnapshots;
    if (head === undefined) {
      return [];
    }
    if (tail.length > 0) {
      this.bindingSnapshots = tail;
    }
    return head;
  }

  public async isCurrentGeneration(): Promise<boolean> { return this.current; }
}

function authority(meetings: readonly AcceptedFinalMeetingV1[]): HistoricalEvidenceAuthority {
  const values = new Map(meetings.map((meeting) => [meeting.binding.releaseId, meeting]));
  return { loadAcceptedFinalMeeting: async (binding) => values.get(binding.releaseId) ?? null };
}

function useCase(input: {
  readonly authorize?: () => Promise<HistoricalAuthorizationObservationV1>;
  readonly checkpoints: MemoryCheckpoints;
  readonly extractor: (blockLocator: string) => Promise<TestExtract>;
  readonly extractorProfile?: string;
  readonly maximumCumulativeEvidenceUtf8Bytes?: number;
  readonly meetings: readonly AcceptedFinalMeetingV1[];
  readonly processingRelease?: string;
  readonly store: BindingStore;
  readonly tokenizer?: HistoricalEmbeddingTokenizerPort;
}) {
  const tokenizer = input.tokenizer;
  return new ExhaustiveCoverage({
    authority: authority(input.meetings),
    authorization: {
      authorize: input.authorize ?? (async () => ({
        authorizationDigest: "authorized-room-1",
        authorizationEpoch: "1",
        authorized: true,
        policyVersion: "room-policy.v1",
      })),
    },
    checkpoints: input.checkpoints,
    extractor: {
      profile: input.extractorProfile ?? "meeting-knowledge.test-extractor.v1",
      extract: async ({ block }) => {
        const extracted = await input.extractor(block.candidateLocator);
        const firstTurn = block.turns[0];
        const selectedTurns = extracted.evidenceLocators.length > 0 && firstTurn !== undefined
          ? [{
              blockLocator: block.candidateLocator,
              relevance: "direct" as const,
              turnId: firstTurn.turnId,
            }]
          : [];
        return {
          ...extracted,
          selectedTurns,
          selectionStatus: selectedTurns.length === 0 ? "no_match" : "selected",
        };
      },
    },
    ids: new TestIds(),
    reducer: {
      profile: "meeting-knowledge.test-reducer.v1",
      reduce: async ({ values }) => {
        const reducedTurns = [...new Map(values.flatMap(({ selectedTurns }) =>
          selectedTurns.map((turn) => [
            `${turn.blockLocator}\u0000${turn.turnId}`,
            turn,
          ] as const)
        )).values()];
        return {
          evidenceLocators: [...new Set(reducedTurns.map(({ blockLocator }) => blockLocator))],
          payload: {
            matches: values.reduce((total, value) =>
              total + (typeof value.payload.matches === "number" ? value.payload.matches : 0), 0),
          },
          selectedTurns: reducedTurns,
          selectionStatus: reducedTurns.length === 0 ? "no_match" : "selected",
          schemaVersion: 1,
        };
      },
    },
    sync: input.store,
    ...(tokenizer === undefined ? {} : { tokenizer: () => tokenizer }),
  }, {
    blockPolicy,
    checkpointRetentionSeconds: 86_400,
    maximumBlocks: 100,
    maximumCheckpointAttempts: 8,
    maximumCumulativeEvidenceUtf8Bytes:
      input.maximumCumulativeEvidenceUtf8Bytes ?? 8_388_608,
    maximumExtractPayloadUtf8Bytes: 4_096,
    maximumReduceCalls: 100,
    maximumReductionPayloadUtf8Bytes: 8_192,
    maximumSelectedTurns: 256,
    maximumSynthesisBlocks: 64,
    processingRelease:
      input.processingRelease ?? "meeting-knowledge.test-coverage.r2",
    reduceFanIn: 2,
    version: "meeting-knowledge.exhaustive-coverage.v1",
  }, qualifiedTwoHourProfile);
}

const largeBlockPolicy = Object.freeze({
  maxBlockUtf8Bytes: 32_768,
  maxBlocksPerMeeting: 100,
  maxTurnsPerBlock: 64,
  version: "meeting-knowledge.block-policy.v1" as const,
});

function largeCoverage(
  meeting: AcceptedFinalMeetingV1,
  checkpoints: MemoryCheckpoints,
): ExhaustiveCoverage {
  const extraction = new DeterministicExhaustiveCoverageExtraction(64, 256);
  return new ExhaustiveCoverage({
    authority: authority([meeting]),
    authorization: { authorize: async () => ({
      authorizationDigest: "authorized-room-1",
      authorizationEpoch: "1",
      authorized: true,
      policyVersion: "room-policy.v1",
    }) },
    checkpoints,
    extractor: extraction,
    ids: new TestIds(),
    reducer: extraction,
    sync: new BindingStore([meeting.binding]),
  }, {
    blockPolicy: largeBlockPolicy,
    checkpointRetentionSeconds: 86_400,
    maximumBlocks: 100,
    maximumCheckpointAttempts: 8,
    maximumCumulativeEvidenceUtf8Bytes: 8_388_608,
    maximumExtractPayloadUtf8Bytes: 4_096,
    maximumReduceCalls: 100,
    maximumReductionPayloadUtf8Bytes: 8_192,
    maximumSelectedTurns: 256,
    maximumSynthesisBlocks: 64,
    processingRelease: "meeting-knowledge.test-coverage.r2",
    reduceFanIn: 2,
    version: "meeting-knowledge.exhaustive-coverage.v1",
  }, qualifiedTwoHourProfile);
}

const request = {
  authorizationPrincipalRef: "principal",
  question: "Count every cedar mention across all meetings",
  requestId: "request-1",
  roomId: "room-1",
  scopeId: "scope-1",
} as const;

async function assertRoomBudgetIsRejected(): Promise<void> {
  const meeting = makeMeeting("meeting-room-budget");
  const checkpoints = new MemoryCheckpoints();
  const extractor = vi.fn();

  await expect(useCase({
    checkpoints,
    extractor,
    maximumCumulativeEvidenceUtf8Bytes: 1_024,
    meetings: [meeting],
    store: new BindingStore([meeting.binding]),
  }).buildPlan(request)).resolves.toEqual({
    reason: "exhaustive_evidence_budget_exceeded",
    status: "unsupported",
  });
  expect(extractor).not.toHaveBeenCalled();
  expect(checkpoints.rowCount).toBe(0);
}

async function assertDuplicateCoverageIsRejected(): Promise<void> {
  const meeting = makeMeeting("meeting-duplicate");
  await expect(useCase({
    checkpoints: new MemoryCheckpoints(),
    extractor: vi.fn(),
    meetings: [meeting],
    store: new BindingStore([meeting.binding, meeting.binding]),
  }).buildPlan(request)).resolves.toEqual({
    reason: "missing_or_stale_authoritative_release",
    status: "invalidated",
  });
}

describe("exhaustive historical coverage", () => {
  it("visits beyond 256 turns and selects a question-relevant final turn", async () => {
    const meeting = makeLargeMeeting(
      "meeting-late-relevant-turn",
      360,
      (index) => index === 359 ? "Project Cedar was mentioned." : `Noise ${index}.`,
    );
    const checkpoints = new MemoryCheckpoints();
    const expectedBlockCount = buildHistoricalIndexPlan(
      meeting,
      new TestIds(),
      largeBlockPolicy,
    ).documents.length;
    const result = await largeCoverage(meeting, checkpoints).buildPlan({
      ...request,
      question: "Was Project Cedar mentioned?",
    });

    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.plan.reduction.selectedTurns.map(({ turnId }) => turnId))
        .toContain("meeting-late-relevant-turn-turn-0359");
      expect(result.plan.coverageBitmap).toHaveLength(expectedBlockCount);
      expect(result.plan.coverageBitmap.every(Boolean)).toBe(true);
    }
    expect(checkpoints.extractsRecorded).toBe(expectedBlockCount);
  });

  it("never claims completeness when more than 256 canonical turns are selected", async () => {
    const meeting = makeLargeMeeting(
      "meeting-selection-overflow",
      360,
      (index) => `Project Cedar mention ${index}.`,
    );
    const checkpoints = new MemoryCheckpoints();
    const expectedBlockCount = buildHistoricalIndexPlan(
      meeting,
      new TestIds(),
      largeBlockPolicy,
    ).documents.length;

    await expect(largeCoverage(meeting, checkpoints).buildPlan({
      ...request,
      question: "List every Project Cedar mention",
    })).resolves.toEqual({
      reason: "coverage_synthesis_selection_exceeded",
      status: "unsupported",
    });
    expect(checkpoints.extractsRecorded).toBe(expectedBlockCount);
    expect(checkpoints.completed).toBe(false);
  });
});

describe("exhaustive historical coverage checkpoint lifecycle", () => {
  it("checkpoints every block, resumes missing extracts, and only then permits synthesis", async () => {
    const meeting = makeMeeting("meeting-1");
    const checkpoints = new MemoryCheckpoints();
    const store = new BindingStore([meeting.binding]);
    let calls = 0;
    let failOnce = true;
    const extractor = vi.fn(async (blockLocator: string) => {
      calls += 1;
      if (calls === 2 && failOnce) {
        failOnce = false;
        throw new Error("synthetic extraction timeout");
      }
      return {
        blockLocator,
        evidenceLocators: [blockLocator],
        payload: { matches: 1 },
        schemaVersion: 1 as const,
      };
    });

    const first = await useCase({ checkpoints, extractor, meetings: [meeting], store })
      .buildPlan(request);
    expect(first).toMatchObject({ status: "incomplete" });
    const callsAfterFailure = calls;
    const second = await useCase({ checkpoints, extractor, meetings: [meeting], store })
      .buildPlan(request);

    expect(second.status).toBe("ready");
    if (second.status !== "ready") {
      throw new Error("coverage did not resume");
    }
    expect(second.plan.coverageBitmap.every(Boolean)).toBe(true);
    expect(second.plan.coverageBitmap.length).toBeGreaterThan(1);
    expect(second.plan.selectedBlocks).toHaveLength(second.plan.coverageBitmap.length);
    expect(second.plan.finalSynthesisAllowed).toBe(true);
    expect(checkpoints.completed).toBe(true);
    expect(extractor).toHaveBeenCalledTimes(second.plan.coverageBitmap.length + 1);
    expect(callsAfterFailure).toBe(2);

    const callsAfterCompletion = calls;
    const replay = await useCase({ checkpoints, extractor, meetings: [meeting], store })
      .buildPlan(request);
    expect(replay).toMatchObject({ status: "ready" });
    expect(calls).toBe(callsAfterCompletion);
    expect(checkpoints.observedAttempts.at(-1)).toBe(
      checkpoints.observedAttempts.at(-2),
    );
  });

  it("invalidates completion when room membership changes during extraction", async () => {
    const first = makeMeeting("meeting-1");
    const added = makeMeeting("meeting-2");
    const store = new BindingStore([first.binding]);
    store.bindingSnapshots = [[first.binding], [first.binding, added.binding]];

    await expect(useCase({
      checkpoints: new MemoryCheckpoints(),
      extractor: async (blockLocator) => ({
        blockLocator,
        evidenceLocators: [blockLocator],
        payload: { matches: 0 },
        schemaVersion: 1,
      }),
      meetings: [first, added],
      store,
    }).buildPlan(request)).resolves.toEqual({
      reason: "coverage_source_changed",
      status: "invalidated",
    });
  });

  it("fails closed on stale blocks and proves an authorized empty corpus without top-k", async () => {
    const meeting = makeMeeting("meeting-1");
    const staleStore = new BindingStore([meeting.binding]);
    staleStore.current = false;
    await expect(useCase({
      checkpoints: new MemoryCheckpoints(),
      extractor: vi.fn(),
      meetings: [meeting],
      store: staleStore,
    }).buildPlan(request)).resolves.toMatchObject({ status: "invalidated" });

    const checkpoints = new MemoryCheckpoints();
    const empty = await useCase({
      checkpoints,
      extractor: vi.fn(),
      meetings: [],
      store: new BindingStore([]),
    }).buildPlan(request);
    expect(empty).toMatchObject({
      plan: {
        coverageBitmap: [],
        finalSynthesisAllowed: true,
        reduction: { payload: { emptyAuthorizedCorpus: true } },
      },
      status: "ready",
    });
  });

  it(
    "fails closed when exhaustive source coverage contains a duplicate release",
    assertDuplicateCoverageIsRejected,
  );

  it("never permits final synthesis after authorization changes or a payload exceeds bounds", async () => {
    const meeting = makeMeeting("meeting-1");
    const store = new BindingStore([meeting.binding]);
    let authorizationCalls = 0;
    const changed = await useCase({
      authorize: async () => ({
        authorizationDigest: authorizationCalls++ === 0 ? "authorized-room-1" : "revoked-room-1",
        authorizationEpoch: String(authorizationCalls),
        authorized: authorizationCalls === 1,
        policyVersion: "room-policy.v1",
      }),
      checkpoints: new MemoryCheckpoints(),
      extractor: async (blockLocator) => ({
        blockLocator,
        evidenceLocators: [blockLocator],
        payload: { matches: 1 },
        schemaVersion: 1,
      }),
      meetings: [meeting],
      store,
    }).buildPlan(request);
    expect(changed).toEqual({ reason: "authorization_changed", status: "unauthorized" });

    const checkpoints = new MemoryCheckpoints();
    const oversized = await useCase({
      checkpoints,
      extractor: async (blockLocator) => ({
        blockLocator,
        evidenceLocators: [blockLocator],
        payload: { oversized: "x".repeat(5_000) },
        schemaVersion: 1,
      }),
      meetings: [meeting],
      store: new BindingStore([meeting.binding]),
    }).buildPlan(request);
    expect(oversized).toMatchObject({ status: "incomplete" });
    expect(checkpoints.completed).toBe(false);
  });

  it(
    "rejects an over-budget room plan before any semantic extraction or checkpoint write",
    assertRoomBudgetIsRejected,
  );

  it("keeps a repeatedly failing checkpoint incomplete after its attempt budget", async () => {
    const meeting = makeMeeting("meeting-1");
    const checkpoints = new MemoryCheckpoints();
    const failing = useCase({
      checkpoints,
      extractor: async () => {
        throw new Error("synthetic persistent extraction failure");
      },
      meetings: [meeting],
      store: new BindingStore([meeting.binding]),
    });

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await expect(failing.buildPlan(request)).resolves.toMatchObject({
        status: "incomplete",
      });
    }
    const exhausted = await failing.buildPlan(request);
    expect(exhausted).toMatchObject({
      reason: "coverage_checkpoint_attempt_budget_exhausted",
      status: "incomplete",
    });
    expect("checkpointId" in exhausted && exhausted.checkpointId.length > 0).toBe(true);
    expect(checkpoints.completed).toBe(false);
    const attemptsAfterTermination = [...checkpoints.observedAttempts];
    await expect(failing.buildPlan(request)).resolves.toMatchObject({
      reason: "coverage_checkpoint_attempt_budget_exhausted",
      status: "incomplete",
    });
    expect(checkpoints.observedAttempts).toEqual([
      ...attemptsAfterTermination,
      attemptsAfterTermination.at(-1),
    ]);
  });

  it("does not reuse a completed checkpoint across extractor or release profiles", async () => {
    const meeting = makeMeeting("meeting-profile-binding");
    const checkpoints = new MemoryCheckpoints();
    const store = new BindingStore([meeting.binding]);
    const extractor = vi.fn(async (blockLocator: string) => ({
      blockLocator,
      evidenceLocators: [blockLocator],
      payload: { matches: 1 },
      schemaVersion: 1 as const,
    }));

    await expect(useCase({
      checkpoints,
      extractor,
      meetings: [meeting],
      store,
    }).buildPlan(request)).resolves.toMatchObject({ status: "ready" });
    const callsAfterFirstProfile = extractor.mock.calls.length;
    await expect(useCase({
      checkpoints,
      extractor,
      extractorProfile: "meeting-knowledge.test-extractor.v2",
      meetings: [meeting],
      processingRelease: "meeting-knowledge.test-coverage.r3",
      store,
    }).buildPlan(request)).resolves.toMatchObject({ status: "ready" });

    expect(checkpoints.rowCount).toBe(2);
    expect(extractor.mock.calls.length).toBe(callsAfterFirstProfile * 2);
  });

  it("returns an honest unsupported result when an authoritative turn cannot fit the tokenizer profile", async () => {
    const binding = createHistoricalReleaseBinding({
      acceptedMeetingRevision: 3,
      desiredGeneration: 1,
      meetingId: "meeting-oversized-turn",
      roomId: "room-1",
      scopeId: "scope-1",
      transcriptId: "transcript-oversized-turn",
      transcriptVersion: 1,
    });
    const meeting = admitAcceptedFinalMeeting({
      actors: [{ actorId: "speaker", kind: "human" }],
      binding,
      identityProvenance: {
        actorObservationState: "consistent",
        actorSemanticsVersion: 1,
        producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
        producerRevision: "fixture-r1",
        rosterState: "sealed",
      },
      lifecycleGeneration: 3,
      meetingRevision: 3,
      roomId: binding.roomId,
      scopeId: binding.scopeId,
      transcriptId: binding.transcriptId,
      transcriptVersion: 1,
      turns: [{
        endMs: 1_000,
        speakerId: "speaker",
        startMs: 0,
        text: "x".repeat(1_000),
        turnId: "oversized-turn",
      }],
    });
    if (meeting === null) {
      throw new Error("fixture admission failed");
    }

    await expect(useCase({
      checkpoints: new MemoryCheckpoints(),
      extractor: vi.fn(),
      meetings: [meeting],
      store: new BindingStore([binding]),
      tokenizer: impossibleTokenizer,
    }).buildPlan(request)).resolves.toEqual({
      reason: "exhaustive_block_plan_not_qualified",
      status: "unsupported",
    });
  });
});
