import { QuestionBinding } from "@discord-meeting/meeting-core/meeting-knowledge";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  decodePersistedQuestionBinding,
  decodeQuestionBinding,
  legacyQuestionAdmissionBindingHash,
  preCanonicalProtocol2QuestionAdmissionBindingHash,
  questionAdmissionBindingHash,
  questionAdmissionBindingHashMatches,
} from "../src/postgres-meeting-knowledge-codecs.js";
import { decodePersistedQuestionRecovery } from
  "../src/postgres-question-recovery-codec.js";
import { canonicalFixtureHash, exactPreCompositeFixture,
  preCanonicalPreCompositeBindingHash, preCompositeProtocol2BindingJson,
  preCompositeProtocol2GroundingPlanJson,
  serializeQuestionReconciliationFixtureRows } from
  "./postgres-protocol2-recovery.fixture.js";

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
  canonicalEvidenceFilters: Object.freeze({ relativeTimeInterval: null,
    requiresSpeakerMatch: false, speakerIds: Object.freeze([]) }),
  compositeProfile: Object.freeze({
    candidatePolicy: "bounded_lane_round_robin_dedupe.v1" as const,
    interleavePolicy: "local_then_historical_per_rank.v1" as const,
    profileId: "meeting-knowledge.composite-retrieval.v1" as const,
  }),
  cutoverEpoch: "cutover-r1",
  localCurrentIdentity: Object.freeze({
    algorithmId: "canonical_local_exact_lexical_v1" as const,
    profileFingerprint: "2".repeat(64),
    profileId: "meeting-knowledge.local-current.v2" as const,
  }),
  originalQuestion: "Question?",
  profileFingerprint: "e".repeat(64),
  provenanceSchemaVersion: 1 as const,
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

function expectPinnedPreCompositeBytes(
  fixture: ReturnType<typeof exactPreCompositeFixture>,
): void {
  expect(createHash("sha256").update(preCompositeProtocol2BindingJson).digest("hex"))
    .toBe("c1289bc658ef50d7f13cab3b5b7eb377a38de1ac84f81d6c99979b77cd8357e9");
  expect(createHash("sha256").update(preCompositeProtocol2GroundingPlanJson)
    .digest("hex"))
    .toBe("732dcb6c551d2272c01f9e2a0a07bf75e401f9adabcf68dd1bd9056e3b9d41e6");
  expect(decodePersistedQuestionRecovery({ ...fixture,
    bindingHash: preCanonicalPreCompositeBindingHash(),
    questionText: "Question?" })).toEqual({
    reason: "protocol2_canonical_evidence_filters_absent", status: "incompatible",
  });
}

describe("PostgreSQL question reconciliation fixture codec", () => {
  it("serializes reconciliation fixture fields to the SQL recordset contract", () => {
    const serialized = serializeQuestionReconciliationFixtureRows([{
      binding: { bindingProtocolVersion: 2 }, bindingHash: "a".repeat(64),
      groundingPlan: { mode: "focused_retrieval" },
      questionId: "77777777777777777", state: "queued",
    }]);
    expect(serialized).toEqual([{
      binding: { bindingProtocolVersion: 2 }, binding_hash: "a".repeat(64),
      grounding_plan: { mode: "focused_retrieval" },
      question_id: "77777777777777777", state: "queued",
    }]);
    expect(serialized[0]).not.toHaveProperty("bindingHash");
    expect(serialized[0]).not.toHaveProperty("groundingPlan");
    expect(serialized[0]).not.toHaveProperty("questionId");
  });
});

describe("PostgreSQL question binding codec", () => {
  it("recognizes the exact pre-composite protocol-2 bytes and terminalizes absent authority",
    () => {
      const fixture = exactPreCompositeFixture();
      expectPinnedPreCompositeBytes(fixture);
      expect(fixture.bindingHash)
        .toBe("54d0c7c563babb111d63a520e27f05d9d0c6efc386f64c3d1feae3dab367dd64");
      const binding = fixture.binding as { readonly retrievalBinding:
        Readonly<Record<string, unknown>> };
      const audit = (fixture.groundingPlan as { readonly evidence: readonly {
        readonly retrievalAudit: Readonly<Record<string, unknown>> }[] })
        .evidence[0]!.retrievalAudit;
      expect(binding.retrievalBinding).not.toHaveProperty("canonicalEvidenceFilters");
      expect(binding.retrievalBinding).not.toHaveProperty("localCurrentIdentity");
      expect(binding.retrievalBinding).not.toHaveProperty("originalQuestion");
      expect(binding.retrievalBinding).not.toHaveProperty("provenanceSchemaVersion");
      expect(binding.retrievalBinding).not.toHaveProperty("compositeProfile");
      expect(audit).toHaveProperty("capabilityFingerprint");
      expect(audit).not.toHaveProperty("laneIdentity");
      expect(decodePersistedQuestionRecovery({ ...fixture,
        questionText: "Question?" })).toEqual({
        reason: "protocol2_canonical_evidence_filters_absent",
        status: "incompatible",
      });
    });

  it("separates a corrupt persisted plan from valid current binding authority", () => {
    expect(decodePersistedQuestionRecovery({ binding: currentBinding,
      bindingHash: questionAdmissionBindingHash(currentBinding),
      groundingPlan: { structurally: "invalid" }, questionText: "Question?" }))
      .toEqual({ reason: "grounding_plan_structurally_corrupt",
        status: "incompatible" });
  });

  it("migrates only derivable local protocol-2 authority and its deleted audit shape",
    () => {
      const fixture = exactPreCompositeFixture();
      const binding = structuredClone(fixture.binding) as {
        authorizationPrincipalRef: string;
        retrievalBinding: Record<string, unknown>;
      };
      binding.retrievalBinding.canonicalEvidenceFilters = {
        relativeTimeInterval: null, requiresSpeakerMatch: false, speakerIds: [],
      };
      const plan = structuredClone(fixture.groundingPlan) as { evidence: Array<{
        retrievalAudit: Record<string, unknown> }> };
      const audit = plan.evidence[0]!.retrievalAudit;
      audit.requestDigest = canonicalFixtureHash({ question: "Question?",
        retrievalBinding: binding.retrievalBinding });
      audit.responseDigest = canonicalFixtureHash({
        contributions: audit.contributions, fusedScore: audit.fusedScore,
        locator: audit.locator, providerRank: audit.providerRank,
      });
      const { authorizationPrincipalRef: _principal, ...dedupe } = binding;
      const recovered = decodePersistedQuestionRecovery({ binding,
        bindingHash: canonicalFixtureHash(dedupe), groundingPlan: plan,
        questionText: "Question?" });
      if (recovered.status !== "decoded") {throw new Error(recovered.reason);}
      expect(recovered.status).toBe("decoded");
      expect(recovered.migration).toBe("pre_composite_local_v2");
      expect(recovered.binding.retrievalBinding).toMatchObject({
        canonicalEvidenceFilters: { relativeTimeInterval: null,
          requiresSpeakerMatch: false, speakerIds: [] },
        localCurrentIdentity: { algorithmId: "canonical_local_exact_lexical_v1",
          profileFingerprint: "e".repeat(64),
          profileId: "meeting-knowledge.local-current.v2" },
        originalQuestion: "Question?", provenanceSchemaVersion: 1,
      });
      expect(recovered.groundingPlan?.evidence[0]?.retrievalAudit)
        .not.toHaveProperty("capabilityFingerprint");
      expect(recovered.groundingPlan?.evidence[0]?.retrievalAudit?.laneIdentity)
        .toMatchObject({ lane: "local_current",
          profileFingerprint: "e".repeat(64) });
    });

  it("terminalizes pre-composite Infinity V2 instead of inventing lane authority",
    () => {
      const serialized = structuredClone(currentBinding) as unknown as {
        [key: string]: unknown;
        retrievalBinding: Record<string, unknown>;
      };
      delete serialized.retrievalBinding.compositeProfile;
      delete serialized.retrievalBinding.localCurrentIdentity;
      delete serialized.retrievalBinding.originalQuestion;
      delete serialized.retrievalBinding.provenanceSchemaVersion;
      const { authorizationPrincipalRef: _principal, ...dedupe } = serialized;
      expect(decodePersistedQuestionRecovery({ binding: serialized,
        bindingHash: canonicalFixtureHash(dedupe), groundingPlan: null,
        questionText: "Question?" })).toEqual({
        reason: "protocol2_composite_authority_absent",
        status: "incompatible",
      });
    });

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
      retrievalBinding: {
        canonicalEvidenceFilters: retrievalBinding.canonicalEvidenceFilters,
        cutoverEpoch: "cutover-r1",
        localCurrentIdentity: retrievalBinding.localCurrentIdentity,
        originalQuestion: retrievalBinding.originalQuestion,
        profileFingerprint: "9".repeat(64),
        provenanceSchemaVersion: 1,
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
