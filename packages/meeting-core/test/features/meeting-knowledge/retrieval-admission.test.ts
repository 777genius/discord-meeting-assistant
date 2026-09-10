import { describe, expect, it } from "vitest";

import {
  MeetingKnowledgeInvariantError,
  RetrievalBinding,
  sameFocusedLocatorRetrievalV2Value,
  selectRetrievalBinding,
  type FocusedLocatorRetrievalV2RequestSnapshot,
} from "@discord-meeting/meeting-core/meeting-knowledge";

const rollout = Object.freeze({
  cutoverEpoch: "infinity-v2-only-r1",
  infinityProfileFingerprint: "a".repeat(64),
  localProfileFingerprint: "b".repeat(64),
});

const request: FocusedLocatorRetrievalV2RequestSnapshot = Object.freeze({
  binding: Object.freeze({
    capabilityFingerprint: "c".repeat(64),
    contractVersion: "context-retrieval.v2" as const,
    indexProfileDigest: "d".repeat(64),
    profileId: "profile-v2",
    rankingPolicy: "weighted_rrf_canonical_preferences.v1" as const,
    requiredProviderLanes: Object.freeze(["postgres_keyword", "qdrant_dense"]),
    serviceRevision: "revision-v2",
  }),
  budgets: Object.freeze({ candidateLimit: 100, deadlineMs: 1_000,
    evidenceByteLimit: 16_000, neighborRadius: 0 as const,
    responseByteLimit: 16_384, resultLimit: 10 }),
  filters: Object.freeze({ actorKeys: Object.freeze(["actor-1"]), category: null,
    documentKeys: Object.freeze([]), excludedSourceKeys: Object.freeze([]),
    kinds: Object.freeze(["record_block"]), relativeTimeInterval: null,
    sourceGenerations: Object.freeze([{ projectionGeneration: "generation-1",
      sourceKey: "source-1" }]), tagsAll: Object.freeze([]),
    tagsAny: Object.freeze([]), tagsNone: Object.freeze([]), timeInterval: null }),
  queries: Object.freeze([{ query: "Когда launch?", queryId: "original-question" }]),
  schemaVersion: 2 as const,
  scope: Object.freeze({ memoryScopeId: "scope-1", spaceId: "space-1",
    threadId: null }),
  softPreferences: Object.freeze({ actorPreferences: Object.freeze([]),
    relativeTimeInterval: null, sourcePreferences: Object.freeze([]),
    timeInterval: null, timeWeightMicros: null }),
});

describe("Retrieval V2-only admission", () => {
  it("binds every new job to one exact persisted V2 request", () => {
    expect(selectRetrievalBinding({ questionId: "question-42",
      retrievalV2Request: request, rollout }).toSnapshot()).toMatchObject({
      cutoverEpoch: "infinity-v2-only-r1",
      profileFingerprint: "a".repeat(64),
      request,
      retrievalPath: "infinity_locator_v2",
    });
  });

  it("keeps legacy route snapshots readable for drain audits", () => {
    expect(RetrievalBinding.create({
      canonicalEvidenceFilters: { relativeTimeInterval: null,
        requiresSpeakerMatch: false, speakerIds: [] },
      cutoverEpoch: "old-rollout",
      localCurrentIdentity: { algorithmId: "canonical_local_exact_lexical_v1",
        profileFingerprint: "b".repeat(64),
        profileId: "meeting-knowledge.local-current.v2" },
      originalQuestion: "legacy drain audit",
      profileFingerprint: "b".repeat(64),
      provenanceSchemaVersion: 1,
      retrievalPath: "legacy_downstream_v1",
    }).toSnapshot()).toMatchObject({ retrievalPath: "legacy_downstream_v1" });
  });

  it("binds an explicit canonical local path when no indexed source is available", () => {
    expect(selectRetrievalBinding({ questionId: "question-first-meeting",
      retrievalV2Request: null, rollout }).toSnapshot()).toMatchObject({
      cutoverEpoch: "infinity-v2-only-r1",
      profileFingerprint: "b".repeat(64),
      retrievalPath: "canonical_local_exact_lexical_v1",
    });
  });

  it("rejects malformed admission identity and request drift", () => {
    expect(() => selectRetrievalBinding({
      questionId: "question-42",
      retrievalV2Request: { ...request, transcript: "forbidden" } as
        FocusedLocatorRetrievalV2RequestSnapshot,
      rollout,
    })).toThrow(MeetingKnowledgeInvariantError);
    expect(() => selectRetrievalBinding({
      questionId: "question-42",
      retrievalV2Request: request,
      rollout: { ...rollout, infinityProfileFingerprint: "invalid" },
    })).toThrow(MeetingKnowledgeInvariantError);
  });

  it("compares persisted requests independently of JSON object key order", () => {
    const reordered = {
      softPreferences: request.softPreferences,
      scope: request.scope,
      schemaVersion: request.schemaVersion,
      queries: request.queries,
      filters: request.filters,
      budgets: request.budgets,
      binding: request.binding,
    } as FocusedLocatorRetrievalV2RequestSnapshot;
    expect(sameFocusedLocatorRetrievalV2Value(request, reordered)).toBe(true);
  });
});

// V3 grows the independently versioned durable binding; V2 remains exact/null.
describe("Retrieval V3 durable admission", () => {
  const base = selectRetrievalBinding({ questionId: "question-v3",
    retrievalV2Request: request, rollout }).toSnapshot();
  const v3Request = (thread: { mode: "any" } | { mode: "exact"; id: string | null }) => ({
    ...structuredClone(request),
    binding: { ...request.binding, contractVersion: "context-retrieval.v3" },
    schemaVersion: 3,
    scope: { memoryScopeId: "scope-1", spaceId: "space-1", thread },
  });
  const admit = (value: unknown) => RetrievalBinding.create({
    ...base, request: value, retrievalPath: "infinity_locator_v3",
  } as unknown as Parameters<typeof RetrievalBinding.create>[0]);

  it.each([{ mode: "any" }, { mode: "exact", id: "thread-1" },
    { mode: "exact", id: null }] as const)("preserves and freezes selector %j", (thread) => {
    const input = v3Request(thread);
    const binding = admit(input);
    expect(binding.toSnapshot()).toMatchObject({ request: input,
      retrievalPath: "infinity_locator_v3" });
    expect(Object.isFrozen(binding.request?.scope)).toBe(true);
    if (binding.request?.schemaVersion !== 3) {throw new Error("V3 request lost");}
    expect(Object.isFrozen(binding.request.scope.thread)).toBe(true);
    input.scope.spaceId = "mutated-space";
    expect(binding.request?.scope.spaceId).toBe("space-1");
    expect(admit(JSON.parse(JSON.stringify(binding.request))).toSnapshot())
      .toEqual(binding.toSnapshot());
  });

  it.each([
    {}, { mode: "any", id: null }, { mode: "exact" },
    { mode: "all" }, { mode: "exact", id: "" },
    { mode: "exact", id: null, extra: true },
  ])("rejects non-contract selectors %j", (thread) => {
    const input = v3Request({ mode: "any" });
    expect(() => admit({ ...input, scope: { ...input.scope, thread } })).toThrow();
  });

  it("rejects mixed version, contract and scope shapes", () => {
    const input = v3Request({ mode: "any" });
    for (const invalid of [
      { ...input, schemaVersion: 2 },
      { ...input, binding: request.binding },
      { ...input, scope: request.scope },
      { ...input, scope: { ...input.scope, threadId: null } },
      { ...input, extra: true },
      { ...input, filters: { ...input.filters, sourceGenerations: [] } },
    ]) {
      expect(() => admit(invalid)).toThrow();
    }
    expect(() => RetrievalBinding.create({ ...base, request: input } as unknown as
      Parameters<typeof RetrievalBinding.create>[0])).toThrow();
  });

  it("retains the V2 exact-null control without interpreting it as any", () => {
    const snapshot = RetrievalBinding.create(base).toSnapshot();
    expect(snapshot).toEqual(base);
    if (snapshot.retrievalPath !== "infinity_locator_v2") {throw new Error("V2 path lost");}
    expect(snapshot.request.scope).toEqual({ memoryScopeId: "scope-1",
      spaceId: "space-1", threadId: null });
    expect(snapshot.request.schemaVersion).toBe(2);
  });
});
