import { describe, expect, it } from "vitest";

import {
  decomposeHistoricalQuery,
  resolveRequestedSpeakerIds,
} from "@discord-meeting/meeting-core/meeting-knowledge";

describe("focused query decomposition", () => {
  it("prioritizes unique clauses within the configured multi-query bound", () => {
    expect(decomposeHistoricalQuery(
      "Who owns Atlas and when does it ship; what changed then who approved it?",
      3,
    )).toEqual([
      "Who owns Atlas",
      "when does it ship",
      "what changed",
    ]);
    expect(decomposeHistoricalQuery("Where is cedar discussed?", 1))
      .toEqual(["Where is cedar discussed?"]);
  });

  it("maps configured real names to opaque canonical speaker IDs", () => {
    expect([...resolveRequestedSpeakerIds(
      "Что Влад решил про релиз?",
      {
        "417240344673910785": ["Влад", "Vlad"],
        "737624409321373757": ["Марк", "Mark"],
      },
    )]).toEqual(["417240344673910785"]);
  });
});
