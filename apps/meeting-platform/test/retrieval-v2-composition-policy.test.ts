import { describe, expect, it } from "vitest";

import * as infinityAdapter from "@discord-meeting/infinity-context-adapter";
import * as meetingKnowledge from "@discord-meeting/meeting-core/meeting-knowledge";

import { localFinalReplyPolicy } from
  "../src/composition/meeting-knowledge.js";

describe("Retrieval V2-only composition policy", () => {
  it("admits new jobs only under one V2 epoch", () => {
    expect(localFinalReplyPolicy.retrievalAdmission).toEqual({
      cutoverEpoch: "infinity-locator-v2-only-r1",
      infinityProfileFingerprint:
        "2e69df6bf22461ee8d6844c7e6699cfb099ad36d84b0aa15f1d3061754ff27be",
    });
    expect(localFinalReplyPolicy).not.toHaveProperty("legacyRetrievalMigration");
  });

  it("exports no constructible legacy generic engine or semantic search adapter", () => {
    expect(meetingKnowledge).not.toHaveProperty("HistoricalFocusedRetrieval");
    expect(meetingKnowledge).not.toHaveProperty("SameRoomFocusedMemoryRetrieval");
    expect(infinityAdapter.InfinityContextHistoricalMemoryAdapter.prototype)
      .not.toHaveProperty("searchRoom");
  });
});
