import { QuestionBinding } from "@discord-meeting/meeting-core/meeting-knowledge";
import { describe, expect, it } from "vitest";

import {
  decodePersistedQuestionBinding,
  decodeQuestionBinding,
  legacyQuestionAdmissionBindingHash,
  preCanonicalProtocol2QuestionAdmissionBindingHash,
  questionAdmissionBindingHash,
  questionAdmissionBindingHashMatches,
} from "../src/postgres-meeting-knowledge-codecs.js";

const legacyInput = {
  authorizationDigest: "a".repeat(64),
  authorizationPolicyVersion: "discord.participant-current-results.v1",
  authorizationPrincipalRef: "principal:v1:opaque",
  botApplicationIdentity: "bot-1",
  canonicalEvidenceHash: "b".repeat(64),
  deliveryContainerId: "question-thread-1",
  expectedLocale: "en" as const,
  finalProjectionEpoch: "projection-epoch-r1",
  finalProjectionReceipt: "projection:v1:receipt",
  humanActorIds: ["speaker-a"],
  meetingId: "meeting-1",
  meetingRevision: 1,
  memoryGeneration: `focused-memory:v1:${"b".repeat(64)}`,
  policyVersion: "meeting-knowledge.focused-memory-final-reply.v3",
  projectionTargetContainerId: "results-channel-1",
  questionHash: "c".repeat(64),
  questionId: "question-1",
  requesterSubject: "d".repeat(64),
  roomId: "room-1",
  scopeId: "scope-1",
  transcriptId: "transcript-1",
  transcriptVersion: 1,
};

const retrievalBinding = Object.freeze({
  cutoverEpoch: "cutover-r1",
  profileFingerprint: "e".repeat(64),
  request: Object.freeze({
    binding: Object.freeze({ capabilityFingerprint: "f".repeat(64),
      contractVersion: "context-retrieval.v2" as const,
      indexProfileDigest: "1".repeat(64), profileId: "profile-v2",
      rankingPolicy: "weighted_rrf_canonical_preferences.v1" as const,
      requiredProviderLanes: Object.freeze(["postgres_keyword", "qdrant_dense"]),
      serviceRevision: "revision-v2" }),
    budgets: Object.freeze({ candidateLimit: 100, deadlineMs: 1_000,
      evidenceByteLimit: 16_000, neighborRadius: 0 as const,
      responseByteLimit: 16_384, resultLimit: 10 }),
    filters: Object.freeze({ actorKeys: Object.freeze(["actor-1"]), category: null,
      documentKeys: Object.freeze([]), excludedSourceKeys: Object.freeze([]),
      kinds: Object.freeze(["record_block"]), relativeTimeInterval: null,
      sourceGenerations: Object.freeze([{ projectionGeneration: "generation-1",
        sourceKey: "source-1" }]), tagsAll: Object.freeze([]), tagsAny: Object.freeze([]),
      tagsNone: Object.freeze([]), timeInterval: null }),
    queries: Object.freeze([{ query: "Когда launch?", queryId: "question-01" }]),
    schemaVersion: 2 as const,
    scope: Object.freeze({ memoryScopeId: "scope-opaque", spaceId: "space-opaque",
      threadId: null }),
    softPreferences: Object.freeze({ actorPreferences: Object.freeze([]),
      relativeTimeInterval: null, sourcePreferences: Object.freeze([]),
      timeInterval: null, timeWeightMicros: null }),
  }),
  retrievalPath: "infinity_locator_v2" as const,
});

const currentBinding = QuestionBinding.create({
  ...legacyInput,
  bindingProtocolVersion: 2,
  retrievalBinding,
}).toSnapshot();

describe("PostgreSQL question binding codec", () => {
  it("round-trips and hashes the complete immutable retrieval binding", () => {
    if (currentBinding.bindingProtocolVersion !== 2) {
      throw new Error("current binding fixture must use protocol 2");
    }
    const serialized: unknown = JSON.parse(JSON.stringify(currentBinding));
    const bindingHash = questionAdmissionBindingHash(currentBinding);
    expect(decodePersistedQuestionBinding(serialized, bindingHash)).toEqual(currentBinding);
    expect(bindingHash).toMatch(/^[a-f0-9]{64}$/u);
    const reorderedRequest = {
      ...currentBinding,
      retrievalBinding: {
        ...retrievalBinding,
        request: {
          softPreferences: retrievalBinding.request.softPreferences,
          scope: retrievalBinding.request.scope,
          schemaVersion: retrievalBinding.request.schemaVersion,
          queries: retrievalBinding.request.queries,
          filters: retrievalBinding.request.filters,
          budgets: retrievalBinding.request.budgets,
          binding: retrievalBinding.request.binding,
        },
      },
    };
    expect(JSON.stringify(reorderedRequest)).not.toBe(JSON.stringify(currentBinding));
    expect(questionAdmissionBindingHash(reorderedRequest)).toBe(bindingHash);
    const historicalHash = preCanonicalProtocol2QuestionAdmissionBindingHash(currentBinding);
    expect(historicalHash).not.toBeNull();
    if (historicalHash === null) {
      throw new Error("current binding did not produce its protocol-2 compatibility hash");
    }
    expect(historicalHash).not.toBe(bindingHash);
    expect(questionAdmissionBindingHashMatches(currentBinding, bindingHash)).toBe(true);
    expect(questionAdmissionBindingHashMatches(currentBinding, historicalHash)).toBe(true);
    expect(decodePersistedQuestionBinding(serialized, historicalHash))
      .toEqual(currentBinding);
    expect(questionAdmissionBindingHash({
      ...currentBinding,
      retrievalBinding: {
        ...retrievalBinding,
        cutoverEpoch: "rollback-r2",
      },
    })).not.toBe(bindingHash);
    expect(questionAdmissionBindingHashMatches(currentBinding, questionAdmissionBindingHash({
      ...currentBinding,
      retrievalBinding: {
        ...retrievalBinding,
        cutoverEpoch: "conflicting-valid-binding",
      },
    }))).toBe(false);
    expect(questionAdmissionBindingHash({
      ...currentBinding,
      retrievalBinding: {
        ...retrievalBinding,
        request: { ...retrievalBinding.request,
          binding: { ...retrievalBinding.request.binding,
            profileId: "drifted-profile" } },
      },
    })).not.toBe(bindingHash);
  });

  it("round-trips the explicit first-meeting local retrieval binding", () => {
    const local = QuestionBinding.create({ ...legacyInput, bindingProtocolVersion: 2,
      retrievalBinding: { cutoverEpoch: "cutover-r1",
        profileFingerprint: "9".repeat(64),
        retrievalPath: "canonical_local_exact_lexical_v1" } }).toSnapshot();
    expect(decodePersistedQuestionBinding(
      JSON.parse(JSON.stringify(local)),
      questionAdmissionBindingHash(local),
    )).toEqual(local);
  });

  it("rejects malformed or missing protocol-2 retrieval authority", () => {
    if (currentBinding.bindingProtocolVersion !== 2) {
      throw new Error("current binding fixture must use protocol 2");
    }
    const { retrievalBinding: _missing, ...missing } = currentBinding;
    expect(() => decodeQuestionBinding(missing)).toThrow();
    expect(() => decodeQuestionBinding({
      ...currentBinding,
      retrievalBinding: {
        ...retrievalBinding,
        profileFingerprint: "malformed",
      },
    })).toThrow();
    const { request: _request, ...missingRequest } = retrievalBinding;
    expect(() => decodeQuestionBinding({
      ...currentBinding,
      retrievalBinding: missingRequest,
    })).toThrow();
    for (const retrievalPath of ["abstained", "infinity_locator_v3"]) {
      expect(() => decodeQuestionBinding({
        ...currentBinding,
        retrievalBinding: { ...retrievalBinding, retrievalPath },
      })).toThrow();
    }
  });

  it("fails closed on persisted V2 extras, partials, ordering drift, and oversized values", () => {
    const reject = (mutate: (request: MutableRetrievalRequest) => void): void => {
      const invalid = JSON.parse(JSON.stringify(currentBinding)) as unknown as {
        retrievalBinding: { request: MutableRetrievalRequest };
      };
      mutate(invalid.retrievalBinding.request);
      expect(() => decodeQuestionBinding(invalid)).toThrow();
    };
    reject((request) => { request.extra = true; });
    reject((request) => { delete request.filters.tagsNone; });
    reject((request) => { request.budgets.evidenceByteLimit = 16_001; });
    reject((request) => { request.budgets.responseByteLimit = 16_383; });
    reject((request) => { request.queries[0]!.query = "я".repeat(300); });
    reject((request) => { request.queries.push({ ...request.queries[0]! }); });
    reject((request) => {
      request.binding.requiredProviderLanes.reverse();
    });
    reject((request) => {
      request.filters.sourceGenerations.push({
        ...request.filters.sourceGenerations[0]!,
      });
    });
  });

  it("accepts only the two genuine pre-cutover hashes and fences downgraded v2", () => {
    if (currentBinding.bindingProtocolVersion !== 2) {
      throw new Error("current binding fixture must use protocol 2");
    }
    const legacy = QuestionBinding.create(legacyInput).toSnapshot();
    expect(preCanonicalProtocol2QuestionAdmissionBindingHash(legacy)).toBeNull();
    const currentLegacyHash = questionAdmissionBindingHash(legacy);
    const deliverylessLegacyHash = legacyQuestionAdmissionBindingHash(legacy);
    expect(deliverylessLegacyHash).not.toBeNull();
    if (deliverylessLegacyHash === null) {
      throw new Error("legacy binding did not produce its compatibility hash");
    }
    expect(decodePersistedQuestionBinding(legacy, currentLegacyHash)).toEqual(legacy);
    expect(decodePersistedQuestionBinding(legacy, deliverylessLegacyHash)).toEqual(legacy);

    const {
      bindingProtocolVersion: _protocolVersion,
      retrievalBinding: _retrievalAuthority,
      ...strippedProtocol2
    } = currentBinding;
    expect(() => decodePersistedQuestionBinding(
      strippedProtocol2,
      questionAdmissionBindingHash(currentBinding),
    )).toThrow("hash does not match");
    expect(() => decodePersistedQuestionBinding(
      currentBinding,
      questionAdmissionBindingHash({
        ...currentBinding,
        retrievalBinding: {
          ...retrievalBinding,
          profileFingerprint: "f".repeat(64),
        },
      }),
    )).toThrow("hash does not match");
  });
});

interface MutableRetrievalRequest {
  [key: string]: unknown;
  binding: { requiredProviderLanes: string[] };
  budgets: Record<string, number>;
  filters: {
    sourceGenerations: Array<Record<string, string>>;
    tagsNone?: string[];
  };
  queries: Array<Record<string, unknown>>;
}
