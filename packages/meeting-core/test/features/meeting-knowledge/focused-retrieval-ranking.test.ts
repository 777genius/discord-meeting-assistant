import { describe, expect, it } from "vitest";

import {
  decomposeHistoricalQuery,
  resolveRequestedSpeakerIds,
} from "@discord-meeting/meeting-core/meeting-knowledge";

describe("focused query decomposition", () => {
  it("reserves the complete question before bounded clause expansion", () => {
    expect(decomposeHistoricalQuery(
      "Who owns Atlas and when does it ship; what changed then who approved it?",
      3,
    )).toEqual([
      "Who owns Atlas and when does it ship; what changed then who approved it?",
      "Who owns Atlas",
      "when does it ship",
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
