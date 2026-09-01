import { array, assert, constantFrom, property } from "fast-check";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_HISTORICAL_EVIDENCE_BLOCK_POLICY,
  DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE,
  HistoricalEvidenceInvariantError,
  admitAcceptedFinalMeeting,
  admitsHistoricalRetrieval,
  buildHistoricalIndexPlan,
  classifyHistoricalGroundingMode,
  createHistoricalReleaseBinding,
  decodeHistoricalIndexPlanV1,
  estimateHistoricalEmbeddingTokens,
  rehydrateHistoricalBlock,
  type HistoricalEmbeddingTokenizerPort,
  type HistoricalOpaqueIdPort,
} from "@discord-meeting/meeting-core/meeting-knowledge";

class DeterministicTestIds implements HistoricalOpaqueIdPort {
  public keyedId(namespace: string, parts: readonly string[]): string {
    let hash = 2_166_136_261;
    for (const character of `${namespace}\u0000${parts.join("\u0000")}`) {
      hash ^= character.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16_777_619) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }
}

function acceptedMeeting() {
  const binding = createHistoricalReleaseBinding({
    acceptedMeetingRevision: 7,
    desiredGeneration: 2,
    meetingId: "meeting-private-id",
    roomId: "room-private-id",
    scopeId: "guild-private-id",
    transcriptId: "transcript-private-id",
    transcriptVersion: 3,
  });
  return admitAcceptedFinalMeeting({
    actors: [
      { actorId: "human-a", kind: "human" },
      { actorId: "botik", kind: "automation" },
      { actorId: "unverified", kind: "unknown" },
    ],
    authoritativeDurationMs: 3_000,
    binding,
    identityProvenance: {
      actorObservationState: "consistent",
      actorSemanticsVersion: 1,
      producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
      producerRevision: "fixture-r1",
      rosterState: "sealed",
    },
    lifecycleGeneration: 3,
    meetingRevision: 7,
    roomId: binding.roomId,
    scopeId: binding.scopeId,
    transcriptId: binding.transcriptId,
    transcriptVersion: binding.transcriptVersion,
    turns: [
      { endMs: 2_000, speakerId: "botik", startMs: 1_000, text: "generated answer", turnId: "b" },
      { endMs: 1_000, speakerId: "human-a", startMs: 0, text: "accepted human evidence", turnId: "a" },
      { endMs: 3_000, speakerId: "unverified", startMs: 2_000, text: "unknown actor", turnId: "c" },
    ],
  });
}

describe("historical evidence admission and block identity", () => {
  it("admits only final turns positively bound to human actors", () => {
    const meeting = acceptedMeeting();

    expect(meeting?.humanTurns).toEqual([
      expect.objectContaining({ text: "accepted human evidence", turnId: "a" }),
    ]);
    expect(JSON.stringify(meeting)).not.toContain("generated answer");
    expect(JSON.stringify(meeting)).not.toContain("unknown actor");
  });

  it("denies legacy evidence and fails closed on a stale release binding", () => {
    const meeting = acceptedMeeting();
    expect(meeting).not.toBeNull();
    if (meeting === null) {
      throw new Error("fixture admission failed");
    }
    expect(admitAcceptedFinalMeeting({
      actors: null,
      binding: meeting.binding,
      identityProvenance: null,
      lifecycleGeneration: null,
      meetingRevision: 7,
      roomId: meeting.binding.roomId,
      scopeId: meeting.binding.scopeId,
      transcriptId: meeting.binding.transcriptId,
      transcriptVersion: meeting.binding.transcriptVersion,
      turns: [],
    })).toBeNull();
    expect(() => admitAcceptedFinalMeeting({
      actors: [{ actorId: "human-a", kind: "human" }],
      binding: meeting.binding,
      identityProvenance: {
        actorObservationState: "consistent",
        actorSemanticsVersion: 1,
        producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
        producerRevision: "fixture-r1",
        rosterState: "sealed",
      },
      lifecycleGeneration: 3,
      meetingRevision: 7,
      roomId: "another-room",
      scopeId: meeting.binding.scopeId,
      transcriptId: meeting.binding.transcriptId,
      transcriptVersion: meeting.binding.transcriptVersion,
      turns: meeting.humanTurns,
    })).toThrow(expect.objectContaining({
      code: "CONFLICTING_BINDING",
      name: HistoricalEvidenceInvariantError.name,
    }));
  });

  it("keeps long-meeting retrieval independently disabled at exact authoritative thresholds", () => {
    const short = acceptedMeeting();
    if (short === null) {
      throw new Error("fixture admission failed");
    }
    const durationThreshold = Object.freeze({
      ...short,
      authoritativeDurationMs:
        DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE.minimumDurationMs,
    });
    const turnThreshold = Object.freeze({
      ...short,
      humanTurns: Object.freeze(Array.from(
        { length: DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE.minimumHumanTurnCount },
        (_, index) => Object.freeze({
          ...short.humanTurns[0]!,
          endMs: index * 2 + 2,
          startMs: index * 2 + 1,
          turnId: `long-turn-${index}`,
        }),
      )),
    });
    const unknownDuration = Object.freeze({
      ...short,
      authoritativeDurationMs: null,
    });


    expect(admitsHistoricalRetrieval(short)).toBe(true);
    expect(admitsHistoricalRetrieval(durationThreshold)).toBe(false);
    expect(admitsHistoricalRetrieval(turnThreshold)).toBe(false);
    expect(admitsHistoricalRetrieval(unknownDuration)).toBe(false);
    expect(admitsHistoricalRetrieval(durationThreshold, {
      ...DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE,
      qualification: {
        evidenceSha256: "e".repeat(64),
        releaseRevision: "f".repeat(40),
        rolloutEpoch: "test-r1",
        schemaVersion: 1,
      },
    })).toBe(true);
  });

  it("builds replay-stable opaque topology and turn-aligned documents", () => {
    const meeting = acceptedMeeting();
    if (meeting === null) {
      throw new Error("fixture admission failed");
    }
    const ids = new DeterministicTestIds();
    const first = buildHistoricalIndexPlan(meeting, ids);
    const replay = buildHistoricalIndexPlan(meeting, ids);

    expect(replay).toEqual(first);
    expect(first.documents).toHaveLength(1);
    expect(first.documents[0]?.manifest.turnIds).toEqual(["a"]);
    expect(first.documents[0]?.remoteText).toContain("accepted human evidence");
    expect(JSON.stringify(first.topology)).not.toContain("private-id");
    expect(decodeHistoricalIndexPlanV1(JSON.parse(JSON.stringify(first)))).toEqual(first);
    const legacyTopology = Object.fromEntries(Object.entries(first.topology).filter(
      ([key]) => key !== "projectionContractVersion",
    ));
    expect(decodeHistoricalIndexPlanV1({
      ...first,
      topology: legacyTopology,
    }).topology.projectionContractVersion).toBe(
      "legacy.document-retrieval-projection.none",
    );
    expect(() => decodeHistoricalIndexPlanV1({ ...first, unexpected: true }))
      .toThrow("unknown field");
    expect(() => decodeHistoricalIndexPlanV1({
      ...first,
      documents: [{ ...first.documents[0], providerMetadata: "untrusted" }],
    })).toThrow("unknown field");
    expect(rehydrateHistoricalBlock(meeting, first, 0, ids).turns).toEqual([
      expect.objectContaining({
        ...meeting.humanTurns[0],
        sourceEndCodePoint: Array.from(meeting.humanTurns[0]!.text).length,
        sourceStartCodePoint: 0,
      }),
    ]);

    const source = first.documents[0]!.manifest.turnSources[0]!;
    const tampered = {
      ...first,
      documents: [{
        ...first.documents[0]!,
        manifest: {
          ...first.documents[0]!.manifest,
          turnSources: [{ ...source, sourceEndCodePoint: source.sourceEndCodePoint - 1 }],
        },
      }],
    };
    expect(() => rehydrateHistoricalBlock(meeting, tampered, 0, ids))
      .toThrow("historical candidate no longer matches canonical local evidence");
  });

  it("rehydrates from the persisted block without invoking the tokenizer", () => {
    const meeting = acceptedMeeting();
    if (meeting === null) {
      throw new Error("fixture admission failed");
    }
    let tokenCalls = 0;
    let rejectTokenCalls = false;
    const tokenizer: HistoricalEmbeddingTokenizerPort = Object.freeze({
      countTokens: (text: string) => {
        tokenCalls += 1;
        if (rejectTokenCalls) {
          throw new Error("query-time tokenizer invocation");
        }
        return estimateHistoricalEmbeddingTokens(text);
      },
      profile: Object.freeze({
        conformanceVectorSetSha256: `sha256:${"a".repeat(64)}`,
        embeddingModelRevision: "b".repeat(40),
        id: "fixture-query-isolation-tokenizer",
        maxInputTokens: 96,
        servingRuntimeRevision: "c".repeat(40),
        tokenizerArtifactSha256: `sha256:${"d".repeat(64)}`,
        tokenizerConfigSha256: `sha256:${"e".repeat(64)}`,
      }),
    });
    const ids = new DeterministicTestIds();
    const plan = buildHistoricalIndexPlan(
      meeting,
      ids,
      DEFAULT_HISTORICAL_EVIDENCE_BLOCK_POLICY,
      tokenizer,
    );
    const planningTokenCalls = tokenCalls;
    rejectTokenCalls = true;

    expect(rehydrateHistoricalBlock(meeting, plan, 0, ids, {
      policy: DEFAULT_HISTORICAL_EVIDENCE_BLOCK_POLICY,
      tokenizer,
    }).turns).toHaveLength(1);
    expect(tokenCalls).toBe(planningTokenCalls);
  });

  it("fails closed when persisted block sources or derived identities are tampered", () => {
    const meeting = acceptedMeeting();
    if (meeting === null) {
      throw new Error("fixture admission failed");
    }
    const ids = new DeterministicTestIds();
    const plan = buildHistoricalIndexPlan(meeting, ids);
    const document = plan.documents[0]!;
    const source = document.manifest.turnSources[0]!;
    const changedDocument = (
      changes: Partial<typeof document>,
      manifestChanges: Partial<typeof document.manifest> = {},
    ) => ({
      ...plan,
      documents: [{
        ...document,
        ...changes,
        manifest: { ...document.manifest, ...manifestChanges },
      }],
    });
    const tamperedPlans = [
      changedDocument({}, {
        turnSources: [{ ...source, sourceRef: `${source.sourceRef}-tampered` }],
      }),
      changedDocument({}, { contentHash: `${document.manifest.contentHash}-tampered` }),
      { ...plan, topology: { ...plan.topology, releaseRef: "tampered-release" } },
      { ...plan, binding: { ...plan.binding, acceptedMeetingRevision: 8 } },
    ];

    for (const tampered of tamperedPlans) {
      expect(() => rehydrateHistoricalBlock(meeting, tampered, 0, ids))
        .toThrow("historical candidate no longer matches canonical local evidence");
    }
  });
});

describe("historical evidence bounded embedding windows", () => {
  it("builds clean bounded multilingual windows with exact authoritative ranges", () => {
    const base = acceptedMeeting();
    if (base === null) {
      throw new Error("fixture admission failed");
    }
    const texts = [
      "Мария уточнила срок релиза на следующий вторник.",
      "Vitaliy confirmed the rollback owner and the no-downtime constraint.",
      "Nazar сказал: API gateway remains compatible после миграции.",
      `Длинная реплика ${"безопасность контекст восстановление ".repeat(18)}`,
      "Iliya corrected the earlier date and Mark acknowledged it.",
      "Финальное решение принято, ответственный Дима.",
      "The evidence must retain speaker attribution and exact timing.",
      "Следующая тема - наблюдаемость и алерты.",
      "No customer data is copied into retrieval metadata.",
    ];
    const meeting = Object.freeze({
      ...base,
      authoritativeDurationMs: 90_000,
      humanTurns: Object.freeze(texts.map((text, index) => Object.freeze({
        endMs: (index + 1) * 10_000,
        speakerId: index % 2 === 0 ? "human-a" : "human-b",
        startMs: index * 10_000,
        text,
        turnId: `turn-${index}`,
      }))),
    });
    const ids = new DeterministicTestIds();
    const policy = Object.freeze({
      maximumEmbeddingTokens: 32,
      maxBlockUtf8Bytes: 4_096,
      maxBlocksPerMeeting: 100,
      maxTurnsPerBlock: 8,
      turnOverlap: 2,
      version: "meeting-knowledge.block-policy.v1" as const,
    });
    const first = buildHistoricalIndexPlan(meeting, ids, policy);

    expect(buildHistoricalIndexPlan(meeting, ids, policy)).toEqual(first);
    expect(decodeHistoricalIndexPlanV1(JSON.parse(JSON.stringify(first)))).toEqual(first);
    expect(new Set(first.documents.flatMap(({ manifest }) => manifest.turnIds)))
      .toEqual(new Set(meeting.humanTurns.map(({ turnId }) => turnId)));
    expect(first.documents.some((document, index) => {
      const next = first.documents[index + 1];
      return next !== undefined && document.manifest.turnIds.some((turnId) =>
        next.manifest.turnIds.includes(turnId)
      );
    })).toBe(true);
    for (const document of first.documents) {
      expect(document.embeddingText).not.toMatch(/turn=|start_ms=|mkcandidate/iu);
      expect(estimateHistoricalEmbeddingTokens(document.embeddingText))
        .toBe(document.manifest.embeddingTokenEstimate);
      expect(document.manifest.embeddingTokenEstimate)
        .toBeLessThanOrEqual(document.manifest.embeddingTokenLimit);
      for (const source of document.manifest.turnSources) {
        const turn = meeting.humanTurns.find(({ turnId }) => turnId === source.turnId);
        expect(turn).toBeDefined();
        expect(Array.from(document.embeddingText)
          .slice(source.embeddingStartCodePoint, source.embeddingEndCodePoint).join(""))
          .toBe(Array.from(turn?.text ?? "")
            .slice(source.sourceStartCodePoint, source.sourceEndCodePoint).join(""));
        expect(source).toMatchObject({
          endMs: turn?.endMs,
          speakerId: turn?.speakerId,
          startMs: turn?.startMs,
        });
      }
    }
  });

});

describe("historical evidence long meeting bounds", () => {
  it("keeps evidence near the end of a turn larger than 24 KB selectable", () => {
    const base = acceptedMeeting();
    if (base === null) {
      throw new Error("fixture admission failed");
    }
    const marker = "PROJECT_ORBIT_FINAL_OWNER_MARIA";
    const text = `${"длинный контекст встречи и решения команды ".repeat(700)}${marker}`;
    expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(24 * 1_024);
    const meeting = Object.freeze({
      ...base,
      humanTurns: Object.freeze([Object.freeze({
        endMs: 60_000,
        speakerId: "human-a",
        startMs: 0,
        text,
        turnId: "long-turn",
      })]),
    });
    const ids = new DeterministicTestIds();
    const plan = buildHistoricalIndexPlan(meeting, ids);
    const ordinal = plan.documents.findIndex(({ embeddingText }) => embeddingText.includes(marker));

    expect(ordinal).toBeGreaterThanOrEqual(0);
    expect(plan.documents.length).toBeGreaterThan(1);
    const block = rehydrateHistoricalBlock(meeting, plan, ordinal, ids);
    expect(block.turns).toHaveLength(1);
    expect(block.turns[0]?.text).toContain(marker);
    expect(block.turns[0]?.text).toBe(Array.from(text).slice(
      block.turns[0]?.sourceStartCodePoint,
      block.turns[0]?.sourceEndCodePoint,
    ).join(""));
  });

  it("preserves coverage and stable IDs for bounded generated turn sequences", () => {
    const base = acceptedMeeting();
    if (base === null) {
      throw new Error("fixture admission failed");
    }
    assert(property(array(constantFrom(
      "короткая русская реплика",
      "short English statement",
      "mixed API решение confirmed",
      "emoji 🚀 remains source evidence",
    ), { minLength: 1, maxLength: 40 }), (texts) => {
      const meeting = Object.freeze({
        ...base,
        humanTurns: Object.freeze(texts.map((text, index) => Object.freeze({
          endMs: index * 10 + 9,
          speakerId: `speaker-${index % 3}`,
          startMs: index * 10,
          text,
          turnId: `generated-${index}`,
        }))),
      });
      const ids = new DeterministicTestIds();
      const policy = Object.freeze({
        maximumEmbeddingTokens: 24,
        maxBlockUtf8Bytes: 4_096,
        maxBlocksPerMeeting: 100,
        maxTurnsPerBlock: 8,
        turnOverlap: 2,
        version: "meeting-knowledge.block-policy.v1" as const,
      });
      const first = buildHistoricalIndexPlan(meeting, ids, policy);
      const second = buildHistoricalIndexPlan(meeting, ids, policy);
      expect(second.planDigest).toBe(first.planDigest);
      expect(second.documents.map(({ manifest }) => manifest.candidateLocator))
        .toEqual(first.documents.map(({ manifest }) => manifest.candidateLocator));
      expect(new Set(first.documents.flatMap(({ manifest }) => manifest.turnIds)))
        .toEqual(new Set(meeting.humanTurns.map(({ turnId }) => turnId)));
      expect(first.documents.every(({ manifest }) =>
        manifest.embeddingTokenEstimate <= manifest.embeddingTokenLimit
      )).toBe(true);
    }), { seed: 1_703_311_337 });
  });

  it("keeps a 1779-turn two-hour corpus within the qualified 500-window bound", () => {
    const base = acceptedMeeting();
    if (base === null) {
      throw new Error("fixture admission failed");
    }
    const meeting = Object.freeze({
      ...base,
      authoritativeDurationMs: 7_200_000,
      humanTurns: Object.freeze(Array.from({ length: 1_779 }, (_, index) => Object.freeze({
        endMs: index * 4_000 + 3_900,
        speakerId: `speaker-${index % 7}`,
        startMs: index * 4_000,
        text: index % 3 === 0
          ? `Routine English planning segment ${index} with release context.`
          : index % 3 === 1
            ? `Обычное русское обсуждение ${index} с контекстом релиза.`
            : `Mixed планирование ${index} and operational follow-up.`,
        turnId: `two-hour-turn-${index}`,
      }))),
    });
    const policy = Object.freeze({
      maximumEmbeddingTokens: 96,
      maxBlockUtf8Bytes: 4_096,
      maxBlocksPerMeeting: 500,
      maxTurnsPerBlock: 14,
      turnOverlap: 2,
      version: "meeting-knowledge.block-policy.v1" as const,
    });
    const plan = buildHistoricalIndexPlan(meeting, new DeterministicTestIds(), policy);

    expect(plan.documents.length).toBeLessThanOrEqual(500);
    expect(plan.documents.length).toBeGreaterThan(100);
    expect(new Set(plan.documents.flatMap(({ manifest }) => manifest.turnIds)).size)
      .toBe(meeting.humanTurns.length);
    expect(plan.documents.every(({ manifest }) =>
      manifest.embeddingTokenEstimate <= manifest.embeddingTokenLimit
    )).toBe(true);
  });

  it("reduces overlap deterministically before rejecting a meeting at the 500-window cap", () => {
    const base = acceptedMeeting();
    if (base === null) {
      throw new Error("fixture admission failed");
    }
    const meeting = Object.freeze({
      ...base,
      humanTurns: Object.freeze(Array.from({ length: 1_003 }, (_, index) => Object.freeze({
        endMs: index * 10 + 9,
        speakerId: "human-a",
        startMs: index * 10,
        text: `turn ${index}`,
        turnId: `adaptive-${index}`,
      }))),
    });
    const ids = new DeterministicTestIds();
    const policy = Object.freeze({
      maximumEmbeddingTokens: 512,
      maxBlockUtf8Bytes: 4_096,
      maxBlocksPerMeeting: 500,
      maxTurnsPerBlock: 4,
      turnOverlap: 2,
      version: "meeting-knowledge.block-policy.v1" as const,
    });
    const plan = buildHistoricalIndexPlan(meeting, ids, policy);
    const explicit = buildHistoricalIndexPlan(meeting, ids, { ...policy, turnOverlap: 1 });

    expect(plan.effectiveTurnOverlap).toBe(1);
    expect(plan.documents.length).toBeLessThanOrEqual(500);
    expect(plan).toEqual(explicit);
    expect(plan.planDigest).toContain("mkplan1.");
  });

  it("accepts exactly 500 windows and rejects the 501st", () => {
    const base = acceptedMeeting();
    if (base === null) {
      throw new Error("fixture admission failed");
    }
    const meeting = (turnCount: number) => Object.freeze({
      ...base,
      humanTurns: Object.freeze(Array.from({ length: turnCount }, (_, index) => Object.freeze({
        endMs: index * 10 + 9,
        speakerId: "human-a",
        startMs: index * 10,
        text: `bounded turn ${index}`,
        turnId: `bounded-${index}`,
      }))),
    });
    const policy = Object.freeze({
      maximumEmbeddingTokens: 96,
      maxBlockUtf8Bytes: 4_096,
      maxBlocksPerMeeting: 500,
      maxTurnsPerBlock: 1,
      turnOverlap: 0,
      version: "meeting-knowledge.block-policy.v1" as const,
    });
    expect(() => buildHistoricalIndexPlan(meeting(1), new DeterministicTestIds(), {
      ...policy,
      maxBlocksPerMeeting: 501,
    })).toThrow("historical evidence block policy is outside its qualified bounds");

    expect(buildHistoricalIndexPlan(meeting(500), new DeterministicTestIds(), policy).documents)
      .toHaveLength(500);
    expect(() => buildHistoricalIndexPlan(meeting(501), new DeterministicTestIds(), policy))
      .toThrow(expect.objectContaining({ code: "BLOCK_LIMIT_EXCEEDED" }));
  });

  it.each([
    "Count every action item across all meetings",
    "Were there no mentions of Project Cedar?",
    "Сколько раз это обсуждали во всю историю?",
    "Give me the complete list",
    "List the decisions from these meetings",
    "Summarize the project history",
    "Какие решения были приняты?",
    "Перечисли риски проекта",
  ])("routes exhaustive truth claims away from top-k: %s", (question) => {
    expect(classifyHistoricalGroundingMode(question)).toBe("exhaustive_coverage");
  });

  it("keeps focused lookup as the bounded default", () => {
    expect(classifyHistoricalGroundingMode("What date did Maya propose for launch?"))
      .toBe("focused_retrieval");
  });
});
