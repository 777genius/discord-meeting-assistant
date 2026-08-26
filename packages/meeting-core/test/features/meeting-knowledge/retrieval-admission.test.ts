import { describe, expect, it } from "vitest";

import {
  MeetingKnowledgeInvariantError,
  retrievalRolloutBucket,
  retrievalV2Selected,
  sameFocusedLocatorRetrievalV2Value,
  selectRetrievalBinding,
} from "@discord-meeting/meeting-core/meeting-knowledge";

const rollout = Object.freeze({
  cutoverEpoch: "cutover-r1",
  infinityProfileFingerprint: "a".repeat(64),
  infinityRolloutBasisPoints: 5_000,
  legacyProfileFingerprint: "b".repeat(64),
});

const request = Object.freeze({
  binding: Object.freeze({
    capabilityFingerprint: "c".repeat(64), contractVersion: "context-retrieval.v2" as const,
    indexProfileDigest: "d".repeat(64), profileId: "profile-v2",
    rankingPolicy: "weighted_rrf_canonical_preferences.v1" as const,
    requiredProviderLanes: Object.freeze(["postgres_keyword", "qdrant_dense"]),
    serviceRevision: "revision-v2",
  }),
  budgets: Object.freeze({ candidateLimit: 100, deadlineMs: 1_000,
    evidenceByteLimit: 24_000, neighborRadius: 0 as const,
    responseByteLimit: 16_384, resultLimit: 8 }),
  filters: Object.freeze({ actorKeys: Object.freeze(["actor-1"]), category: null,
    documentKeys: Object.freeze([]), excludedSourceKeys: Object.freeze([]),
    kinds: Object.freeze(["record_block"]), relativeTimeInterval: null,
    sourceGenerations: Object.freeze([{ projectionGeneration: "generation-1",
      sourceKey: "source-1" }]), tagsAll: Object.freeze([]),
    tagsAny: Object.freeze([]), tagsNone: Object.freeze([]), timeInterval: null }),
  queries: Object.freeze([{ query: "Когда launch?", queryId: "question-01",
    weightMicros: 1_000_000 }]), schemaVersion: 2 as const,
  scope: Object.freeze({ memoryScopeId: "scope-1", spaceId: "space-1",
    threadId: null }),
  softPreferences: Object.freeze({ actorPreferences: Object.freeze([]),
    relativeTimeInterval: null, sourcePreferences: Object.freeze([]),
    timeInterval: null, timeWeightMicros: null }),
});

function select(questionId: string, selectedRollout = rollout) {
  return selectRetrievalBinding({ questionId, retrievalV2Request: request,
    rollout: selectedRollout });
}

function expectInvalidRequest(mutator: (value: MutableRequest) => void): void {
  const invalid = structuredClone(request) as unknown as MutableRequest;
  mutator(invalid);
  expect(() => selectRetrievalBinding({
    questionId: "question-invalid",
    retrievalV2Request: invalid as unknown as typeof request,
    rollout: { ...rollout, infinityRolloutBasisPoints: 10_000 },
  })).toThrow(MeetingKnowledgeInvariantError);
}

interface MutableRequest {
  [key: string]: unknown;
  binding: Record<string, unknown> & { requiredProviderLanes: string[] };
  budgets: Record<string, number>;
  filters: Record<string, unknown> & {
    actorKeys: string[];
    documentKeys: string[];
    excludedSourceKeys: string[];
    kinds: string[];
    relativeTimeInterval: Record<string, unknown> | null;
    sourceGenerations: Array<Record<string, string>>;
    tagsAll: string[];
    tagsNone?: string[];
    timeInterval: Record<string, unknown> | null;
  };
  queries: Array<Record<string, unknown>>;
  scope: Record<string, unknown>;
  softPreferences: Record<string, unknown> & {
    actorPreferences: Array<Record<string, unknown>>;
    relativeTimeInterval: Record<string, unknown> | null;
    sourcePreferences: Array<Record<string, unknown>>;
    timeWeightMicros: number | null;
  };
}

describe("immutable retrieval admission selection", () => {
  it("is stable for the exact job identity and named epoch", () => {
    const first = select("question-42");
    const retry = select("question-42");
    expect(retry.toSnapshot()).toEqual(first.toSnapshot());
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("makes zero and ten thousand basis points exact", () => {
    expect(selectRetrievalBinding({
      questionId: "question-6591",
      rollout: { ...rollout, infinityRolloutBasisPoints: 0 },
    }).toSnapshot()).toEqual({
      cutoverEpoch: "cutover-r1",
      profileFingerprint: "b".repeat(64),
      retrievalPath: "legacy_downstream_v1",
    });
    expect(selectRetrievalBinding({
      questionId: "question-13274",
      retrievalV2Request: request,
      rollout: { ...rollout, infinityRolloutBasisPoints: 10_000 },
    }).toSnapshot()).toEqual({
      cutoverEpoch: "cutover-r1",
      profileFingerprint: "a".repeat(64),
      request,
      retrievalPath: "infinity_locator_v2",
    });
  });

  it("uses an inclusive lower and exclusive upper bucket boundary", () => {
    expect(retrievalRolloutBucket({
      cutoverEpoch: "cutover-r1",
      questionId: "question-391",
    })).toBe(4_999);
    expect(retrievalRolloutBucket({
      cutoverEpoch: "cutover-r1",
      questionId: "question-3325",
    })).toBe(5_000);
    expect(selectRetrievalBinding({
      questionId: "question-391",
      retrievalV2Request: request,
      rollout,
    }).retrievalPath).toBe("infinity_locator_v2");
    expect(selectRetrievalBinding({
      questionId: "question-3325",
      rollout,
    }).retrievalPath).toBe("legacy_downstream_v1");
  });

  it("binds path, selected profile, and epoch changes independently", () => {
    const legacy = selectRetrievalBinding({
      questionId: "question-42",
      rollout: { ...rollout, infinityRolloutBasisPoints: 0 },
    }).toSnapshot();
    const infinity = selectRetrievalBinding({
      questionId: "question-42",
      retrievalV2Request: request,
      rollout: { ...rollout, infinityRolloutBasisPoints: 10_000 },
    }).toSnapshot();
    const newProfile = selectRetrievalBinding({
      questionId: "question-42",
      retrievalV2Request: request,
      rollout: {
        ...rollout,
        infinityProfileFingerprint: "c".repeat(64),
        infinityRolloutBasisPoints: 10_000,
      },
    }).toSnapshot();
    const rollbackEpoch = selectRetrievalBinding({
      questionId: "question-42",
      rollout: {
        ...rollout,
        cutoverEpoch: "rollback-r2",
        infinityRolloutBasisPoints: 0,
      },
    }).toSnapshot();
    expect(infinity.retrievalPath).not.toBe(legacy.retrievalPath);
    expect(newProfile.profileFingerprint).not.toBe(infinity.profileFingerprint);
    expect(rollbackEpoch).toMatchObject({
      cutoverEpoch: "rollback-r2",
      retrievalPath: "legacy_downstream_v1",
    });
  });

  it("rejects unbounded, unnamed, or malformed rollout configuration", () => {
    for (const invalid of [
      { ...rollout, infinityRolloutBasisPoints: -1 },
      { ...rollout, infinityRolloutBasisPoints: 10_001 },
      { ...rollout, infinityRolloutBasisPoints: 0.5 },
      { ...rollout, cutoverEpoch: "Not Named" },
      { ...rollout, infinityProfileFingerprint: "not-a-fingerprint" },
      { ...rollout, legacyProfileFingerprint: "not-a-fingerprint" },
    ]) {
      expect(() => selectRetrievalBinding({
        questionId: "question-42",
        rollout: invalid,
      })).toThrow(MeetingKnowledgeInvariantError);
      expect(() => retrievalV2Selected({
        questionId: "question-42",
        rollout: invalid,
      })).toThrow(MeetingKnowledgeInvariantError);
    }
    expect(() => selectRetrievalBinding({
      questionId: " ",
      rollout: { ...rollout, infinityRolloutBasisPoints: 0 },
    })).toThrow(MeetingKnowledgeInvariantError);
  });

  it("compares persisted V2 values independently of JSONB key order", () => {
    const reordered = {
      softPreferences: request.softPreferences,
      scope: request.scope,
      schemaVersion: request.schemaVersion,
      queries: request.queries,
      filters: request.filters,
      budgets: request.budgets,
      binding: {
        serviceRevision: request.binding.serviceRevision,
        requiredProviderLanes: request.binding.requiredProviderLanes,
        rankingPolicy: request.binding.rankingPolicy,
        profileId: request.binding.profileId,
        indexProfileDigest: request.binding.indexProfileDigest,
        contractVersion: request.binding.contractVersion,
        capabilityFingerprint: request.binding.capabilityFingerprint,
      },
    } as typeof request;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(request));
    expect(sameFocusedLocatorRetrievalV2Value(request, reordered)).toBe(true);
    expect(sameFocusedLocatorRetrievalV2Value(request, {
      ...reordered,
      binding: { ...reordered.binding, profileId: "drifted-profile" },
    })).toBe(false);
  });

  it("rejects unknown, partial, version-drifted, and malformed binding values", () => {
    expectInvalidRequest((value) => { value.extra = true; });
    expectInvalidRequest((value) => { value.binding.extra = true; });
    expectInvalidRequest((value) => { delete value.filters.tagsNone; });
    expectInvalidRequest((value) => { value.schemaVersion = 3; });
    expectInvalidRequest((value) => { value.binding.contractVersion = "context-retrieval.v3"; });
    expectInvalidRequest((value) => { value.binding.rankingPolicy = "drifted-policy"; });
    expectInvalidRequest((value) => { value.binding.capabilityFingerprint = "f".repeat(63); });
    expectInvalidRequest((value) => { value.binding.indexProfileDigest = "F".repeat(64); });
    expectInvalidRequest((value) => { value.binding.profileId = " "; });
    expectInvalidRequest((value) => { value.scope.threadId = "bad\u0000thread"; });
    expectInvalidRequest((value) => { value.scope.spaceId = "\uD800"; });
  });

  it("rejects every unsafe request, response, deadline, result, and evidence bound", () => {
    for (const [key, invalid] of [
      ["candidateLimit", 0], ["candidateLimit", 1_001],
      ["resultLimit", 0], ["resultLimit", 51],
      ["deadlineMs", 0], ["deadlineMs", 2_001],
      ["responseByteLimit", 16_383], ["responseByteLimit", 1_048_577],
      ["evidenceByteLimit", 0], ["evidenceByteLimit", 24_001],
      ["neighborRadius", 1], ["candidateLimit", Number.NaN],
      ["deadlineMs", Number.POSITIVE_INFINITY], ["resultLimit", 1.5],
      ["candidateLimit", Number.MAX_SAFE_INTEGER + 1],
    ] as const) {
      expectInvalidRequest((value) => { value.budgets[key] = invalid; });
    }
    expectInvalidRequest((value) => {
      value.budgets.candidateLimit = 2;
      value.budgets.resultLimit = 3;
    });
  });

  it("rejects oversized, duplicate, or reordered query identities and bytes", () => {
    expectInvalidRequest((value) => { value.queries = []; });
    expectInvalidRequest((value) => {
      value.queries = Array.from({ length: 7 }, (_, index) => ({
        query: "valid query", queryId: `q-${index}`,
      }));
    });
    expectInvalidRequest((value) => { value.queries[0]!.query = "я".repeat(257); });
    expectInvalidRequest((value) => { value.queries[0]!.query = "two  spaces"; });
    expectInvalidRequest((value) => { value.queries[0]!.weightMicros = 99_999; });
    expectInvalidRequest((value) => { value.queries[0]!.weightMicros = 10_000_001; });
    expectInvalidRequest((value) => {
      value.queries = [
        { query: "second", queryId: "q-2" },
        { query: "first", queryId: "q-1" },
      ];
    });
    expectInvalidRequest((value) => {
      value.queries = [
        { query: "first", queryId: "q-1" },
        { query: "second", queryId: "q-1" },
      ];
    });
  });

  it("rejects duplicate, reordered, overlapping, or oversized source and filter identities", () => {
    expectInvalidRequest((value) => { value.filters.sourceGenerations = []; });
    expectInvalidRequest((value) => {
      value.filters.sourceGenerations = [
        { projectionGeneration: "g-2", sourceKey: "source-2" },
        { projectionGeneration: "g-1", sourceKey: "source-1" },
      ];
    });
    expectInvalidRequest((value) => {
      value.filters.sourceGenerations = [
        { projectionGeneration: "g-1", sourceKey: "source-1" },
        { projectionGeneration: "g-2", sourceKey: "source-1" },
      ];
    });
    expectInvalidRequest((value) => { value.filters.actorKeys = ["b", "a"]; });
    expectInvalidRequest((value) => { value.filters.kinds = ["record_block", "record_block"]; });
    expectInvalidRequest((value) => { value.filters.tagsAll = ["same"]; value.filters.tagsNone = ["same"]; });
    expectInvalidRequest((value) => { value.filters.excludedSourceKeys = ["source-1"]; });
    expectInvalidRequest((value) => {
      value.filters.documentKeys = Array.from({ length: 101 }, () => "same");
    });
    expectInvalidRequest((value) => { value.binding.requiredProviderLanes = ["qdrant_dense", "postgres_keyword"]; });
    expectInvalidRequest((value) => { value.binding.requiredProviderLanes = ["postgres_keyword", "postgres_keyword"]; });
    expectInvalidRequest((value) => { value.binding.requiredProviderLanes = []; });
    expectInvalidRequest((value) => { value.binding.requiredProviderLanes = ["a", "b", "c", "d", "e"]; });
  });

  it("rejects inconsistent absolute, relative, and weighted preference policy", () => {
    expectInvalidRequest((value) => {
      value.filters.relativeTimeInterval = { startMs: 2, endMs: 1 };
    });
    expectInvalidRequest((value) => {
      value.filters.timeInterval = {
        startAt: "2026-02-30T00:00:00Z", endAt: "2026-03-01T00:00:00Z",
      };
    });
    expectInvalidRequest((value) => {
      value.filters.timeInterval = {
        startAt: "2026-03-02T00:00:00Z", endAt: "2026-03-01T00:00:00Z",
      };
    });
    expectInvalidRequest((value) => {
      value.filters.timeInterval = {
        startAt: "2026-03-01T00:00:00Z", endAt: "2026-03-02T00:00:00Z",
      };
      value.filters.relativeTimeInterval = { startMs: 0, endMs: 1 };
    });
    expectInvalidRequest((value) => { value.softPreferences.timeWeightMicros = 1_000_000; });
    expectInvalidRequest((value) => {
      value.softPreferences.relativeTimeInterval = { startMs: 0, endMs: 1 };
      value.softPreferences.timeWeightMicros = null;
    });
    expectInvalidRequest((value) => {
      value.softPreferences.actorPreferences = [
        { key: "b", weightMicros: 1_000_000 },
        { key: "a", weightMicros: 1_000_000 },
      ];
    });
    expectInvalidRequest((value) => {
      value.softPreferences.sourcePreferences = [
        { key: "a", weightMicros: 1_000_000 },
        { key: "a", weightMicros: 1_000_000 },
      ];
    });
  });

  it("deep-freezes the exact persisted request snapshot", () => {
    const binding = selectRetrievalBinding({
      questionId: "question-frozen",
      retrievalV2Request: structuredClone(request),
      rollout: { ...rollout, infinityRolloutBasisPoints: 10_000 },
    }).toSnapshot();
    expect(binding.retrievalPath).toBe("infinity_locator_v2");
    if (binding.retrievalPath !== "infinity_locator_v2") {
      throw new Error("test requires a Retrieval V2 binding");
    }
    expect(Object.isFrozen(binding.request)).toBe(true);
    expect(Object.isFrozen(binding.request.binding.requiredProviderLanes)).toBe(true);
    expect(Object.isFrozen(binding.request.filters.sourceGenerations[0])).toBe(true);
  });
});
