import { describe, expect, it, vi } from "vitest";

import {
  buildHistoricalIndexPlan,
  type HistoricalMemoryPort,
} from "@discord-meeting/meeting-core/meeting-knowledge";

import {
  AppliedStore,
  TestIds,
  blockPolicy,
  makeMeeting,
  retrieval,
  retrievalPolicy,
  twoBlockTurns,
} from "./historical-retrieval-fixtures.js";

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
    expect(store.candidateBatchReads).toBe(2);
    expect(store.candidatePointReads).toBe(0);
  });

  it("preserves ordering when a qualified provider uses scores above one", async () => {
    const meeting = makeMeeting({
      meetingId: "score-scale-meeting",
      turns: [
        { endMs: 1_000, startMs: 0,
          text: `cedar primary decision ${"x".repeat(260)}`, turnId: "high-score" },
        { endMs: 2_000, startMs: 1_000,
          text: `cedar secondary note ${"y".repeat(260)}`, turnId: "lower-score" },
        { endMs: 3_000, startMs: 2_000,
          text: `unrelated budget appendix ${"z".repeat(260)}`, turnId: "noise" },
      ],
    });
    const plan = buildHistoricalIndexPlan(meeting, new TestIds(), blockPolicy);
    const targets = plan.documents.filter(({ remoteText }) =>
      remoteText.includes("cedar")
    );
    expect(targets).toHaveLength(2);
    const high = targets[0]?.manifest.candidateLocator;
    const lower = targets[1]?.manifest.candidateLocator;
    if (high === undefined || lower === undefined) {
      throw new Error("score-scale candidates missing");
    }
    const store = new AppliedStore([{
      binding: meeting.binding,
      plan,
      remoteDocumentIds: {},
    }]);
    const result = await retrieval({
      meetings: [meeting],
      memory: {
        deleteMeeting: vi.fn(),
        indexFinalMeeting: vi.fn(),
        searchRoom: vi.fn().mockResolvedValue({
          candidates: [
            { locator: "mkcandidate1.stale-outlier", providerRank: 0,
              providerScore: 1_000 },
            { locator: high, providerRank: 0, providerScore: 12 },
            { locator: lower, providerRank: 1, providerScore: 8 },
          ],
          hybridQualified: true,
          status: "available",
        }),
      },
      policy: { ...retrievalPolicy, neighborRadius: 0, rerankLimit: 2 },
      store,
    }).buildPlan({
      authorizationPrincipalRef: "principal",
      currentMeetingId: meeting.binding.meetingId,
      question: "What was the cedar decision?",
      roomId: "room-1",
      scopeId: "scope-1",
      searchEnabled: true,
      servingAuthorized: true,
      sourceSet: "current",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error("score-scale plan was not ready");
    }
    const highSource = result.plan.sources.find(({ locator }) => locator === high);
    const lowerSource = result.plan.sources.find(({ locator }) => locator === lower);
    expect(highSource?.providerScore).toBe(12);
    expect(lowerSource?.providerScore).toBe(8);
    expect(highSource?.qualifiedScore).toBeGreaterThan(0.8);
    expect(highSource?.qualifiedScore).toBeGreaterThan(
      lowerSource?.qualifiedScore ?? 1,
    );
  });

  it("reranks topical evidence using configured names for opaque speakers", async () => {
    const meeting = makeMeeting({
      meetingId: "speaker-alias-meeting",
      turns: [
        { endMs: 1_000, speakerId: "opaque-other", startMs: 0,
          text: `release topic background ${"x".repeat(260)}`, turnId: "other" },
        { endMs: 2_000, speakerId: "opaque-vlad", startMs: 1_000,
          text: `release topic decision ${"y".repeat(260)}`, turnId: "vlad" },
      ],
    });
    const plan = buildHistoricalIndexPlan(meeting, new TestIds(), blockPolicy);
    expect(plan.documents).toHaveLength(2);
    const other = plan.documents[0]?.manifest.candidateLocator;
    const vlad = plan.documents[1]?.manifest.candidateLocator;
    if (other === undefined || vlad === undefined) {
      throw new Error("speaker alias candidates missing");
    }
    const result = await retrieval({
      meetings: [meeting],
      memory: {
        deleteMeeting: vi.fn(),
        indexFinalMeeting: vi.fn(),
        searchRoom: vi.fn().mockResolvedValue({
          candidates: [
            { locator: other, providerRank: 0, providerScore: 0.8 },
            { locator: vlad, providerRank: 1, providerScore: 0.8 },
          ],
          hybridQualified: true,
          status: "available",
        }),
      },
      policy: { ...retrievalPolicy, neighborRadius: 0, rerankLimit: 2 },
      speakerAliases: { "opaque-vlad": ["Влад", "Vlad"] },
      store: new AppliedStore([{
        binding: meeting.binding,
        plan,
        remoteDocumentIds: {},
      }]),
    }).buildPlan({
      authorizationPrincipalRef: "principal",
      currentMeetingId: meeting.binding.meetingId,
      question: "Что Влад решил про release?",
      roomId: "room-1",
      scopeId: "scope-1",
      searchEnabled: true,
      servingAuthorized: true,
      sourceSet: "current",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error("speaker alias plan was not ready");
    }
    expect(result.plan.sources[0]?.locator).toBe(vlad);
  });

});

describe("focused historical cross-meeting ranking", () => {
  it("does not infer meeting recency from transcript-relative start offsets", async () => {
    const shortOffsetMeeting = makeMeeting({
      authoritativeDurationMs: 400_000,
      meetingId: "meeting-short-offset",
      turns: [
        { endMs: 301_000, startMs: 300_000,
          text: `cedar status is approved ${"x".repeat(260)}`,
          turnId: "short-offset" },
        { endMs: 302_000, startMs: 301_000,
          text: `unrelated budget appendix ${"y".repeat(260)}`,
          turnId: "short-noise" },
      ],
    });
    const longOffsetMeeting = makeMeeting({
      authoritativeDurationMs: 3_400_000,
      meetingId: "meeting-long-offset",
      turns: [
        { endMs: 3_301_000, startMs: 3_300_000,
          text: `cedar status is approved ${"x".repeat(260)}`,
          turnId: "long-offset" },
        { endMs: 3_302_000, startMs: 3_301_000,
          text: `unrelated budget appendix ${"y".repeat(260)}`,
          turnId: "long-noise" },
      ],
    });
    const ids = new TestIds();
    const shortPlan = buildHistoricalIndexPlan(shortOffsetMeeting, ids, blockPolicy);
    const longPlan = buildHistoricalIndexPlan(longOffsetMeeting, ids, blockPolicy);
    const shortLocator = shortPlan.documents[0]?.manifest.candidateLocator;
    const longLocator = longPlan.documents[0]?.manifest.candidateLocator;
    if (shortLocator === undefined || longLocator === undefined) {
      throw new Error("temporal fixtures missing");
    }
    const memory: HistoricalMemoryPort = {
      deleteMeeting: vi.fn(),
      indexFinalMeeting: vi.fn(),
      searchRoom: vi.fn().mockResolvedValue({
        candidates: [
          { locator: shortLocator, providerRank: 0, providerScore: 0.8 },
          { locator: longLocator, providerRank: 0, providerScore: 0.8 },
        ],
        hybridQualified: true,
        status: "available",
      }),
    };
    const useCase = retrieval({
      meetings: [shortOffsetMeeting, longOffsetMeeting],
      memory,
      policy: { ...retrievalPolicy, neighborRadius: 0, rerankLimit: 2 },
      store: new AppliedStore([
        { binding: shortOffsetMeeting.binding, plan: shortPlan,
          remoteDocumentIds: {} },
        { binding: longOffsetMeeting.binding, plan: longPlan,
          remoteDocumentIds: {} },
      ]),
    });
    const result = await useCase.buildPlan({
      authorizationPrincipalRef: "principal",
      question: "What is the latest cedar status?",
      roomId: "room-1",
      scopeId: "scope-1",
      searchEnabled: true,
      servingAuthorized: true,
      sourceSet: "room",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error("cross-meeting temporal plan was not ready");
    }
    expect(result.plan.sources).toHaveLength(2);
    expect(result.plan.sources[0]?.qualifiedScore)
      .toBe(result.plan.sources[1]?.qualifiedScore);
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

});

describe("focused historical retrieval fail-safe behavior", () => {
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
