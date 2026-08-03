import { describe, expect, it } from "vitest";

import {
  footerHasMarker,
  threadNameHasLegacyMarker,
} from "../src/discord-evidence-probe.js";

const marker = "meeting-projection:0123456789abcdef0123";

describe("Discord projection marker compatibility", () => {
  it("accepts current human-readable and legacy thread suffixes", () => {
    expect(threadNameHasLegacyMarker("Итоги встречи [код 0123456789abcdef0123]", marker)).toBe(true);
    expect(threadNameHasLegacyMarker("Итоги встречи [0123456789abcdef0123]", marker)).toBe(true);
    expect(threadNameHasLegacyMarker("Итоги встречи [код ffffffffffffffffffff]", marker)).toBe(false);
  });

  it("accepts the hidden v3 marker and legacy thread metadata", () => {
    expect(footerHasMarker(
      "Meeting Platform · meeting summary",
      `https://meeting-platform.invalid/projection/${encodeURIComponent(marker)}`,
      marker,
    )).toBe(true);
    expect(footerHasMarker(marker, undefined, marker)).toBe(true);
    expect(footerHasMarker("Meeting Platform · meeting summary", undefined, marker, true)).toBe(true);
    expect(footerHasMarker("Meeting Platform · итог встречи", undefined, marker, true)).toBe(true);
    expect(footerHasMarker("unrelated", undefined, marker)).toBe(false);
  });
});
