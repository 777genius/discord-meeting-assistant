import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE,
  DeterministicCoverageReducer,
  ExhaustiveCoverage,
  GroundedAnswer,
  GroundedMeetingAnswer,
  admitAcceptedFinalMeeting,
  buildHistoricalIndexPlan,
  createExhaustiveCoverageGroundingPlan,
  createHistoricalReleaseBinding,
  exhaustiveCoverageProvesAbsence,
  type AcceptedFinalMeetingV1,
  type CoverageCheckpointLeaseV1,
  type CoverageExtractV1,
  type CoverageReductionV1,
  type ExhaustiveCoverageStore,
  type GroundingPlan,
  type HistoricalAuthorizationPort,
  type HistoricalEvidenceAuthority,
  type HistoricalOpaqueIdPort,
  type HistoricalReleaseBindingV1,
  type HistoricalSyncStore,
} from "@discord-meeting/meeting-core/meeting-knowledge";

const semanticBlockPolicy = {
  maxBlockUtf8Bytes: 32_768,
  maxBlocksPerMeeting: 100,
  maxTurnsPerBlock: 64,
  version: "meeting-knowledge.block-policy.v1",
} as const;

class SemanticIds implements HistoricalOpaqueIdPort {
  public keyedId(namespace: string, parts: readonly string[]): string {
    return createHash("sha256")
      .update(`${namespace}\0${parts.join("\0")}`)
      .digest("hex");
  }
}

class SemanticCheckpoints implements ExhaustiveCoverageStore {
  readonly #rows = new Map<string, CoverageCheckpointLeaseV1>();
  public extractionCount = 0;

  public open(input: {
    readonly blockLocators: readonly string[];
    readonly checkpointId: string;
    readonly planDigest: string;
  }): Promise<CoverageCheckpointLeaseV1> {
    const prior = this.#rows.get(input.checkpointId);
    if (prior !== undefined) {
      return Promise.resolve(prior);
    }
    const row = {
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
    this.#rows.set(input.checkpointId, row);
    return Promise.resolve(row);
  }

  public recordExtract(input: {
    readonly blockOrdinal: number;
    readonly checkpointId: string;
    readonly extract: CoverageExtractV1;
  }): Promise<CoverageCheckpointLeaseV1> {
    const row = this.required(input.checkpointId);
    const bitmap = [...row.bitmap];
    bitmap[input.blockOrdinal] = true;
    const next = {
      ...row,
      bitmap,
      extracts: { ...row.extracts, [input.extract.blockLocator]: input.extract },
    };
    this.extractionCount += 1;
    this.#rows.set(input.checkpointId, next);
    return Promise.resolve(next);
  }

  public recordReduction(input: {
    readonly checkpointId: string;
    readonly reduction: CoverageReductionV1;
  }): Promise<void> {
    const row = this.required(input.checkpointId);
    this.#rows.set(input.checkpointId, { ...row, reduction: input.reduction });
    return Promise.resolve();
  }

  public complete(input: { readonly checkpointId: string }): Promise<void> {
    const row = this.required(input.checkpointId);
    this.#rows.set(input.checkpointId, {
      ...row,
      state: "completed",
      terminalReason: null,
    });
    return Promise.resolve();
  }

  public terminate(input: {
    readonly checkpointId: string;
    readonly reason: string;
    readonly state: "failed" | "invalidated";
  }): Promise<void> {
    const row = this.required(input.checkpointId);
    this.#rows.set(input.checkpointId, {
      ...row,
      state: input.state,
      terminalReason: input.reason,
    });
    return Promise.resolve();
  }

  public scrubExpired(): Promise<number> {
    return Promise.resolve(0);
  }

  private required(checkpointId: string): CoverageCheckpointLeaseV1 {
    const row = this.#rows.get(checkpointId);
    if (row === undefined) {
      throw new Error("semantic checkpoint is missing");
    }
    return row;
  }
}

function corpus(): AcceptedFinalMeetingV1 {
  const binding = createHistoricalReleaseBinding({
    acceptedMeetingRevision: 3,
    desiredGeneration: 1,
    meetingId: "meeting-semantic-420",
    roomId: "room-1",
    scopeId: "scope-1",
    transcriptId: "transcript-semantic-420",
    transcriptVersion: 1,
  });
  const gold = new Map<number, string>([
    [3, "The team agreed to ship Beta next week."],
    [120, "Команда договорилась запустить Гамма в июне."],
    [200, "The group settled on Project Delta for the pilot."],
    [257, "The team agreed to ship Beta next week."],
    [330, "Correction: Beta will not ship; the earlier agreement was rejected."],
    [419, "We approved Omega after final review."],
  ]);
  const admitted = admitAcceptedFinalMeeting({
    actors: [{ actorId: "speaker", kind: "human" }],
    binding,
    identityProvenance: {
      actorObservationState: "consistent",
      actorSemanticsVersion: 1,
      producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
      producerRevision: "semantic-fixture-r1",
      rosterState: "sealed",
    },
    lifecycleGeneration: 3,
    meetingRevision: 3,
    roomId: binding.roomId,
    scopeId: binding.scopeId,
    transcriptId: binding.transcriptId,
    transcriptVersion: 1,
    turns: Array.from({ length: 420 }, (_, index) => ({
      endMs: (index + 1) * 1_000,
      speakerId: "speaker",
      startMs: index * 1_000,
      text: gold.get(index) ?? `Neutral bilingual status update ${index}.`,
      turnId: `meeting-semantic-420-turn-${String(index).padStart(4, "0")}`,
    })),
  });
  if (admitted === null) {
    throw new Error("semantic corpus admission failed");
  }
  return admitted;
}

function semanticCoverage(
  meeting: AcceptedFinalMeetingV1,
  checkpoints: SemanticCheckpoints,
  authorization?: HistoricalAuthorizationPort,
  twoHourEnabled = true,
): ExhaustiveCoverage {
  const authority: HistoricalEvidenceAuthority = {
    loadAcceptedFinalMeeting: async (binding) =>
      binding.releaseId === meeting.binding.releaseId ? meeting : null,
  };
  const sync = semanticSync(meeting.binding);
  return new ExhaustiveCoverage({
    authority,
    authorization: authorization ?? { authorize: async () => ({
      authorizationDigest: "authorized-room-1",
      authorizationEpoch: "1",
      authorized: true,
      policyVersion: "room-policy.v1",
    }) },
    checkpoints,
    extractor: {
      profile: "meeting-knowledge.test-semantic-every-block.v1",
      extract: async ({ block, question }) => {
        const asksForGamma = /гамм|gamma/iu.test(question);
        const asksForZeta = /zeta|зет/iu.test(question);
        const selectedTurns = asksForZeta ? [] : block.turns.filter(({ text }) =>
          asksForGamma
            ? /гамм|gamma/iu.test(text)
            : /agreed to ship Beta|договорилась запустить Гамма|settled on Project Delta|Correction: Beta|approved Omega/iu.test(text)
        ).map(({ text, turnId }) => ({
          blockLocator: block.candidateLocator,
          relevance: /Correction:/u.test(text)
            ? "conflicting" as const
            : "direct" as const,
          turnId,
        }));
        return {
          blockLocator: block.candidateLocator,
          evidenceLocators: selectedTurns.length === 0
            ? []
            : [block.candidateLocator],
          payload: {
            blocksReviewed: 1,
            semanticClaimCount: selectedTurns.length,
            turnsReviewed: block.turns.length,
          },
          selectedTurns,
          selectionStatus: selectedTurns.length === 0
            ? "no_match" as const
            : "selected" as const,
          schemaVersion: 1 as const,
        };
      },
    },
    ids: new SemanticIds(),
    reducer: new DeterministicCoverageReducer(64, 256),
    sync,
  }, {
    blockPolicy: semanticBlockPolicy,
    checkpointRetentionSeconds: 86_400,
    maximumBlocks: 100,
    maximumCheckpointAttempts: 8,
    maximumCumulativeEvidenceUtf8Bytes: 8_388_608,
    maximumExtractPayloadUtf8Bytes: 4_096,
    maximumReduceCalls: 100,
    maximumReductionPayloadUtf8Bytes: 8_192,
    maximumSelectedTurns: 256,
    maximumSynthesisBlocks: 64,
    processingRelease: "meeting-knowledge.test-semantic-coverage.r1",
    reduceFanIn: 2,
    version: "meeting-knowledge.exhaustive-coverage.v1",
  }, {
    ...DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE,
    qualification: twoHourEnabled ? {
      evidenceSha256: "e".repeat(64),
      releaseRevision: "f".repeat(40),
      rolloutEpoch: "test-r1",
      schemaVersion: 1,
    } : null,
  });
}

function semanticSync(binding: HistoricalReleaseBindingV1): HistoricalSyncStore {
  return {
    claimNext: async () => null,
    findCurrentCandidate: async () => null,
    isCurrentGeneration: async () => true,
    listCurrentRoomPlans: async () => [],
    listDesiredRoomBindings: async () => [binding],
    recordApplied: () => Promise.resolve(),
    recordDeadLetter: () => Promise.resolve(),
    recordDeleted: () => Promise.resolve(),
    recordPlan: () => Promise.resolve(),
    recordRetry: () => Promise.resolve(),
    requestMeetingDeletion: () => Promise.resolve(),
  };
}

function answerPlan(
  result: Awaited<ReturnType<ExhaustiveCoverage["buildPlan"]>>,
): GroundingPlan {
  if (result.status !== "ready") {
    throw new Error(`expected ready coverage, got ${result.status}`);
  }
  const blocks = new Map(result.plan.selectedBlocks.map((block) => [
    block.candidateLocator,
    block,
  ]));
  const turns = result.plan.reduction.selectedTurns.map((selection) => {
    const block = blocks.get(selection.blockLocator);
    const turn = block?.turns.find(({ turnId }) => turnId === selection.turnId);
    if (block === undefined || turn === undefined) {
      throw new Error("semantic selection did not rehydrate locally");
    }
    return {
      ...turn,
      source: {
        meetingId: block.binding.meetingId,
        transcriptId: block.binding.transcriptId,
        transcriptVersion: block.binding.transcriptVersion,
      },
      turnHash: createHash("sha256").update(JSON.stringify(turn)).digest("hex"),
    };
  });
  return createExhaustiveCoverageGroundingPlan({
    authorityGeneration: "semantic-authority-v1",
    coverageBitmap: result.plan.coverageBitmap,
    coveragePlanDigest: result.plan.coveragePlanDigest,
    coverageReduction: {
      evidenceBlockCount: result.plan.coverageBitmap.length,
      payload: result.plan.reduction.payload,
      schemaVersion: 1,
      selectionStatus: result.plan.reduction.selectionStatus,
      selectedCanonicalTurnCount: turns.length,
      selectedEvidenceBlockCount: result.plan.selectedBlocks.length,
    },
    humanActorIds: ["speaker"],
    turns,
  });
}

async function coverageFor(question: string, requestId: string) {
  const meeting = corpus();
  const checkpoints = new SemanticCheckpoints();
  const result = await semanticCoverage(meeting, checkpoints).buildPlan({
    authorizationPrincipalRef: "principal",
    question,
    requestId,
    roomId: "room-1",
    scopeId: "scope-1",
  });
  const blockCount = buildHistoricalIndexPlan(
    meeting,
    new SemanticIds(),
    semanticBlockPolicy,
  ).documents.length;
  return { blockCount, checkpoints, result };
}

function revokingAuthorization(input: {
  readonly revokeOnCall: number;
  readonly signal: AbortSignal;
}): { readonly calls: () => number; readonly port: HistoricalAuthorizationPort } {
  let calls = 0;
  return {
    calls: () => calls,
    port: {
      authorize: async (request) => {
        calls += 1;
        expect(request.signal).toBe(input.signal);
        return {
          authorizationDigest: "authorized-room-1",
          authorizationEpoch: "1",
          authorized: calls < input.revokeOnCall,
          policyVersion: "room-policy.v1",
        };
      },
    },
  };
}

describe("semantic exhaustive coverage exact-answer oracles", () => {
  it("stops before the next extractor when authorization is revoked mid-pass", async () => {
    const signal = new AbortController().signal;
    const authorization = revokingAuthorization({ revokeOnCall: 3, signal });
    const checkpoints = new SemanticCheckpoints();
    const result = await semanticCoverage(
      corpus(),
      checkpoints,
      authorization.port,
    ).buildPlan({
      authorizationPrincipalRef: "principal",
      question: "Count every decision assertion",
      requestId: "request-revoked-extract",
      roomId: "room-1",
      scopeId: "scope-1",
      signal,
    });

    expect(result).toEqual({
      reason: "authorization_changed",
      status: "unauthorized",
    });
    expect(checkpoints.extractionCount).toBe(1);
    expect(authorization.calls()).toBe(3);
  });

  it("stops before the next reducer when authorization is revoked mid-pass", async () => {
    const signal = new AbortController().signal;
    const meeting = corpus();
    const blockCount = buildHistoricalIndexPlan(
      meeting,
      new SemanticIds(),
      semanticBlockPolicy,
    ).documents.length;
    // Initial admission + every block + first reducer are authorized.
    const authorization = revokingAuthorization({
      revokeOnCall: blockCount + 3,
      signal,
    });
    const checkpoints = new SemanticCheckpoints();
    const result = await semanticCoverage(
      meeting,
      checkpoints,
      authorization.port,
    ).buildPlan({
      authorizationPrincipalRef: "principal",
      question: "Count every decision assertion",
      requestId: "request-revoked-reduce",
      roomId: "room-1",
      scopeId: "scope-1",
      signal,
    });

    expect(result).toEqual({
      reason: "authorization_changed",
      status: "unauthorized",
    });
    expect(checkpoints.extractionCount).toBe(blockCount);
    expect(authorization.calls()).toBe(blockCount + 3);
  });

  it("does not call the final provider without a fresh exhaustive authorization fence", async () => {
    const coverage = await coverageFor(
      "Count every decision assertion",
      "request-provider-fence",
    );
    const plan = answerPlan(coverage.result);
    const generate = vi.fn(async () => ({
      answer: {
        claims: [{
          evidenceIds: [plan.evidence[0]?.evidenceId ?? "missing"],
          text: "One decision was found.",
        }],
        locale: "en" as const,
        status: "answered" as const,
      },
      status: "completed" as const,
    }));
    const answers = new GroundedMeetingAnswer({
      generate,
      measure: async () => ({
        inputTokens: 100,
        requestBytes: 1_000,
        runtimeProfile: "fixture",
      }),
    }, {
      maximumRequestBytes: 10_000,
      modelContextTokens: 10_000,
      outputTokensReserved: 100,
      reasoningTokensReserved: 100,
      safeInputTokens: 8_000,
      tokenDriftReserve: 100,
    });

    await expect(answers.execute({
      attemptId: "attempt-provider-fence",
      binding: { canonicalEvidenceHash: "hash", memoryGeneration: "generation", transcriptVersion: 1 },
      locale: "en",
      plan,
      question: "Count every decision assertion",
    })).resolves.toEqual({ status: "rejected" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("blocks long exhaustive retrieval before semantic extraction by default", async () => {
    const meeting = corpus();
    const checkpoints = new SemanticCheckpoints();
    const result = await semanticCoverage(
      meeting,
      checkpoints,
      undefined,
      false,
    ).buildPlan({
      authorizationPrincipalRef: "principal",
      question: "List every decision across all meetings",
      requestId: "two-hour-disabled",
      roomId: meeting.binding.roomId,
      scopeId: meeting.binding.scopeId,
    });

    expect(result).toMatchObject({ status: "invalidated" });
    expect(checkpoints.extractionCount).toBe(0);
  });

  it("returns exact count and all/list answers across more than 400 turns, retaining duplicates and contradictions", async () => {
    const { blockCount, checkpoints, result } = await coverageFor(
      "Count every decision assertion and list all of them",
      "request-count-list",
    );
    if (result.status !== "ready") {
      throw new Error("semantic coverage was not ready");
    }
    expect(result.plan.coverageBitmap).toHaveLength(blockCount);
    expect(checkpoints.extractionCount).toBe(blockCount);
    expect(result.plan.coverageBitmap.every(Boolean)).toBe(true);
    expect(result.plan.reduction.selectedTurns.map(({ turnId }) => turnId).toSorted()).toEqual([
      "meeting-semantic-420-turn-0003",
      "meeting-semantic-420-turn-0120",
      "meeting-semantic-420-turn-0200",
      "meeting-semantic-420-turn-0257",
      "meeting-semantic-420-turn-0330",
      "meeting-semantic-420-turn-0419",
    ]);
    expect(result.plan.reduction.selectedTurns.filter(({ relevance }) =>
      relevance === "conflicting"
    )).toHaveLength(1);

    const plan = answerPlan(result);
    const evidenceIds = plan.evidence.map(({ evidenceId }) => evidenceId);
    const count = GroundedAnswer.create({
      candidate: {
        claims: [{
          evidenceIds,
          text: "There are exactly six relevant decision assertions, including one duplicate and one correction.",
        }],
        locale: "en",
        status: "answered",
      },
      evidence: plan.evidence,
      expectedLocale: "en",
      groundingMode: "exhaustive_coverage",
      question: "Was Project Zeta ever approved?",
    });
    expect(count.toSnapshot().claims).toEqual([{
      evidenceIds,
      text: "There are exactly six relevant decision assertions, including one duplicate and one correction.",
    }]);

    const list = GroundedAnswer.create({
      candidate: {
        claims: evidenceIds.map((evidenceId, index) => ({
          evidenceIds: [evidenceId],
          text: `Decision assertion ${index + 1} of 6.`,
        })),
        locale: "en",
        status: "answered",
      },
      evidence: plan.evidence,
      expectedLocale: "en",
      groundingMode: "exhaustive_coverage",
      question: "Was Project Zeta ever approved?",
    });
    expect(list.claims.map(({ text }) => text)).toEqual(
      Array.from({ length: 6 }, (_, index) => `Decision assertion ${index + 1} of 6.`),
    );
  });

  it("answers Russian existence and proven absence only from complete every-block proofs", async () => {
    const gamma = answerPlan((await coverageFor(
      "Договорились ли запустить Гамма? Проверьте все обсуждения.",
      "request-gamma-ru",
    )).result);
    expect(gamma.evidence.map(({ turnId }) => turnId)).toEqual([
      "meeting-semantic-420-turn-0120",
    ]);
    const existence = GroundedAnswer.create({
      candidate: {
        claims: [{
          evidenceIds: [gamma.evidence[0]?.evidenceId ?? "missing"],
          text: "Да, команда договорилась запустить Гамма в июне.",
        }],
        locale: "ru",
        status: "answered",
      },
      evidence: gamma.evidence,
      expectedLocale: "ru",
      groundingMode: "exhaustive_coverage",
      question: "Был ли проект Гамма одобрен?",
    });
    expect(existence.claims[0]?.text).toBe(
      "Да, команда договорилась запустить Гамма в июне.",
    );

    const absence = answerPlan((await coverageFor(
      "Was Project Zeta ever approved? Check all discussions.",
      "request-zeta-absence",
    )).result);
    expect(exhaustiveCoverageProvesAbsence(absence)).toBe(true);
    const answer = GroundedAnswer.create({
      candidate: {
        claims: [{
          evidenceIds: [],
          text: "Project Zeta was never approved in the complete authorized corpus.",
        }],
        locale: "en",
        status: "answered",
      },
      evidence: absence.evidence,
      exhaustiveAbsenceProven: true,
      expectedLocale: "en",
      groundingMode: "exhaustive_coverage",
      question: "Was Project Zeta ever approved?",
    });
    expect(answer.toSnapshot().claims[0]).toEqual({
      evidenceIds: [],
      text: "Project Zeta was never approved in the complete authorized corpus.",
    });
    expect(() => GroundedAnswer.create({
      candidate: answer.toSnapshot(),
      evidence: [],
      exhaustiveAbsenceProven: false,
      expectedLocale: "en",
      groundingMode: "exhaustive_coverage",
      question: "Was Project Zeta ever approved?",
    })).toThrow("between one and eight citations");
  }, 15_000);
});
