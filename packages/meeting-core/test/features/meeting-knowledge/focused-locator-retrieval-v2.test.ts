import { describe, expect, it, vi } from "vitest";

import {
  HistoricalFocusedLocatorRetrievalV2,
  PersistedFocusedMemoryRetrievalV2,
  PrepareFocusedLocatorRetrievalV2Request,
  buildHistoricalIndexPlan,
  type FocusedLocatorRetrievalV2Port,
  type HistoricalAuthorizationPort,
  type HistoricalEvidenceAuthority,
  type HistoricalOpaqueIdPort,
} from "@discord-meeting/meeting-core/meeting-knowledge";

import { AppliedStore, TestIds, makeMeeting } from
  "../../fixtures/historical-retrieval-fixtures.js";

const providerBinding = Object.freeze({
  capabilityFingerprint: "3".repeat(64),
  contractVersion: "context-retrieval.v2" as const,
  indexProfileDigest: "2".repeat(64),
  profileId: "locator-v2-qualified-profile",
  rankingPolicy: "weighted_rrf_canonical_preferences.v1" as const,
  requiredProviderLanes: Object.freeze(["postgres_keyword", "qdrant_dense"]),
  serviceRevision: "4".repeat(40),
});

const identitySkeletons = Object.freeze({
  skeleton: (value: string) => {
    const canonical = value.normalize("NFKC").toLocaleLowerCase("und");
    return Object.freeze({ canonical, certainty: "certain" as const, skeleton: canonical });
  },
});

function markerTurn(marker: string) {
  return [{
    endMs: 1_000,
    speakerId: "speaker",
    startMs: 0,
    text: marker,
    turnId: `turn-${marker}`,
  }];
}

function fixture() {
  const meeting = makeMeeting({ meetingId: "historical-meeting", turns: [{
    endMs: 430_000,
    speakerId: "opaque-vlad",
    startMs: 420_000,
    text: "Влад approved the launch on Tuesday",
    turnId: "turn-vlad",
  }] });
  const plan = buildHistoricalIndexPlan(meeting, new TestIds());
  const store = new AppliedStore([{ binding: meeting.binding, plan,
    remoteDocumentIds: {} }]);
  const prepare = new PrepareFocusedLocatorRetrievalV2Request({
    ids: new TestIds(),
    identitySkeletons,
    providerBinding,
    speakerAliases: [{
      actorKeys: ["opaque-vlad"],
      aliases: ["Влад", "Vlad"],
    }],
    store,
  });
  return { meeting, plan, prepare, store };
}

describe("persisted focused locator Retrieval V2 request", () => {
  it("orders base64url-like source identities by UTF-8 bytes", async () => {
    const identities = ["A", "a", "_", "-"];
    expect(identities.toSorted((left, right) => left.localeCompare(right)))
      .not.toEqual(identities.toSorted());
    const ids: HistoricalOpaqueIdPort = {
      keyedId: (namespace, parts) => namespace === "historical-release"
        ? (parts[2] ?? "missing")
        : new TestIds().keyedId(namespace, parts),
    };
    const records = identities.map((meetingId) => {
      const meeting = makeMeeting({ meetingId, turns: markerTurn(meetingId) });
      return { binding: meeting.binding, plan: buildHistoricalIndexPlan(meeting, ids),
        remoteDocumentIds: {} };
    });
    const request = await new PrepareFocusedLocatorRetrievalV2Request({
      ids, providerBinding, store: new AppliedStore(records),
    }).prepare({ currentMeetingId: "current-meeting", question: "What changed?",
      roomId: "room-1", scopeId: "scope-1" });

    expect(request?.filters.sourceGenerations.map(({ sourceKey }) => sourceKey))
      .toEqual(["-", "A", "_", "a"].map((identity) => `mkrelease1.${identity}`));
  });

  it.each([99, 100])(
    "admits exactly 100 total sources and rejects %i historical sources beside indexed current",
    async (historicalCount) => {
      const meetings = [makeMeeting({
        meetingId: "current-meeting",
        turns: markerTurn("current-meeting"),
      }),
        ...Array.from({ length: historicalCount }, (_, index) =>
          makeMeeting({
            meetingId: `historical-${String(index).padStart(3, "0")}`,
            turns: markerTurn(`historical-${String(index).padStart(3, "0")}`),
          }))];
      const records = meetings.map((meeting) => ({ binding: meeting.binding,
        plan: buildHistoricalIndexPlan(meeting, new TestIds()), remoteDocumentIds: {} }));
      const request = await new PrepareFocusedLocatorRetrievalV2Request({
        ids: new TestIds(), providerBinding, store: new AppliedStore(records),
      }).prepare({ currentMeetingId: "current-meeting", question: "What changed?",
        roomId: "room-1", scopeId: "scope-1" });

      if (historicalCount === 99) {
        expect(request?.filters.sourceGenerations).toHaveLength(100);
      } else {
        expect(request).toBeNull();
      }
    },
  );

  it("includes the exact indexed current generation and ignores an unrelated stale plan", async () => {
    const current = makeMeeting({ meetingId: "current-meeting", turns: markerTurn("current") });
    const stale = makeMeeting({ meetingId: "stale-history", turns: markerTurn("stale") });
    const valid = makeMeeting({ meetingId: "valid-history", turns: markerTurn("valid") });
    const records = [current, stale, valid].map((meeting) => ({
      binding: meeting.binding,
      plan: buildHistoricalIndexPlan(meeting, new TestIds()),
      remoteDocumentIds: {},
    }));
    const store = new AppliedStore(records);
    store.currentSequence = [true, false, true];

    const request = await new PrepareFocusedLocatorRetrievalV2Request({
      ids: new TestIds(), providerBinding, store,
    }).prepare({ currentMeetingId: current.binding.meetingId,
      question: "What changed?", roomId: "room-1", scopeId: "scope-1" });

    expect(request?.filters.sourceGenerations).toHaveLength(2);
    expect(request?.filters.sourceGenerations).toEqual(expect.arrayContaining([
      records[0]!.plan,
      records[2]!.plan,
    ].map(({ topology }) => ({
      projectionGeneration: topology.indexGeneration,
      sourceKey: topology.releaseRef,
    }))));
  });

  it("fails generation authority closed per source without discarding valid sources", async () => {
    const first = makeMeeting({ meetingId: "current-meeting", turns: markerTurn("first") });
    const unavailable = makeMeeting({ meetingId: "unavailable-history",
      turns: markerTurn("unavailable") });
    const last = makeMeeting({ meetingId: "valid-history", turns: markerTurn("last") });
    const records = [first, unavailable, last].map((meeting) => ({
      binding: meeting.binding,
      plan: buildHistoricalIndexPlan(meeting, new TestIds()),
      remoteDocumentIds: {},
    }));
    const store = new AppliedStore(records);
    vi.spyOn(store, "isCurrentGeneration")
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("source authority unavailable"))
      .mockResolvedValueOnce(true);

    const request = await new PrepareFocusedLocatorRetrievalV2Request({
      ids: new TestIds(), providerBinding, store,
    }).prepare({ currentMeetingId: first.binding.meetingId,
      question: "What changed?", roomId: "room-1", scopeId: "scope-1" });

    expect(request?.filters.sourceGenerations).toEqual(expect.arrayContaining([
      records[0]!.plan,
      records[2]!.plan,
    ].map(({ topology }) => ({
      projectionGeneration: topology.indexGeneration,
      sourceKey: topology.releaseRef,
    }))));
    expect(request?.filters.sourceGenerations).toHaveLength(2);
  });

  it.each([
    "Что Влад решил с 07:00 до 08:00?",
    "What did Vlad decide between 07:00 and 08:00?",
    "Что Vlad decided с 07:00 до 08:00?",
  ])("maps exact scope, source generation, canonical speaker and time for %s",
    async (question) => {
      const { plan, prepare } = fixture();
      const request = await prepare.prepare({
        currentMeetingId: "current-meeting",
        question,
        roomId: "room-1",
        scopeId: "scope-1",
      });
      expect(request).not.toBeNull();
      expect(request?.queries).toEqual([{
        query: question.normalize("NFKC").toLocaleLowerCase("und")
          .replace(/влад|vlad/gu, "participant"),
        queryId: "original-question",
      }]);
      expect(request?.filters.actorKeys).toEqual(["opaque-vlad"]);
      expect(request?.filters.relativeTimeInterval).toEqual({
        endMs: 480_000,
        startMs: 420_000,
      });
      expect(request?.filters.sourceGenerations).toEqual([{
        projectionGeneration: plan.topology.indexGeneration,
        sourceKey: plan.topology.releaseRef,
      }]);
      expect(request?.scope).toMatchObject({
        memoryScopeId: plan.topology.roomScopeExternalRef,
        spaceId: plan.topology.spaceSlug,
        threadId: null,
      });
      expect(request?.budgets).toMatchObject({
        evidenceByteLimit: 16_000,
        neighborRadius: 0,
        resultLimit: 10,
      });
      expect(request?.softPreferences).toEqual({
        actorPreferences: [],
        relativeTimeInterval: null,
        sourcePreferences: [],
        timeInterval: null,
        timeWeightMicros: null,
      });
    });
});

describe("focused locator Retrieval V2 privacy and serving authority", () => {
  it("derives retained actor filters for an unprofiled mention through local authority", async () => {
    const { store } = fixture();
    const rawActorId = "987654321098765432";
    const actorKeysForQuestion = vi.fn(() => [
      "dactor1.r0.unprofiled-retained",
      "dactor1.r1.unprofiled-active",
    ]);
    const request = await new PrepareFocusedLocatorRetrievalV2Request({
      actorReferences: { actorKeysForQuestion },
      ids: new TestIds(),
      providerBinding,
      speakerAliases: [],
      store,
    }).prepare({
      currentMeetingId: "current-meeting",
      question: `What did <@!${rawActorId}> decide?`,
      roomId: "room-1",
      scopeId: "scope-1",
    });

    expect(actorKeysForQuestion).toHaveBeenCalledWith(
      `What did <@!${rawActorId}> decide?`,
    );
    expect(request?.filters.actorKeys).toEqual([
      "dactor1.r0.unprofiled-retained",
      "dactor1.r1.unprofiled-active",
    ]);
    expect(request?.queries).toEqual([{
      query: "what did participant decide?",
      queryId: "original-question",
    }]);
    expect(JSON.stringify(request)).not.toContain(rawActorId);
  });

  it.each([
    "ALEX SMITH",
    "Ａｌｅｘ Ｓｍｉｔｈ",
    "Alex-Smith",
    "alex_smith",
    "Alex   Smith",
    "Alex-Smith, Alex_Smith; ALEX SMITH",
  ])("redacts recognized alias punctuation independently of filter resolution: %s",
    async (variant) => {
      const { store } = fixture();
      const request = await new PrepareFocusedLocatorRetrievalV2Request({
        ids: new TestIds(),
        identitySkeletons,
        providerBinding,
        speakerAliases: [{ actorKeys: ["opaque-alex"], aliases: ["Alex Smith"] }],
        store,
      }).prepare({
        currentMeetingId: "current-meeting",
        question: `What did ${variant} decide?`,
        roomId: "room-1",
        scopeId: "scope-1",
      });

      expect(request?.queries[0]?.query).not.toMatch(/alex|smith/iu);
    expect(request?.filters.actorKeys).toEqual(["opaque-alex"]);
    });

  it.each([
    ["Ａｌｉｃｅ", "Alice"],
    ["Alice", "ＡＬＩＣＥ"],
    ["AlicE", "Ａｌｉｃｅ"],
  ])("normalizes query %s and configured alias %s before resolution and redaction",
    async (questionAlias, configuredAlias) => {
      const { store } = fixture();
      const request = await new PrepareFocusedLocatorRetrievalV2Request({
        ids: new TestIds(),
        identitySkeletons,
        providerBinding,
        speakerAliases: [{ actorKeys: ["opaque-alice"], aliases: [configuredAlias] }],
        store,
      }).prepare({
        currentMeetingId: "current-meeting",
        question: `What did ${questionAlias} decide?`,
        roomId: "room-1",
        scopeId: "scope-1",
      });

      expect(request?.filters.actorKeys).toEqual(["opaque-alice"]);
      expect(JSON.stringify(request?.queries)).not.toMatch(/alice|Ａｌｉｃｅ/iu);
      expect(request?.queries[0]?.query).toBe("what did participant decide?");
    });
});

describe("focused locator Retrieval V2 confusable identity admission", () => {

  it.each([
    "Аlice",
    "Αlice",
    "аӏісе",
    "АLІСЕ",
    "A\u0338lice",
  ])("denies a skeleton-only Alice collision before I/O: %s", async (variant) => {
    const { store } = fixture();
    const listPlans = vi.spyOn(store, "listCurrentRoomPlans");
    const certainAliceSkeletons = Object.freeze({
      skeleton: (value: string) => {
        const canonical = value.normalize("NFKC").toLocaleLowerCase("und");
        return Object.freeze({ canonical, certainty: "certain" as const,
          skeleton: canonical === "alice" || canonical ===
            variant.normalize("NFKC").toLocaleLowerCase("und") ? "alice" : canonical });
      },
    });
    const request = await new PrepareFocusedLocatorRetrievalV2Request({
      ids: new TestIds(), identitySkeletons: certainAliceSkeletons, providerBinding,
      speakerAliases: [{ actorKeys: ["opaque-alice"], aliases: ["Alice"] }], store,
    }).prepare({ currentMeetingId: "current-meeting",
      question: `What did ${variant} decide about обычный релиз?`,
      roomId: "room-1", scopeId: "scope-1" });

    expect(request).toBeNull();
    expect(listPlans).not.toHaveBeenCalled();
  });

  it.each([
    "Аli\u200Bce",
    "Αli\u202Ece",
    "Аli\u2063ce",
    "Аli\u034Fce",
    "Ali\u0000ce",
    "Ali\u2060ce",
    "Ali\uFE0Fce",
    "Ali\u{E0061}ce",
  ])(
    "fails before I/O when an Alice-like mixed-script token is uncertain: %s",
    async (variant) => {
      const { store } = fixture();
      const listPlans = vi.spyOn(store, "listCurrentRoomPlans");
      const uncertainAliceSkeletons = Object.freeze({
        skeleton: (value: string) => {
          const canonical = value.normalize("NFKC").toLocaleLowerCase("und");
          const alias = canonical === "alice";
          const risky = ["\u0000", "\u034F", "\u200B", "\u202E", "\u2060", "\u2063",
            "\uFE0F", "\u{E0061}"].some((character) => canonical.includes(character));
          return Object.freeze({ canonical,
            certainty: risky ? "uncertain" as const : "certain" as const,
            skeleton: alias || risky ? "alice" : canonical });
        },
      });
      const request = await new PrepareFocusedLocatorRetrievalV2Request({
        ids: new TestIds(), identitySkeletons: uncertainAliceSkeletons, providerBinding,
        speakerAliases: [{ actorKeys: ["opaque-alice"], aliases: ["Alice"] }], store,
      }).prepare({ currentMeetingId: "current-meeting",
        question: `What did ${variant} decide?`, roomId: "room-1", scopeId: "scope-1" });

      expect(request).toBeNull();
      expect(listPlans).not.toHaveBeenCalled();
    },
  );

  it("checks every alias occurrence before admitting or redacting", async () => {
    const { store } = fixture();
    const listPlans = vi.spyOn(store, "listCurrentRoomPlans");
    const skeletons = Object.freeze({
      skeleton: (value: string) => {
        const canonical = value.normalize("NFKC").toLocaleLowerCase("und");
        const unsafe = canonical.includes("\u200B");
        return Object.freeze({ canonical,
          certainty: unsafe ? "uncertain" as const : "certain" as const,
          skeleton: unsafe ? canonical.replace("\u200B", "") : canonical });
      },
    });
    const request = await new PrepareFocusedLocatorRetrievalV2Request({
      ids: new TestIds(), identitySkeletons: skeletons, providerBinding,
      speakerAliases: [{ actorKeys: ["opaque-alice"], aliases: ["Alice"] }], store,
    }).prepare({ currentMeetingId: "current-meeting",
      question: "What did Alice and Ali\u200Bce decide?",
      roomId: "room-1", scopeId: "scope-1" });

    expect(request).toBeNull();
    expect(listPlans).not.toHaveBeenCalled();
  });

  it.each([
    ["Boba", "Вова", "boba"],
    ["Hopa", "Нора", "hopa"],
    ["Pay", "Рау", "pay"],
  ])("denies semantic cross-script collision %s / %s", async (
    alias, questionAlias, denySkeleton,
  ) => {
    const { store } = fixture();
    const listPlans = vi.spyOn(store, "listCurrentRoomPlans");
    const skeletons = Object.freeze({
      skeleton: (value: string) => {
        const canonical = value.normalize("NFKC").toLocaleLowerCase("und");
        return Object.freeze({ canonical, certainty: "certain" as const,
          skeleton: canonical === alias.toLocaleLowerCase("und") ||
            canonical === questionAlias.toLocaleLowerCase("und")
            ? denySkeleton : canonical });
      },
    });
    const request = await new PrepareFocusedLocatorRetrievalV2Request({
      ids: new TestIds(), identitySkeletons: skeletons, providerBinding,
      speakerAliases: [{ actorKeys: ["opaque-owner"], aliases: [alias] }], store,
    }).prepare({ currentMeetingId: "current-meeting",
      question: `Что решил ${questionAlias}?`, roomId: "room-1", scopeId: "scope-1" });

    expect(request).toBeNull();
    expect(listPlans).not.toHaveBeenCalled();
  });

  it("fails before I/O when configured aliases have no skeleton authority", async () => {
    const { store } = fixture();
    const listPlans = vi.spyOn(store, "listCurrentRoomPlans");
    const request = await new PrepareFocusedLocatorRetrievalV2Request({
      ids: new TestIds(), providerBinding,
      speakerAliases: [{ actorKeys: ["opaque-alice"], aliases: ["Alice"] }], store,
    }).prepare({ currentMeetingId: "current-meeting", question: "What did Alice decide?",
      roomId: "room-1", scopeId: "scope-1" });

    expect(request).toBeNull();
    expect(listPlans).not.toHaveBeenCalled();
  });
});

describe("focused locator Retrieval V2 privacy and serving authority continuation", () => {
  it.each(["🔥", "++", "..."])(
    "redacts an exact safe symbol-only alias %s including separated repetition",
    async (alias) => {
      const { store } = fixture();
      const request = await new PrepareFocusedLocatorRetrievalV2Request({
        ids: new TestIds(),
        identitySkeletons,
        providerBinding,
        speakerAliases: [{ actorKeys: ["opaque-symbol"], aliases: [alias] }],
        store,
      }).prepare({
        currentMeetingId: "current-meeting",
        question: `What did ${alias} / ${alias} decide?`,
        roomId: "room-1",
        scopeId: "scope-1",
      });

      expect(request?.filters.actorKeys).toEqual(["opaque-symbol"]);
      expect(request?.queries[0]?.query).toBe(
        "what did participant / participant decide?",
      );
      expect(JSON.stringify(request)).not.toContain(alias);
    },
  );

  it.each(["word🔥", "🔥word", "🔥🔥"])(
    "does not treat a symbol alias as a substring inside %s",
    async (variant) => {
      const { store } = fixture();
      const request = await new PrepareFocusedLocatorRetrievalV2Request({
        ids: new TestIds(), identitySkeletons, providerBinding,
        speakerAliases: [{ actorKeys: ["opaque-fire"], aliases: ["🔥"] }], store,
      }).prepare({
        currentMeetingId: "current-meeting",
        question: `What did ${variant} mean?`,
        roomId: "room-1",
        scopeId: "scope-1",
      });

      expect(request?.filters.actorKeys).toEqual([]);
      expect(request?.queries[0]?.query).toContain(variant);
    },
  );

  it("fails closed before provider preparation for duplicate alias owners", async () => {
    const { store } = fixture();
    const listPlans = vi.spyOn(store, "listCurrentRoomPlans");
    const actorKeysForQuestion = vi.fn(() => []);
    const request = await new PrepareFocusedLocatorRetrievalV2Request({
      actorReferences: { actorKeysForQuestion },
      ids: new TestIds(),
      identitySkeletons,
      providerBinding,
      speakerAliases: [
        { actorKeys: ["opaque-alex-one"], aliases: ["Alex"] },
        { actorKeys: ["opaque-alex-two"], aliases: ["Alex"] },
      ],
      store,
    }).prepare({
      currentMeetingId: "current-meeting",
      question: "What did Alex decide?",
      roomId: "room-1",
      scopeId: "scope-1",
    });

    expect(request).toBeNull();
    expect(listPlans).not.toHaveBeenCalled();
    expect(actorKeysForQuestion).not.toHaveBeenCalled();
  });

  it.each([
    ["Ａｌｉｃｅ", "Alice", "ＡＬＩＣＥ"],
    ["🔥", "🔥", "🔥"],
    ["Alex---Smith", "Alex Smith", "Ａｌｅｘ＿Ｓｍｉｔｈ"],
  ])("fails before I/O for normalized ambiguous alias %s",
    async (questionAlias, firstAlias, secondAlias) => {
      const { store } = fixture();
      const listPlans = vi.spyOn(store, "listCurrentRoomPlans");
      const request = await new PrepareFocusedLocatorRetrievalV2Request({
        ids: new TestIds(),
        identitySkeletons,
        providerBinding,
        speakerAliases: [
          { actorKeys: ["owner-one"], aliases: [firstAlias] },
          { actorKeys: ["owner-two"], aliases: [secondAlias] },
        ],
        store,
      }).prepare({
        currentMeetingId: "current-meeting",
        question: `What did ${questionAlias} decide?`,
        roomId: "room-1",
        scopeId: "scope-1",
      });

      expect(request).toBeNull();
      expect(listPlans).not.toHaveBeenCalled();
    });

  it("keeps rotated actor keys under one alias owner and redacts every identity form", async () => {
    const { plan, store } = fixture();
    const rawActorId = "123456789012345678";
    const request = await new PrepareFocusedLocatorRetrievalV2Request({
      ids: new TestIds(),
      identitySkeletons,
      providerBinding,
      speakerAliases: [{
        actorKeys: ["dactor1.r1.retained", "dactor1.r2.active"],
        aliases: ["Vlad", "Vladimir", rawActorId],
      }],
      store,
    }).prepare({
      currentMeetingId: "current-meeting",
      question: `What did <@${rawActorId}> Vlad and Vladimir decide between 07:00 and 08:00?`,
      roomId: "room-1",
      scopeId: "scope-1",
    });

    expect(request?.filters.actorKeys).toEqual([
      "dactor1.r1.retained",
      "dactor1.r2.active",
    ]);
    expect(request?.queries[0]?.query).toBe(
      "what did participant participant and participant decide between 07:00 and 08:00?",
    );
    expect(JSON.stringify(request)).not.toMatch(
      new RegExp(`${rawActorId}|Vlad|Vladimir`, "u"),
    );
    expect(request?.filters.sourceGenerations[0]).toEqual({
      projectionGeneration: plan.topology.indexGeneration,
      sourceKey: plan.topology.releaseRef,
    });
  });

  it("fails admission before store I/O when serving authority is closed", async () => {
    const { store } = fixture();
    const list = vi.spyOn(store, "listCurrentRoomPlans");
    const guarded = new PrepareFocusedLocatorRetrievalV2Request({
      ids: new TestIds(),
      identitySkeletons,
      providerBinding,
      servingAuthorized: () => false,
      speakerAliases: [{ actorKeys: ["opaque-vlad"], aliases: ["Vlad"] }],
      store,
    });

    await expect(guarded.prepare({
      currentMeetingId: "current-meeting",
      question: "What did Vlad decide?",
      roomId: "room-1",
      scopeId: "scope-1",
    })).resolves.toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it("rechecks serving authority immediately before provider I/O", async () => {
    const { meeting, plan, prepare, store } = fixture();
    const request = await prepare.prepare({ currentMeetingId: "current-meeting",
      question: "What did Vlad decide?", roomId: "room-1", scopeId: "scope-1" });
    const locator = plan.documents[0]?.manifest.candidateLocator;
    if (request === null || locator === undefined) {
      throw new Error("missing guarded retrieval fixture");
    }
    const retrieve = vi.fn<FocusedLocatorRetrievalV2Port["retrieve"]>(async () => ({
      candidates: [{ locator }], status: "available",
    }));
    const result = await new HistoricalFocusedLocatorRetrievalV2({
      authority: authority(meeting), authorization: authorization(), ids: new TestIds(),
      retrieval: { retrieve }, servingAuthorized: () => false, store,
      turnHashes: { hash: ({ turnId }) => `hash:${turnId}` },
    }).retrieve({ authorizationPrincipalRef: "principal",
      currentMeetingId: "current-meeting", request, roomId: "room-1",
      scopeId: "scope-1" });

    expect(result).toMatchObject({ status: "unavailable" });
    expect(retrieve).not.toHaveBeenCalled();
  });
});

describe("focused locator Retrieval V2 rehydration", () => {
  it("rehydrates an indexed current meeting under its exact persisted generation", async () => {
    const { meeting, plan, prepare, store } = fixture();
    const request = await prepare.prepare({ currentMeetingId: meeting.binding.meetingId,
      question: "Что решили?", roomId: "room-1", scopeId: "scope-1" });
    const locator = plan.documents[0]?.manifest.candidateLocator;
    if (request === null || locator === undefined) {
      throw new Error("missing indexed-current fixture");
    }
    const result = await new HistoricalFocusedLocatorRetrievalV2({
      authority: authority(meeting), authorization: authorization(), ids: new TestIds(),
      retrieval: { retrieve: async () => ({
        candidates: [{ locator }], status: "available",
      }) },
      store,
      turnHashes: { hash: ({ turnId }) => `hash:${turnId}` },
    }).retrieve({ authorizationPrincipalRef: "principal",
      currentMeetingId: meeting.binding.meetingId, request, roomId: "room-1",
      scopeId: "scope-1" });

    expect(result).toMatchObject({ status: "current" });
  });

  it("deduplicates indexed current evidence against canonical local hydration", async () => {
    const duplicate = Object.freeze({ meetingId: "current-meeting",
      transcriptId: "transcript-current", transcriptVersion: 1,
      turnHash: "a".repeat(64), turnId: "turn-current" });
    const memory = new PersistedFocusedMemoryRetrievalV2({
      current: { retrieve: async () => ({ authorityGeneration: "current-generation",
        candidates: [duplicate], schemaVersion: 1, status: "current" }) },
      historical: { retrieve: async () => ({ authorityGeneration: "historical-generation",
        candidates: [{ ...duplicate, historicalSource: { candidateLocator: "locator-current",
          indexGeneration: "index-current", releaseId: "release-current" } }],
        schemaVersion: 1, status: "current" }), reauthorizeRoom: async () => true } as
        unknown as HistoricalFocusedLocatorRetrievalV2,
    });

    const result = await memory.retrieve({ authorizationPrincipalRef: "principal",
      canonicalEvidenceHash: "b".repeat(64), expectedAuthorityGeneration: "current-generation",
      finalProjectionReceipt: "receipt", maximumCandidates: 10,
      meetingId: duplicate.meetingId, meetingRevision: 1, neighborTurns: 0,
      projectionTargetContainerId: "container", question: "What changed?",
      retrievalBinding: { cutoverEpoch: "epoch", profileFingerprint: "c".repeat(64),
        request: (await prepareRequestForComposite()), retrievalPath: "infinity_locator_v2" },
      roomId: "room-1", scopeId: "scope-1", transcriptId: duplicate.transcriptId,
      transcriptVersion: duplicate.transcriptVersion });

    expect(result).toMatchObject({ status: "current" });
    if (result.status === "current") {
      expect(result.candidates).toEqual([duplicate]);
    }
  });
  it("returns only canonical local references in provider order", async () => {
    const { meeting, plan, prepare, store } = fixture();
    const request = await prepare.prepare({
      currentMeetingId: "current-meeting",
      question: "Что Влад решил?",
      roomId: "room-1",
      scopeId: "scope-1",
    });
    if (request === null) {
      throw new Error("missing prepared request");
    }
    const locator = plan.documents[0]?.manifest.candidateLocator;
    if (locator === undefined) {
      throw new Error("missing locator");
    }
    const retrieval: FocusedLocatorRetrievalV2Port = {
      retrieve: vi.fn().mockResolvedValue({
        candidates: [{ locator }],
        status: "available",
      }),
    };
    const useCase = new HistoricalFocusedLocatorRetrievalV2({
      authority: authority(meeting), authorization: authorization(), ids: new TestIds(),
      retrieval, store, turnHashes: { hash: ({ turnId }) => `hash:${turnId}` },
    });
    const result = await useCase.retrieve({
      authorizationPrincipalRef: "principal",
      currentMeetingId: "current-meeting",
      request,
      roomId: "room-1",
      scopeId: "scope-1",
    });
    expect(result).toMatchObject({ status: "current" });
    if (result.status !== "current") {
      throw new Error("retrieval failed");
    }
    expect(result.candidates).toEqual([expect.objectContaining({
      meetingId: meeting.binding.meetingId,
      transcriptId: meeting.binding.transcriptId,
      turnHash: "hash:turn-vlad",
      turnId: "turn-vlad",
    })]);
    expect(JSON.stringify(result)).not.toMatch(/approved|Tuesday/u);
  });

  it.each([
    ["meetingId", "provider-owned-meeting"],
    ["turnId", "provider-owned-turn"],
    ["text", "remote transcript text"],
  ])("rejects extra provider candidate field %s", async (field, value) => {
    const { meeting, plan, prepare, store } = fixture();
    const request = await prepare.prepare({
      currentMeetingId: "current-meeting",
      question: "What did Vlad decide?",
      roomId: "room-1",
      scopeId: "scope-1",
    });
    const locator = plan.documents[0]?.manifest.candidateLocator;
    if (request === null || locator === undefined) {
      throw new Error("missing Retrieval V2 fixture");
    }
    const result = await new HistoricalFocusedLocatorRetrievalV2({
      authority: authority(meeting), authorization: authorization(), ids: new TestIds(),
      retrieval: { retrieve: async () => ({
        candidates: [{ locator, [field]: value }],
        status: "available",
      }) },
      store,
      turnHashes: { hash: ({ turnId }) => `hash:${turnId}` },
    }).retrieve({ authorizationPrincipalRef: "principal",
      currentMeetingId: "current-meeting", request, roomId: "room-1",
      scopeId: "scope-1" });

    expect(result).toMatchObject({ status: "unavailable" });
  });

  it("rejects duplicate local ownership hidden by locator map construction", async () => {
    const { meeting, plan, prepare } = fixture();
    const request = await prepare.prepare({ currentMeetingId: "current-meeting",
      question: "What did Vlad decide?", roomId: "room-1", scopeId: "scope-1" });
    const locator = plan.documents[0]?.manifest.candidateLocator;
    if (request === null || locator === undefined) {
      throw new Error("missing Retrieval V2 fixture");
    }
    const duplicatedStore = new AppliedStore([
      { binding: meeting.binding, plan, remoteDocumentIds: {} },
      { binding: meeting.binding, plan, remoteDocumentIds: {} },
    ]);
    const result = await new HistoricalFocusedLocatorRetrievalV2({
      authority: authority(meeting), authorization: authorization(), ids: new TestIds(),
      retrieval: { retrieve: async () => ({
        candidates: [{ locator }],
        status: "available",
      }) },
      store: duplicatedStore,
      turnHashes: { hash: ({ turnId }) => `hash:${turnId}` },
    }).retrieve({ authorizationPrincipalRef: "principal",
      currentMeetingId: "current-meeting", request, roomId: "room-1",
      scopeId: "scope-1" });

    expect(result).toMatchObject({ status: "unavailable" });
  });

  it("fails closed for foreign, stale, oversized, cancelled, or permission-lost evidence",
    async () => {
      const { meeting, plan, prepare, store } = fixture();
      const base = await prepare.prepare({ currentMeetingId: "current-meeting",
        question: "What did Vlad decide?", roomId: "room-1", scopeId: "scope-1" });
      if (base === null) {
        throw new Error("missing request");
      }
      const locator = plan.documents[0]?.manifest.candidateLocator;
      if (locator === undefined) {
        throw new Error("missing locator");
      }
      const run = async (candidateLocator: string, authorized: HistoricalAuthorizationPort,
        request = base) => await new HistoricalFocusedLocatorRetrievalV2({
          authority: authority(meeting), authorization: authorized, ids: new TestIds(),
          retrieval: { retrieve: async (_request, options) => {
            options?.signal?.throwIfAborted();
            return { candidates: [{ locator: candidateLocator }], status: "available" };
          } },
          store,
          turnHashes: { hash: ({ turnId }) => `hash:${turnId}` },
        }).retrieve({ authorizationPrincipalRef: "principal",
          currentMeetingId: "current-meeting", request, roomId: "room-1",
          scopeId: "scope-1" });

      await expect(run("foreign-locator", authorization())).resolves
        .toMatchObject({ status: "unavailable" });
      store.current = false;
      await expect(run(locator, authorization())).resolves
        .toMatchObject({ status: "unavailable" });
      store.current = true;
      await expect(run(locator, authorization([true, false]))).resolves
        .toMatchObject({ status: "unavailable" });
      await expect(run(locator, authorization(), {
        ...base,
        budgets: { ...base.budgets, evidenceByteLimit: 1 },
      })).resolves.toMatchObject({ status: "unavailable" });
      const controller = new AbortController();
      controller.abort(new Error("cancelled"));
      await expect(new HistoricalFocusedLocatorRetrievalV2({
        authority: authority(meeting), authorization: authorization(), ids: new TestIds(),
        retrieval: { retrieve: async (_request, options) => {
          options?.signal?.throwIfAborted();
          return { candidates: [], status: "available" };
        } }, store, turnHashes: { hash: () => "hash" },
      }).retrieve({ authorizationPrincipalRef: "principal",
        currentMeetingId: "current-meeting", request: base, roomId: "room-1",
        scopeId: "scope-1", signal: controller.signal })).rejects.toThrow("cancelled");
    });
});

async function prepareRequestForComposite() {
  const { prepare } = fixture();
  const request = await prepare.prepare({ currentMeetingId: "current-meeting",
    question: "What changed?", roomId: "room-1", scopeId: "scope-1" });
  if (request === null) {throw new Error("missing composite request");}
  return request;
}

function authority(meeting: ReturnType<typeof makeMeeting>): HistoricalEvidenceAuthority {
  return { loadAcceptedFinalMeeting: async (binding) =>
    binding.releaseId === meeting.binding.releaseId ? meeting : null };
}

function authorization(sequence: boolean[] = [true, true]): HistoricalAuthorizationPort {
  return { authorize: async () => {
    const authorized = sequence.shift() ?? false;
    return { authorizationDigest: "authorization-1", authorizationEpoch: "epoch-1",
      authorized, policyVersion: "room-policy.v1" };
  } };
}
