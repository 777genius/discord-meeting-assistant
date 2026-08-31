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
      evidenceByteLimit: 16_000, neighborRadius: 0 as const,
      responseByteLimit: 16_384, resultLimit: 10 }),
    filters: Object.freeze({ actorKeys: Object.freeze([]), category: null,
      documentKeys: Object.freeze([]), excludedSourceKeys: Object.freeze([]),
      kinds: Object.freeze(["record_block"]), relativeTimeInterval: null,
      sourceGenerations: Object.freeze([{ projectionGeneration: "generation-1",
        sourceKey: "source-1" }]), tagsAll: Object.freeze([]),
      tagsAny: Object.freeze([]), tagsNone: Object.freeze([]), timeInterval: null }),
    queries: Object.freeze([{ query: "Question?", queryId: "original-question" }]),
    schemaVersion: 2 as const,
    scope: Object.freeze({ memoryScopeId: "scope-1", spaceId: "space-1",
      threadId: null }),
    softPreferences: Object.freeze({ actorPreferences: Object.freeze([]),
      relativeTimeInterval: null, sourcePreferences: Object.freeze([]),
      timeInterval: null, timeWeightMicros: null }),
  });

export function retrievalProvenance(
  originalQuestion = "When is the corrected release day?",
) {
  return Object.freeze({
    canonicalEvidenceFilters: Object.freeze({
      relativeTimeInterval: null,
      requiresSpeakerMatch: false,
      speakerIds: Object.freeze([]),
    }),
    localCurrentIdentity: Object.freeze({
      algorithmId: "canonical_local_exact_lexical_v1" as const,
      profileFingerprint: "f".repeat(64),
      profileId: "meeting-knowledge.local-current.v2" as const,
    }),
    originalQuestion,
    provenanceSchemaVersion: 1 as const,
  });
}

export const compositeProfile = Object.freeze({
  candidatePolicy: "bounded_lane_round_robin_dedupe.v1" as const,
  interleavePolicy: "local_then_historical_per_rank.v1" as const,
  profileId: "meeting-knowledge.composite-retrieval.v1" as const,
});

export function rolloutABinding(
  base: QuestionBindingSnapshot,
): QuestionBindingSnapshot {
  return {
    ...base,
    bindingProtocolVersion: 2,
    retrievalBinding: {
      ...retrievalProvenance(),
      compositeProfile,
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
      localProfileFingerprint: "c".repeat(64),
    },
  };
}

describe("Retrieval V2 application fixtures", () => {
  it("keeps the exact request frozen", () => {
    expect(Object.isFrozen(retrievalV2Request)).toBe(true);
  });
});
