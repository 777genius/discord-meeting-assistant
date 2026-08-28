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
      retrievalV2Request: request, rollout }).toSnapshot()).toEqual({
      cutoverEpoch: "infinity-v2-only-r1",
      profileFingerprint: "a".repeat(64),
      request,
      retrievalPath: "infinity_locator_v2",
    });
  });

  it("keeps legacy route snapshots readable for drain audits", () => {
    expect(RetrievalBinding.create({
      cutoverEpoch: "old-rollout",
      profileFingerprint: "b".repeat(64),
      retrievalPath: "legacy_downstream_v1",
    }).toSnapshot()).toMatchObject({ retrievalPath: "legacy_downstream_v1" });
  });

  it("binds an explicit canonical local path when no indexed source is available", () => {
    expect(selectRetrievalBinding({ questionId: "question-first-meeting",
      retrievalV2Request: null, rollout }).toSnapshot()).toEqual({
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
