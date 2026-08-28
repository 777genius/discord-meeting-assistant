import { describe, expect, it } from "vitest";

import * as infinityAdapter from "@discord-meeting/infinity-context-adapter";
import * as meetingKnowledge from "@discord-meeting/meeting-core/meeting-knowledge";

import { createDiscordInfinityActorCustody } from
  "../src/composition/discord-infinity-actor-custody.js";
import { localFinalReplyPolicy } from
  "../src/composition/meeting-knowledge.js";
import { createPersistedFocusedMemoryRoute } from
  "../src/composition/meeting-knowledge-retrieval-router.js";
import { historicalActorA, platformConfig } from
  "./meeting-knowledge-production-composition-fixtures.js";

describe("bounded meeting retrieval composition policy", () => {
  it("binds indexed and explicit local paths under one deterministic epoch", () => {
    expect(localFinalReplyPolicy.retrievalAdmission).toEqual({
      cutoverEpoch: "infinity-locator-v2-only-r1",
      infinityProfileFingerprint:
        "2e69df6bf22461ee8d6844c7e6699cfb099ad36d84b0aa15f1d3061754ff27be",
      localProfileFingerprint:
        "8b2453490a91a484b8d2825ae247a93d8ba2fa54b19cf26a3161db783f8629d5",
    });
    expect(localFinalReplyPolicy).not.toHaveProperty("legacyRetrievalMigration");
  });

  it("exports no constructible legacy generic engine or semantic search adapter", () => {
    expect(meetingKnowledge).not.toHaveProperty("HistoricalFocusedRetrieval");
    expect(meetingKnowledge).not.toHaveProperty("SameRoomFocusedMemoryRetrieval");
    expect(infinityAdapter.InfinityContextHistoricalMemoryAdapter.prototype)
      .not.toHaveProperty("searchRoom");
    expect(infinityAdapter).not.toHaveProperty("createInfinitySemanticQualificationManifest");
    expect(infinityAdapter.INFINITY_CONTEXT_PRODUCTION_QUALIFICATION
      .productionSemanticQualification).toBe(false);
  });

  it("routes a first-meeting local binding without requiring Infinity composition", async () => {
    const local = { retrieve: async () => ({ authorityGeneration: "current-generation",
      candidates: [{ meetingId: "meeting-1", transcriptId: "transcript-1",
        transcriptVersion: 1, turnHash: "a".repeat(64), turnId: "turn-1" }],
      schemaVersion: 1 as const, status: "current" as const }) };
    const route = createPersistedFocusedMemoryRoute({ current: local });

    await expect(route.retrieve({ canonicalEvidenceHash: "b".repeat(64),
      expectedAuthorityGeneration: "current-generation", finalProjectionReceipt: "receipt",
      maximumCandidates: 10, meetingId: "meeting-1", meetingRevision: 1,
      neighborTurns: 0, projectionTargetContainerId: "container", question: "Decision?",
      retrievalBinding: { cutoverEpoch: "epoch", profileFingerprint: "c".repeat(64),
        retrievalPath: "canonical_local_exact_lexical_v1" }, roomId: "room-1",
      scopeId: "scope-1", transcriptId: "transcript-1", transcriptVersion: 1 }))
      .resolves.toMatchObject({ status: "current" });
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
      custody.identitySkeletons,
    )]).toEqual(custody.speakerAliases[0]?.actorKeys);
  });

  it.each(["Vlad", "Ｖｌａｄ", "𝐕𝐥𝐚𝐝"])(
    "uses safe canonical equality for actor filtering: %s",
    (identity) => {
      const custody = createDiscordInfinityActorCustody(
        platformConfig("http://127.0.0.1:1", false, false, "test"),
        "t".repeat(32),
      );
      expect([...meetingKnowledge.resolveRequestedActorKeys(
        `What did ${identity} decide?`,
        custody.speakerAliases,
        custody.identitySkeletons,
      )]).toEqual(custody.speakerAliases[0]?.actorKeys);
    },
  );

  it("uses the Discord skeleton boundary only to deny an ambiguous alias", () => {
    const custody = createDiscordInfinityActorCustody(
      platformConfig("http://127.0.0.1:1", false, false, "test"),
      "t".repeat(32),
    );
    expect([...meetingKnowledge.resolveRequestedActorKeys(
      "What did Ѵӏаԁ decide?",
      custody.speakerAliases,
      custody.identitySkeletons,
    )]).toEqual([]);
    expect(meetingKnowledge.hasUncertainRequestedActorAlias(
      "What did Ѵӏаԁ decide?",
      custody.speakerAliases,
      custody.identitySkeletons,
    )).toBe(true);
  });

  it("keeps exact safe Cyrillic aliases authoritative", () => {
    const config = {
      ...platformConfig("http://127.0.0.1:1", false, false, "test"),
      participantGreetingProfiles: {
        [historicalActorA]: {
          displayName: "Влад",
          greetingLocale: "ru" as const,
          spokenName: "Владимир",
        },
      },
    };
    const custody = createDiscordInfinityActorCustody(config, "t".repeat(32));

    expect([...meetingKnowledge.resolveRequestedActorKeys(
      "Что решил Влад?",
      custody.speakerAliases,
      custody.identitySkeletons,
    )]).toEqual(custody.speakerAliases[0]?.actorKeys);
    expect(meetingKnowledge.hasUncertainRequestedActorAlias(
      "Что решил Влад?",
      custody.speakerAliases,
      custody.identitySkeletons,
    )).toBe(false);
  });

  it.each([
    "<@987654321098765432>",
    "<@!987654321098765432>",
    "987654321098765432",
  ])("derives active and retained keys directly for unprofiled Discord identity %s",
    (identity) => {
      const custody = createDiscordInfinityActorCustody(
        platformConfig("http://127.0.0.1:1", false, false, "test"),
        "t".repeat(32),
      );

      expect(custody.actorReferences.actorKeysForQuestion(
        `What did ${identity} decide?`,
      )).toEqual([
        expect.stringMatching(/^dactor1\.synthetic-r0\./u),
        expect.stringMatching(/^dactor1\.synthetic-r1\./u),
      ]);
      expect(JSON.stringify(custody.actorReferences.actorKeysForQuestion(identity)))
        .not.toContain("987654321098765432");
    });
});
