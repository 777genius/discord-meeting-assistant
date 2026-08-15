import { describe, expect, it } from "vitest";

import { DiscordGroundedAnswerRenderer } from "@discord-meeting/discord-adapter";
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

describe("DiscordGroundedAnswerRenderer", () => {
  it("owns escaped Discord markdown and stable speaker/time/turn citations", () => {
    const answer = GroundedAnswer.create({
      candidate: {
        claims: [{
          evidenceIds: ["evidence-000001", "evidence-000002"],
          text: "The *corrected* release day is Monday.",
        }],
        locale: "en",
        status: "answered",
      },
      evidence: plan.evidence,
      expectedLocale: "en",
    });
    const renderer = new DiscordGroundedAnswerRenderer();
    const rendered = renderer.renderAnswer({
      answer,
      evidence: plan.evidence,
      maximumCharacters: 2_000,
    });

    expect(rendered).toContain("The \\*corrected\\* release day is Monday.");
    expect(rendered).toContain("S1 · 00:05 · turn-initial");
    expect(rendered).toContain("S2 · 2:00:05 · turn-correction");
    expect(() => renderer.renderAnswer({
      answer,
      evidence: plan.evidence,
      maximumCharacters: 40,
    })).toThrow(MeetingKnowledgeInvariantError);
  });

  it.each([
    ["ru", "insufficient_evidence", "Недостаточно"],
    ["en", "unsupported_size", "too large"],
    ["mixed", "unavailable", "недоступен / The grounded answer"],
    ["en", "processing", "still being processed"],
  ] as const)("renders localized fixed %s/%s response", (locale, outcome, phrase) => {
    expect(new DiscordGroundedAnswerRenderer().renderFixed({ locale, outcome }))
      .toContain(phrase);
  });
});
