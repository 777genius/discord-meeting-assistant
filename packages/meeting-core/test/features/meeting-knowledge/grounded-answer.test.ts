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
    "Two release decisions were made.",
    "Those were the only release decisions.",
    "No other release decisions were made.",
    "All release decisions were approved.",
    "There were no other release decisions.",
    "Два решения по релизу были приняты.",
    "Всего 2 решения по релизу.",
    "It was mentioned three times.",
    "Проект был упомянут три раза.",
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

  it.each([
    "Alex proposed two days for review.",
    "Monday was the only corrected date Alex stated.",
    "The parser was three times faster.",
  ])("keeps local provider semantics valid with focused evidence: %s", (text) => {
    expect(GroundedAnswer.create({
      candidate: {
        claims: [{
          evidenceIds: ["evidence-000002"],
          text,
        }],
        locale: "en",
        status: "answered",
      },
      evidence: plan.evidence,
      expectedLocale: "en",
      groundingMode: "focused_retrieval",
      question: "When did Alex correct the release date?",
    }).status).toBe("answered");
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

  it.each([
    "There were no blockers, and Alice approved the release.",
    "Project Zeta was never approved, but Project Omega was approved.",
    "There were no blockers; Alice approved the release.",
    "There were no blockers after Alice approved the release.",
  ])("rejects mixed uncited absence claims: %s", (text) => {
    expect(() => GroundedAnswer.create({
      candidate: {
        claims: [{ evidenceIds: [], text }],
        locale: "en",
        status: "answered",
      },
      evidence: [],
      exhaustiveAbsenceProven: true,
      expectedLocale: "en",
      groundingMode: "exhaustive_coverage",
      question: "Were there any blockers?",
    })).toThrow("between one and eight citations");
  });

  it("accepts only a pure Russian absence claim without citations", () => {
    const pure = GroundedAnswer.create({
      candidate: {
        claims: [{
          evidenceIds: [],
          text: "Проект Зета никогда не был одобрен.",
        }],
        locale: "ru",
        status: "answered",
      },
      evidence: [],
      exhaustiveAbsenceProven: true,
      expectedLocale: "ru",
      groundingMode: "exhaustive_coverage",
      question: "Был ли проект Зета одобрен?",
    });
    expect(pure.claims[0]?.support).toBe("complete_coverage_absence");

    expect(() => GroundedAnswer.create({
      candidate: {
        claims: [{
          evidenceIds: [],
          text: "Проект Зета никогда не был одобрен, но проект Омега одобрили.",
        }],
        locale: "ru",
        status: "answered",
      },
      evidence: [],
      exhaustiveAbsenceProven: true,
      expectedLocale: "ru",
      groundingMode: "exhaustive_coverage",
      question: "Был ли проект Зета одобрен?",
    })).toThrow("between one and eight citations");
  });
});
