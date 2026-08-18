import { describe, expect, it } from "vitest";

import {
  GroundedAnswer,
  MeetingKnowledgeInvariantError,
  createFocusedRetrievalGroundingPlan,
  focusedMemoryGeneration,
} from "@discord-meeting/meeting-core/meeting-knowledge";

const plan = createFocusedRetrievalGroundingPlan({
  authorityGeneration: focusedMemoryGeneration("a".repeat(64)),
  coverage: "sufficient",
  humanActorIds: ["speaker-a", "speaker-b"],
  turns: [
    {
      endMs: 10_000,
      speakerId: "speaker-a",
      startMs: 5_000,
      text: "The release was initially planned for Friday.",
      turnHash: "b".repeat(64),
      turnId: "turn-initial",
    },
    {
      endMs: 7_210_000,
      speakerId: "speaker-b",
      startMs: 7_205_000,
      text: "Correction: the release is Monday, not Friday.",
      turnHash: "c".repeat(64),
      turnId: "turn-correction",
    },
  ],
});

describe("grounded Meeting Knowledge answers", () => {
  it("accepts bounded claims only when every citation is admitted", () => {
    const answer = GroundedAnswer.create({
      candidate: {
        claims: [{
          evidenceIds: ["evidence-000001", "evidence-000002"],
          text: "The corrected release day is Monday, replacing Friday.",
        }],
        locale: "en",
        status: "answered",
      },
      evidence: plan.evidence,
      expectedLocale: "en",
      groundingMode: "focused_retrieval",
      question: "When did Alex correct the release date?",
    });

    expect(answer.status).toBe("answered");
    expect(answer.claims[0]?.evidenceIds).toEqual([
      "evidence-000001",
      "evidence-000002",
    ]);
  });

  it.each([
    {
      claims: [{ evidenceIds: ["evidence-missing"], text: "Unsupported" }],
      locale: "en",
      status: "answered",
    },
    {
      claims: [],
      locale: "en",
      status: "answered",
    },
    {
      claims: [{ evidenceIds: ["evidence-000001"], text: "@everyone deploy" }],
      locale: "en",
      status: "answered",
    },
    {
      claims: [{ evidenceIds: ["evidence-000001"], text: "See https://example.test" }],
      locale: "en",
      status: "answered",
    },
    {
      claims: [{ evidenceIds: ["evidence-000001"], text: "See example.test/path" }],
      locale: "en",
      status: "answered",
    },
    {
      claims: [{ evidenceIds: ["evidence-000001"], text: "Send to mailto:user@example.test" }],
      locale: "en",
      status: "answered",
    },
    {
      claims: [{ evidenceIds: ["evidence-000001"], text: "Hidden \u202Etext" }],
      locale: "en",
      status: "answered",
    },
    {
      claims: [{ evidenceIds: ["evidence-000001"], text: "English" }],
      locale: "ru",
      status: "answered",
    },
  ] as const)("rejects malformed or unsafe candidate %#", (candidate) => {
    expect(() => GroundedAnswer.create({
      candidate,
      evidence: plan.evidence,
      expectedLocale: "en",
      groundingMode: "focused_retrieval",
      question: "When did Alex correct the release date?",
    })).toThrow(MeetingKnowledgeInvariantError);
  });

  it("requires non-answered statuses to contain no claims", () => {
    expect(GroundedAnswer.create({
      candidate: { claims: [], locale: "en", status: "insufficient_evidence" },
      evidence: plan.evidence,
      expectedLocale: "en",
      groundingMode: "focused_retrieval",
      question: "When did Alex correct the release date?",
    }).claims).toEqual([]);
    expect(() => GroundedAnswer.create({
      candidate: {
        claims: [{ evidenceIds: ["evidence-000001"], text: "No" }],
        locale: "en",
        status: "not_a_question",
      },
      evidence: plan.evidence,
      expectedLocale: "en",
      groundingMode: "focused_retrieval",
      question: "When did Alex correct the release date?",
    })).toThrow(MeetingKnowledgeInvariantError);
  });

  it("validates exact quotes against locally rehydrated cited spans", () => {
    expect(GroundedAnswer.create({
      candidate: {
        claims: [{
          evidenceIds: ["evidence-000002"],
          text: "The correction says “the release is Monday”.",
        }],
        locale: "en",
        status: "answered",
      },
      evidence: plan.evidence,
      expectedLocale: "en",
      groundingMode: "focused_retrieval",
      question: "When did Alex correct the release date?",
    }).status).toBe("answered");
    expect(() => GroundedAnswer.create({
      candidate: {
        claims: [{
          evidenceIds: ["evidence-000002"],
          text: "The correction says “the release is Tuesday”.",
        }],
        locale: "en",
        status: "answered",
      },
      evidence: plan.evidence,
      expectedLocale: "en",
      groundingMode: "focused_retrieval",
      question: "When did Alex correct the release date?",
    })).toThrow(MeetingKnowledgeInvariantError);
    expect(() => GroundedAnswer.create({
      candidate: {
        claims: [{
          evidenceIds: ["evidence-000002"],
          text: "It says “the release is Monday”, then opens “another quote.",
        }],
        locale: "en",
        status: "answered",
      },
      evidence: plan.evidence,
      expectedLocale: "en",
      groundingMode: "focused_retrieval",
      question: "When did Alex correct the release date?",
    })).toThrow(MeetingKnowledgeInvariantError);
  });

  it.each([
    "There are exactly two release decisions.",
    "All release decisions were approved.",
    "There were no other release decisions.",
    "Всего 2 решения по релизу.",
  ])("rejects exhaustive provider semantics from focused evidence: %s", (text) => {
    expect(() => GroundedAnswer.create({
      candidate: {
        claims: [{ evidenceIds: ["evidence-000002"], text }],
        locale: "en",
        status: "answered",
      },
      evidence: plan.evidence,
      expectedLocale: "en",
      groundingMode: "focused_retrieval",
      question: "When did Alex correct the release date?",
    })).toThrow("focused evidence cannot support");
  });

  it("rejects uncited positive prose even when an exhaustive no-match proof exists", () => {
    expect(() => GroundedAnswer.create({
      candidate: {
        claims: [{ evidenceIds: [], text: "Project Zeta was approved." }],
        locale: "en",
        status: "answered",
      },
      evidence: [],
      exhaustiveAbsenceProven: true,
      expectedLocale: "en",
      groundingMode: "exhaustive_coverage",
      question: "Was Project Zeta ever approved?",
    })).toThrow("between one and eight citations");
  });
});
