import { assert, property, string } from "fast-check";
import { describe, expect, it } from "vitest";

import {
  resolveAnswerLocale,
} from "@discord-meeting/meeting-core/meeting-knowledge";

describe("Meeting Knowledge answer locale", () => {
  it.each([
    ["Когда мы выпускаем релиз?", "ru"],
    ["When do we ship the release?", "en"],
    ["Когда deploy для API?", "mixed"],
    ["When is the release? Ответь на русском.", "ru"],
    ["Когда релиз? Please answer in English.", "en"],
    ["Ответь на русском and answer in English", "mixed"],
  ] as const)("resolves %j as %s", (question, expected) => {
    expect(resolveAnswerLocale(question)).toBe(expected);
  });

  it("is deterministic for arbitrary Unicode and never invents a locale", () => {
    assert(property(string({ maxLength: 2_000 }), (question) => {
      const first = resolveAnswerLocale(question);
      const second = resolveAnswerLocale(question);
      expect(first).toBe(second);
      expect(["en", "mixed", "ru"]).toContain(first);
    }), { numRuns: 500 });
  });
});
