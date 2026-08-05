import { describe, expect, it } from "vitest";

import { boundLiveFinalCaptionHistory } from "../src/live-runtime/live-caption-history.js";

describe("boundLiveFinalCaptionHistory", () => {
  it("retains an opening and a contiguous newest tail under the explicit safety bound", () => {
    const captions = new Map(
      Array.from({ length: 4_098 }, (_, index) => [
        `turn-${index}`,
        {
          endMs: index * 1_000 + 500,
          isFinal: true,
          speakerId: `speaker-${index % 3}`,
          startMs: index * 1_000,
          text: `Реплика ${index}`,
        },
      ]),
    );

    boundLiveFinalCaptionHistory(captions);

    expect(captions).toHaveLength(4_096);
    expect(captions.has("turn-0")).toBe(true);
    expect(captions.has("turn-63")).toBe(true);
    expect(captions.has("turn-64")).toBe(false);
    expect(captions.has("turn-65")).toBe(false);
    expect(captions.has("turn-66")).toBe(true);
    expect(captions.has("turn-4097")).toBe(true);
  });
});
