import { describe, expect, it } from "vitest";

import {
  MeetingKnowledgeInvariantError,
  QuestionBinding,
  selectRetrievalBinding,
  validateFocusedLocatorRetrievalV3Request,
  type FocusedLocatorRetrievalV3RequestSnapshot,
  canTransitionQuestionJob,
  questionBindingsEqual,
} from "@discord-meeting/meeting-core/meeting-knowledge";

import { retrievalV2Request } from "./retrieval-v2-application-fixtures.test.js";

const bindingInput = {
  authorizationDigest: "a".repeat(64),
  authorizationPolicyVersion: "discord.participant-current-results.v1",
  authorizationPrincipalRef: "principal:v1:opaque",
  botApplicationIdentity: "bot-1",
  canonicalEvidenceHash: "b".repeat(64),
  deliveryContainerId: "question-thread-1",
  expectedLocale: "mixed" as const,
  finalProjectionEpoch: "meeting-summary-publication:v1:epoch",
  finalProjectionReceipt: "projection:v1:receipt",
  humanActorIds: ["speaker-a", "speaker-b"],
  meetingId: "meeting-1",
  meetingRevision: 8,
  memoryGeneration: `focused-memory:v1:${"b".repeat(64)}`,
  policyVersion: "meeting-knowledge.local-final-reply.v1",
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
  cutoverEpoch: "cutover-r1",
  localCurrentIdentity: Object.freeze({
    algorithmId: "canonical_local_exact_lexical_v1" as const,
    profileFingerprint: "f".repeat(64),
    profileId: "meeting-knowledge.local-current.v2" as const,
  }),
  originalQuestion: "What changed?",
  profileFingerprint: "e".repeat(64),
  provenanceSchemaVersion: 1 as const,
  retrievalPath: "infinity_locator_v1" as const,
});

describe("QuestionJob vocabulary and immutable binding", () => {
  it("normalizes, freezes, and compares an immutable binding", () => {
    const currentInput = {
      ...bindingInput,
      bindingProtocolVersion: 2 as const,
      retrievalBinding,
    };
    const first = QuestionBinding.create(currentInput);
    const same = QuestionBinding.create({ ...currentInput });
    const changed = QuestionBinding.create({ ...currentInput, meetingRevision: 9 });
    const retrievalDrift = QuestionBinding.create({
      ...currentInput,
      retrievalBinding: { ...retrievalBinding, cutoverEpoch: "rollback-r2" },
    });
    expect(questionBindingsEqual(first, same)).toBe(true);
    expect(questionBindingsEqual(first, changed)).toBe(false);
    expect(questionBindingsEqual(first, retrievalDrift)).toBe(false);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.humanActorIds)).toBe(true);
    expect(Object.isFrozen(first.retrievalBinding)).toBe(true);
    expect(first.humanActorIds).toEqual(["speaker-a", "speaker-b"]);
    expect(first.deliveryContainerId).toBe("question-thread-1");
    expect(first.projectionTargetContainerId).toBe("results-channel-1");
    expect(first.toSnapshot()).toMatchObject({
      bindingProtocolVersion: 2,
      retrievalBinding,
    });
  });

  it("keeps an explicit pre-cutover binding shape but fails closed for partial v2", () => {
    const legacy = QuestionBinding.create(bindingInput).toSnapshot();
    expect(legacy).not.toHaveProperty("bindingProtocolVersion");
    expect(legacy).not.toHaveProperty("retrievalBinding");
    expect(() => QuestionBinding.create({
      ...bindingInput,
      bindingProtocolVersion: 2,
    } as never)).toThrow("retrieval binding");
    expect(() => QuestionBinding.create({
      ...bindingInput,
      retrievalBinding,
    } as never)).toThrow("protocol and retrieval binding");
  });

  it("rejects invalid hashes, locale, and revisions", () => {
    expect(() => QuestionBinding.create({ ...bindingInput, questionHash: "not-a-hash" }))
      .toThrow(MeetingKnowledgeInvariantError);
    expect(() => QuestionBinding.create({ ...bindingInput, meetingRevision: -1 }))
      .toThrow(MeetingKnowledgeInvariantError);
    expect(() => QuestionBinding.create({
      ...bindingInput,
      memoryGeneration: `focused-memory:v1:${"e".repeat(64)}`,
    })).toThrow(MeetingKnowledgeInvariantError);
    expect(() => QuestionBinding.create({
      ...bindingInput,
      humanActorIds: ["speaker-a", "speaker-a"],
    })).toThrow(MeetingKnowledgeInvariantError);
  });

  it("allows only the collapsed durable state transitions", () => {
    expect(canTransitionQuestionJob("queued", "running")).toBe(true);
    expect(canTransitionQuestionJob("running", "running")).toBe(true);
    expect(canTransitionQuestionJob("running", "ready")).toBe(true);
    expect(canTransitionQuestionJob("running", "terminal")).toBe(true);
    expect(canTransitionQuestionJob("ready", "ready")).toBe(true);
    expect(canTransitionQuestionJob("ready", "terminal")).toBe(true);
    expect(canTransitionQuestionJob("terminal", "queued")).toBe(false);
    expect(canTransitionQuestionJob("ready", "running")).toBe(false);
    expect(canTransitionQuestionJob("queued", "ready")).toBe(false);
  });
});


it("compares V3 selectors, full source generations and budgets in durable QuestionBinding equality", () => {
  const request: FocusedLocatorRetrievalV3RequestSnapshot = { ...retrievalV2Request,
    schemaVersion: 3, binding: { ...retrievalV2Request.binding, contractVersion: "context-retrieval.v3" },
    scope: { memoryScopeId: "scope-internal", spaceId: "space-internal", thread: { mode: "any" } },
  };
  const bind = (value: FocusedLocatorRetrievalV3RequestSnapshot) => QuestionBinding.create({
    ...bindingInput, bindingProtocolVersion: 2,
    retrievalBinding: selectRetrievalBinding({ questionId: bindingInput.questionId,
      retrievalRequest: value, rollout: { cutoverEpoch: "v3-opt-in",
        infinityProfileFingerprint: "e".repeat(64), localProfileFingerprint: "f".repeat(64) },
    }).toSnapshot(),
  });
  const original = bind(request);
  expect(questionBindingsEqual(original, bind(validateFocusedLocatorRetrievalV3Request(JSON.parse(JSON.stringify(request)))))).toBe(true);
  for (const changed of [
    { ...request, scope: { ...request.scope, thread: { mode: "exact" as const, id: null } } },
    { ...request, scope: { ...request.scope, thread: { mode: "exact" as const, id: "thread" } } },
    { ...request, filters: { ...request.filters, sourceGenerations: request.filters.sourceGenerations.map(
      (pair) => ({ ...pair, projectionGeneration: "changed-generation" })) } },
    { ...request, budgets: { ...request.budgets, resultLimit: 1 } },
    { ...request, binding: { ...request.binding, capabilityFingerprint: "7".repeat(64) } },
  ]) { expect(questionBindingsEqual(original, bind(changed))).toBe(false); }
});
