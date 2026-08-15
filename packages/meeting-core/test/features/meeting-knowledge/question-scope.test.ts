import { describe, expect, it } from "vitest";

import {
  requiresExhaustiveCoverage,
} from "@discord-meeting/meeting-core/meeting-knowledge";

describe("question scope admission", () => {
  it.each([
    "How many decisions did everyone make?",
    "List all action items",
    "Did anyone mention security?",
    "Was Project Cedar mentioned?",
    "Was budget pressure discussed?",
    "Summarize the whole meeting",
    "What decisions were made?",
    "Give me an overview and timeline",
    "Were there any risks across the meetings?",
    "Сколько решений приняли?",
    "Перечисли все задачи",
    "Никто не возражал?",
    "Подведи итог всей встречи",
    "Какие решения приняли?",
  ])("requires exhaustive coverage for %s", (question) => {
    expect(requiresExhaustiveCoverage(question)).toBe(true);
  });

  it.each([
    "When did Alex correct the release date?",
    "Какой срок назвала Мария после исправления?",
    "Was Monday the corrected date?",
  ])("keeps ordinary current facts on focused retrieval for %s", (question) => {
    expect(requiresExhaustiveCoverage(question)).toBe(false);
  });
});
