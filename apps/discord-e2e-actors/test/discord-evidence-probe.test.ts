import { describe, expect, it } from "vitest";

import {
  footerHasMarker,
  threadNameHasMarker,
} from "../src/discord-evidence-probe.js";

const marker = "meeting-projection:0123456789abcdef0123";

describe("Discord projection marker compatibility", () => {
  it("accepts current human-readable and legacy thread suffixes", () => {
    expect(threadNameHasMarker("Итоги встречи [код 0123456789abcdef0123]", marker)).toBe(true);
    expect(threadNameHasMarker("Итоги встречи [0123456789abcdef0123]", marker)).toBe(true);
    expect(threadNameHasMarker("Итоги встречи [код ffffffffffffffffffff]", marker)).toBe(false);
  });

  it("accepts the current UX footer and legacy raw marker", () => {
    expect(footerHasMarker("Meeting Platform · итог встречи", marker)).toBe(true);
    expect(footerHasMarker(marker, marker)).toBe(true);
    expect(footerHasMarker("unrelated", marker)).toBe(false);
  });
});
