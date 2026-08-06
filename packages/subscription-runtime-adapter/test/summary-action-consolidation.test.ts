import { describe, expect, it } from "vitest";

import type { ProviderMeetingSummary } from "../src/provider-summary-schema.js";
import { consolidateCoveredUnassignedActions } from "../src/summary-action-consolidation.js";

const ownedAction: ProviderMeetingSummary["actionItems"][number] = {
  deadline: "до 7 августа 2026 года",
  evidenceTurnIds: ["turn-b-1", "turn-b-2"],
  ownerSpeakerId: "speaker-b",
  text: "Проверить Redis queue и idempotency key; результат оставить в Discord thread",
};

describe("summary action consolidation", () => {
  it("drops a covered unassigned restatement from another speaker", () => {
    const summary = summaryWith({
      deadline: "до 7 августа 2026 года",
      evidenceTurnIds: ["turn-a"],
      ownerSpeakerId: null,
      text: "Проверить Discord thread",
    });

    expect(consolidateCoveredUnassignedActions(summary, transcriptTurns()).actionItems)
      .toEqual([ownedAction]);
  });

  it("preserves a distinct unassigned task with the same deadline", () => {
    const distinct: ProviderMeetingSummary["actionItems"][number] = {
      deadline: "до 7 августа 2026 года",
      evidenceTurnIds: ["turn-a"],
      ownerSpeakerId: null,
      text: "Подготовить changelog",
    };
    const summary = summaryWith(distinct);

    expect(consolidateCoveredUnassignedActions(summary, transcriptTurns()).actionItems)
      .toEqual([ownedAction, distinct]);
  });

  it("preserves an owner-supported action instead of hiding conflicting ownership", () => {
    const candidate: ProviderMeetingSummary["actionItems"][number] = {
      deadline: "до 7 августа 2026 года",
      evidenceTurnIds: ["turn-b-2"],
      ownerSpeakerId: null,
      text: "Проверить Discord thread",
    };
    const summary = summaryWith(candidate);

    expect(consolidateCoveredUnassignedActions(summary, transcriptTurns()).actionItems)
      .toEqual([ownedAction, candidate]);
  });
});

function summaryWith(
  secondAction: ProviderMeetingSummary["actionItems"][number],
): ProviderMeetingSummary {
  return {
    actionItems: [ownedAction, secondAction],
    decisions: [],
    openQuestions: [],
    overview: "Обсудили проверку очереди.",
    title: "Проверка очереди",
    topics: [],
  };
}

function transcriptTurns() {
  return [
    { speakerId: "speaker-a", turnId: "turn-a" },
    { speakerId: "speaker-b", turnId: "turn-b-1" },
    { speakerId: "speaker-b", turnId: "turn-b-2" },
  ] as const;
}
