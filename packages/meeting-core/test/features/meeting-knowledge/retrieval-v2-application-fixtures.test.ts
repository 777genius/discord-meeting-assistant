import { describe, expect, it } from "vitest";

import type { FocusedLocatorRetrievalV2RequestSnapshot, LocalFinalReplyPolicy,
  QuestionBindingSnapshot } from
  "@discord-meeting/meeting-core/meeting-knowledge";

export const retrievalV2ProviderBinding = Object.freeze({
  capabilityFingerprint: "e".repeat(64),
  contractVersion: "context-retrieval.v2" as const,
  indexProfileDigest: "a".repeat(64),
  profileId: "profile-v2",
  rankingPolicy: "weighted_rrf_canonical_preferences.v1" as const,
  requiredProviderLanes: Object.freeze(["postgres_keyword", "qdrant_dense"]),
  serviceRevision: "revision-v2",
});

export const retrievalV2Request: FocusedLocatorRetrievalV2RequestSnapshot =
  Object.freeze({
    binding: retrievalV2ProviderBinding,
    budgets: Object.freeze({ candidateLimit: 100, deadlineMs: 1_000,
      evidenceByteLimit: 24_000, neighborRadius: 0 as const,
      responseByteLimit: 16_384, resultLimit: 8 }),
    filters: Object.freeze({ actorKeys: Object.freeze([]), category: null,
      documentKeys: Object.freeze([]), excludedSourceKeys: Object.freeze([]),
      kinds: Object.freeze(["record_block"]), relativeTimeInterval: null,
      sourceGenerations: Object.freeze([{ projectionGeneration: "generation-1",
        sourceKey: "source-1" }]), tagsAll: Object.freeze([]),
      tagsAny: Object.freeze([]), tagsNone: Object.freeze([]), timeInterval: null }),
    queries: Object.freeze([{ query: "Question?", queryId: "question-01" }]),
    schemaVersion: 2 as const,
    scope: Object.freeze({ memoryScopeId: "scope-1", spaceId: "space-1",
      threadId: null }),
    softPreferences: Object.freeze({ actorPreferences: Object.freeze([]),
      relativeTimeInterval: null, sourcePreferences: Object.freeze([]),
      timeInterval: null, timeWeightMicros: null }),
  });

export function rolloutABinding(
  base: QuestionBindingSnapshot,
): QuestionBindingSnapshot {
  return {
    ...base,
    bindingProtocolVersion: 2,
    retrievalBinding: {
      cutoverEpoch: "rollout-a",
      profileFingerprint: "a".repeat(64),
      request: retrievalV2Request,
      retrievalPath: "infinity_locator_v2",
    },
  };
}

export function rollbackPolicy(
  base: LocalFinalReplyPolicy,
): LocalFinalReplyPolicy {
  return {
    ...base,
    retrievalAdmission: {
      ...base.retrievalAdmission,
      cutoverEpoch: "rollout-b",
      infinityProfileFingerprint: "b".repeat(64),
      infinityRolloutBasisPoints: 0,
    },
  };
}

describe("Retrieval V2 application fixtures", () => {
  it("keeps the exact request frozen", () => {
    expect(Object.isFrozen(retrievalV2Request)).toBe(true);
  });
});
