import { describe, expect, it } from "vitest";

import type { ProviderMeetingSummary } from "../src/provider-summary-schema.js";
import { consolidateCoveredUnassignedActions } from "../src/summary-action-consolidation.js";

const ownedAction: ProviderMeetingSummary["actionItems"][number] = {
  deadline: "до 7 августа 2026 года",
  evidenceTurnIds: ["turn-b-1", "turn-b-2"],
  ownerSpeakerId: "speaker-b",
  text: "Проверить Redis queue и idempotency key; результат оставить в Discord thread",
};

const releaseDecision: ProviderMeetingSummary["decisions"][number] = {
  evidenceTurnIds: ["turn-release-decision"],
  text: "Выпустить версию в пятницу",
};

const duplicateReleaseAction: ProviderMeetingSummary["actionItems"][number] = {
  deadline: "в пятницу",
  evidenceTurnIds: ["turn-release-action"],
  ownerSpeakerId: null,
  text: "Выпустить версию",
};

const realReleaseAction: ProviderMeetingSummary["actionItems"][number] = {
  deadline: "в понедельник",
  evidenceTurnIds: ["turn-real-action"],
  ownerSpeakerId: "speaker-b",
  text: "Подготовить changelog",
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

  it("normalizes a speaker label and Russian verb form in a covered restatement", () => {
    const summary = summaryWith({
      deadline: "до 7 августа 2026 года",
      evidenceTurnIds: ["turn-a"],
      ownerSpeakerId: null,
      text: "Спикер B проверит Discord thread",
    });

    expect(consolidateCoveredUnassignedActions(summary, transcriptTurns()).actionItems)
      .toEqual([ownedAction]);
  });

  it("normalizes the dative Russian speaker label emitted by the final summary", () => {
    const summary = summaryWith({
      deadline: "До 7 августа 2026 года",
      evidenceTurnIds: ["turn-a"],
      ownerSpeakerId: null,
      text: "Спикеру B проверить Discord thread",
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

describe("decision and unassigned action consolidation", () => {
  it("drops the exact r65 decision restatement and preserves the real action", () => {
    const summary = decisionSummaryWith(duplicateReleaseAction);

    expect(consolidateCoveredUnassignedActions(summary, decisionTranscriptTurns()).actionItems)
      .toEqual([realReleaseAction]);
  });

  it("preserves a semantically distinct action from the same speaker block", () => {
    const distinct = {
      ...duplicateReleaseAction,
      text: "Подготовить changelog",
    };

    expect(consolidateCoveredUnassignedActions(
      decisionSummaryWith(distinct),
      decisionTranscriptTurns(),
    ).actionItems).toEqual([realReleaseAction, distinct]);
  });

  it("preserves a restatement with a different deadline", () => {
    const differentDeadline = {
      ...duplicateReleaseAction,
      deadline: "в субботу",
    };

    expect(consolidateCoveredUnassignedActions(
      decisionSummaryWith(differentDeadline),
      decisionTranscriptTurns(),
    ).actionItems).toEqual([realReleaseAction, differentDeadline]);
  });

  it("preserves a restatement grounded in a separate speaker block", () => {
    const separateBlock = {
      ...duplicateReleaseAction,
      evidenceTurnIds: ["turn-release-separated"],
    };

    expect(consolidateCoveredUnassignedActions(
      decisionSummaryWith(separateBlock),
      decisionTranscriptTurns(),
    ).actionItems).toEqual([realReleaseAction, separateBlock]);
  });

  it("preserves an owned action even when it restates the decision", () => {
    const ownedRestatement = {
      ...duplicateReleaseAction,
      ownerSpeakerId: "speaker-a",
    };

    expect(consolidateCoveredUnassignedActions(
      decisionSummaryWith(ownedRestatement),
      decisionTranscriptTurns(),
    ).actionItems).toEqual([realReleaseAction, ownedRestatement]);
  });

  it("preserves an action when the decision does not contain its deadline", () => {
    const summary = {
      ...decisionSummaryWith(duplicateReleaseAction),
      decisions: [{ ...releaseDecision, text: "Выпустить версию" }],
    };

    expect(consolidateCoveredUnassignedActions(summary, decisionTranscriptTurns()).actionItems)
      .toEqual([realReleaseAction, duplicateReleaseAction]);
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

function decisionSummaryWith(
  candidate: ProviderMeetingSummary["actionItems"][number],
): ProviderMeetingSummary {
  return {
    actionItems: [realReleaseAction, candidate],
    decisions: [releaseDecision],
    openQuestions: [],
    overview: "Обсудили выпуск.",
    title: "Выпуск",
    topics: [],
  };
}

function decisionTranscriptTurns() {
  return [
    { speakerId: "speaker-a", startMs: 0, turnId: "turn-release-decision" },
    { speakerId: "speaker-a", startMs: 1, turnId: "turn-release-action" },
    { speakerId: "speaker-b", startMs: 2, turnId: "turn-real-action" },
    {
      speakerId: "speaker-a",
      startMs: 3,
      turnId: "turn-release-separated",
    },
  ] as const;
}

function transcriptTurns() {
  return [
    { speakerId: "speaker-a", startMs: 0, turnId: "turn-a" },
    { speakerId: "speaker-b", startMs: 1, turnId: "turn-b-1" },
    { speakerId: "speaker-b", startMs: 2, turnId: "turn-b-2" },
  ] as const;
}
