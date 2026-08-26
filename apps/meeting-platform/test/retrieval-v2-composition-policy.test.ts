import { describe, expect, it } from "vitest";

import * as infinityAdapter from "@discord-meeting/infinity-context-adapter";
import * as meetingKnowledge from "@discord-meeting/meeting-core/meeting-knowledge";

import { createDiscordInfinityActorCustody } from
  "../src/composition/discord-infinity-actor-custody.js";
import { localFinalReplyPolicy } from
  "../src/composition/meeting-knowledge.js";
import { historicalActorA, platformConfig } from
  "./meeting-knowledge-production-composition-fixtures.js";

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

  it("groups every rotated actor key under one collision-safe participant owner", () => {
    const custody = createDiscordInfinityActorCustody(
      platformConfig("http://127.0.0.1:1", false, false, "test"),
      "t".repeat(32),
    );

    expect(custody.speakerAliases).toEqual([{
      actorKeys: [
        expect.stringMatching(/^dactor1\.synthetic-r0\./u),
        expect.stringMatching(/^dactor1\.synthetic-r1\./u),
      ],
      aliases: ["Vlad", "Vladimir", historicalActorA],
    }]);
    expect([...meetingKnowledge.resolveRequestedActorKeys(
      `What did ${historicalActorA} decide?`,
      custody.speakerAliases,
    )]).toEqual(custody.speakerAliases[0]?.actorKeys);
  });
});
