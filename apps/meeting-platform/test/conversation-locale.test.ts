import { describe, expect, it } from "vitest";

import { resolveConversationLocale } from "../src/live-runtime/conversation-locale.js";

describe("resolveConversationLocale", () => {
  it.each([
    ["Ботик, расскажи коротко", "ru"],
    ["Botik, answer briefly", "en"],
    ["Ботик, answer this in English", "en"],
    ["Botik, ответь по-русски", "ru"],
    ["Ботек, answer in English", "en"],
    ["botyk, ответь по-русски", "ru"],
    ["Ботик, 123", "auto"],
    ["Ботек", "auto"],
  ])("resolves auto locale for %s", (text, expected) => {
    expect(resolveConversationLocale("auto", text)).toBe(expected);
  });

  it("preserves an explicitly configured locale", () => {
    expect(resolveConversationLocale("de-DE", "Ботик, answer in English")).toBe(
      "de-DE",
    );
  });
});
