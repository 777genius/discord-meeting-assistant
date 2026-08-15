import { describe, expect, it } from "vitest";

import {
  MeetingKnowledgeInvariantError,
  QuestionBinding,
  canTransitionQuestionJob,
  questionBindingsEqual,
} from "@discord-meeting/meeting-core/meeting-knowledge";

const bindingInput = {
  authorizationDigest: "a".repeat(64),
  authorizationPolicyVersion: "discord.participant-current-results.v1",
  authorizationPrincipalRef: "principal:v1:opaque",
  botApplicationIdentity: "bot-1",
  canonicalEvidenceHash: "b".repeat(64),
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

describe("QuestionJob vocabulary and immutable binding", () => {
  it("normalizes, freezes, and compares an immutable binding", () => {
    const first = QuestionBinding.create(bindingInput);
    const same = QuestionBinding.create({ ...bindingInput });
    const changed = QuestionBinding.create({ ...bindingInput, meetingRevision: 9 });
    expect(questionBindingsEqual(first, same)).toBe(true);
    expect(questionBindingsEqual(first, changed)).toBe(false);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.humanActorIds)).toBe(true);
    expect(first.humanActorIds).toEqual(["speaker-a", "speaker-b"]);
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
