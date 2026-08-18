import { assert, constantFrom, property } from "fast-check";
import { describe, expect, it } from "vitest";

import {
  requiresExhaustiveCoverage,
} from "@discord-meeting/meeting-core/meeting-knowledge";

describe("question scope admission", () => {
  it.each([
    "Total decisions?",
    "Count action items",
    "Итого решений?",
    "Общее количество задач?",
    "How many decisions did everyone make?",
    "List all action items",
    "Did anyone mention security?",
    "Was Project Cedar mentioned?",
    "Was budget pressure discussed?",
    "Were there any decisions?",
    "Was there any action item?",
    "Which decisions were made?",
    "What's in all of Alex's decisions?",
    "Summarize the whole meeting",
    "What decisions were made?",
    "Give me an overview and timeline",
    "Were there any risks across the meetings?",
    "Сколько решений приняли?",
    "Перечисли все задачи",
    "Никто не возражал?",
    "Были ли какие-либо решения?",
    "Были решения?",
    "Есть ли задачи?",
    "Подведи итог всей встречи",
    "Какие решения приняли?",
  ])("requires exhaustive coverage for %s", (question) => {
    expect(requiresExhaustiveCoverage(question)).toBe(true);
  });

  it.each([
    "When did Alex correct the release date?",
    "Какой срок назвала Мария после исправления?",
    "Was Monday the corrected date?",
    "How many days did Alex propose?",
    "What did Alex mean by 'no downtime'?",
    "What did Alex mean by 'all decisions'?",
    "What did Alex mean by 'all of Alice's decisions'?",
    "What did Alex mean by ‘all decisions’?",
    "What did Alex mean by `all decisions`?",
    "What did Alex mean by \"all decisions\"?",
    "Что Мария имела в виду под «все готово»?",
    "Did Alex say the launch was not delayed?",
    "Were there two days between the dates?",
    "Был ли понедельник исправленной датой?",
  ])("keeps ordinary current facts on focused retrieval for %s", (question) => {
    expect(requiresExhaustiveCoverage(question)).toBe(false);
  });

  it("does not promote exhaustive vocabulary quoted in a local question", () => {
    assert(property(constantFrom(
      "all decisions",
      "no risks",
      "все решения",
      "никто не возражал",
    ), (quoted) => {
      expect(requiresExhaustiveCoverage(`What did Alex mean by "${quoted}"?`)).toBe(false);
    }));
  });
});
