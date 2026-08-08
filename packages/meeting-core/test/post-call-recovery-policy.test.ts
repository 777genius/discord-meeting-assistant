import { describe, expect, it } from "vitest";

import { postCallRecoveryDelayMs } from "../src/features/post-call-workflow/index.js";

describe("post-call recovery policy", () => {
  it.each([
    [1, 5 * 60_000],
    [2, 30 * 60_000],
    [3, 2 * 60 * 60_000],
    [4, 6 * 60 * 60_000],
    [40, 6 * 60 * 60_000],
  ])("maps recovery generation %i to %i ms", (generation, delayMs) => {
    expect(postCallRecoveryDelayMs(generation)).toBe(delayMs);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid recovery generation %s",
    (generation) => {
      expect(() => postCallRecoveryDelayMs(generation)).toThrow(RangeError);
    },
  );
});
