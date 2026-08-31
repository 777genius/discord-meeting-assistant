import { describe, expect, it, vi } from "vitest";
import { HistoricalFocusedLocatorRetrievalV2, PrepareFocusedLocatorRetrievalV2Request,
  buildHistoricalIndexPlan,
  type FocusedLocatorRetrievalV2Port,
  type HistoricalAuthorizationPort,
  type HistoricalOpaqueIdPort,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { AppliedStore, TestIds, makeMeeting } from
  "../../fixtures/historical-retrieval-fixtures.js";
import { authority, authorization, expectPrepared, fixture, identitySkeletons, markerTurn,
  providerBinding, providerCandidate } from "./focused-locator-retrieval-v2.fixture.test.js";

describe("persisted focused locator Retrieval V2 request", () => {
  it("distinguishes a proven room with no historical index from runtime failure",
    async () => {
      await expect(new PrepareFocusedLocatorRetrievalV2Request({
        ids: new TestIds(), providerBinding, store: new AppliedStore([]),
      }).prepare({ currentMeetingId: "current-meeting", question: "What changed?",
        roomId: "room-1", scopeId: "scope-1" })).resolves.toEqual({
          reason: "no_history_or_index",
          status: "empty",
        });
    });

  it("fails closed when source enumeration changes across the bounded admission snapshot",
    async () => {
      const firstMeeting = makeMeeting({ meetingId: "source-a", turns: markerTurn("a") });
      const first = { binding: firstMeeting.binding,
        plan: buildHistoricalIndexPlan(firstMeeting, new TestIds()), remoteDocumentIds: {} };
      const store = new AppliedStore([first]);
      vi.spyOn(store, "loadRoomAuthoritySnapshot").mockResolvedValue({
        schemaVersion: 1, status: "unavailable",
      });

      await expect(new PrepareFocusedLocatorRetrievalV2Request({
        ids: new TestIds(), providerBinding, store,
      }).prepare({ currentMeetingId: "current-meeting", question: "What changed?",
        roomId: "room-1", scopeId: "scope-1" })).resolves.toMatchObject({
          status: "unavailable",
        });
    });

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
    expectPrepared(request);

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
        expectPrepared(request);
        expect(request?.filters.sourceGenerations).toHaveLength(100);
      } else {
        expect(request.status).toBe("unavailable");
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
    const store = new AppliedStore([records[0]!, records[2]!]);

    const request = await new PrepareFocusedLocatorRetrievalV2Request({
      ids: new TestIds(), providerBinding, store,
    }).prepare({ currentMeetingId: current.binding.meetingId,
      question: "What changed?", roomId: "room-1", scopeId: "scope-1" });
    expectPrepared(request);

    expect(request?.filters.sourceGenerations).toHaveLength(2);
    expect(request?.filters.sourceGenerations).toEqual(expect.arrayContaining([
      records[0]!.plan,
      records[2]!.plan,
    ].map(({ topology }) => ({
      projectionGeneration: topology.indexGeneration,
      sourceKey: topology.releaseRef,
    }))));
  });

  it("aborts the whole admission when the authority snapshot batch fails", async () => {
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
    vi.spyOn(store, "loadRoomAuthoritySnapshot")
      .mockRejectedValue(new Error("source authority unavailable"));

    await expect(new PrepareFocusedLocatorRetrievalV2Request({
      ids: new TestIds(), providerBinding, store,
    }).prepare({ currentMeetingId: first.binding.meetingId,
      question: "What changed?", roomId: "room-1", scopeId: "scope-1" }))
      .rejects.toThrow("source authority unavailable");
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
      expectPrepared(request);
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
        candidateLimit: 100,
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
    expectPrepared(request);

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
      expectPrepared(request);

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
      expectPrepared(request);

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

    expect(request.status).toBe("unavailable");
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

      expect(request.status).toBe("unavailable");
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

    expect(request.status).toBe("unavailable");
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

    expect(request.status).toBe("unavailable");
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

    expect(request.status).toBe("unavailable");
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
      expectPrepared(request);

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
      expectPrepared(request);

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

    expect(request.status).toBe("unavailable");
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

      expect(request.status).toBe("unavailable");
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
    expectPrepared(request);

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
    })).resolves.toMatchObject({ status: "unavailable" });
    expect(list).not.toHaveBeenCalled();
  });

  it("rechecks serving authority immediately before provider I/O", async () => {
    const { meeting, plan, prepare, store } = fixture();
    const request = await prepare.prepare({ currentMeetingId: "current-meeting",
      question: "What did Vlad decide?", roomId: "room-1", scopeId: "scope-1" });
    expectPrepared(request);
    const locator = plan.documents[0]?.manifest.candidateLocator;
    if (request === null || locator === undefined) {
      throw new Error("missing guarded retrieval fixture");
    }
    const retrieve = vi.fn<FocusedLocatorRetrievalV2Port["retrieve"]>(async () => ({
      candidates: [providerCandidate(locator, request)], status: "available",
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
  it("attaches exact verified retrieval audit to focused voice canonical turns",
    async () => {
      const { plan, prepare, store } = fixture();
      const request = await prepare.prepare({ currentMeetingId: "current-meeting",
        question: "What did Vlad decide?", roomId: "room-1", scopeId: "scope-1" });
      expectPrepared(request);
      const locator = plan.documents[0]?.manifest.candidateLocator;
      if (request === null || locator === undefined) {throw new Error("missing voice fixture");}
      const result = await new HistoricalFocusedLocatorRetrievalV2({
        actorKeysForSpeaker: (speakerId) => [speakerId],
        authorization: authorization(), ids: new TestIds(),
        retrieval: { retrieve: async () => ({
          candidates: [providerCandidate(locator, request)], status: "available",
        }) }, store, turnHashes: { hash: ({ turnId }) => `hash:${turnId}` },
      }).retrieveEvidence({ authorizationPrincipalRef: "principal",
        currentMeetingId: "current-meeting", request, roomId: "room-1",
        scopeId: "scope-1" });

      expect(result).toMatchObject({ status: "current" });
      if (result.status === "current") {
        expect(result.turns[0]?.retrievalAudit).toMatchObject({
          laneIdentity: {
            capabilityFingerprint: request.binding.capabilityFingerprint,
            lane: "historical",
            profileId: request.binding.profileId,
          },
          locator,
        });
      }
    });

  it("reapplies speaker and relative-time filters to multilingual canonical turns", async () => {
    const meeting = makeMeeting({ meetingId: "filtered-historical", turns: [{
      endMs: 11_000, speakerId: "opaque-vlad", startMs: 10_000,
      text: "Влад подтвердил ранний запуск", turnId: "turn-vlad-early" }, {
      endMs: 13_000, speakerId: "opaque-anna", startMs: 12_000,
      text: "Anna discussed an unrelated early budget", turnId: "turn-anna-early" }, {
      endMs: 501_000, speakerId: "opaque-vlad", startMs: 500_000,
      text: "Vlad changed a later detail", turnId: "turn-vlad-late",
    }] });
    const plan = buildHistoricalIndexPlan(meeting, new TestIds()), store = new AppliedStore([{ binding: meeting.binding, plan, remoteDocumentIds: {} }], [meeting]);
    const prepared = await new PrepareFocusedLocatorRetrievalV2Request({
      ids: new TestIds(), providerBinding, store }).prepare({
      currentMeetingId: "current-meeting", question: "launch budget",
      roomId: "room-1", scopeId: "scope-1" });
    expectPrepared(prepared);
    const locator = plan.documents[0]?.manifest.candidateLocator; if (locator === undefined) {throw new Error("missing filter fixture");}
    const request = Object.freeze({ ...prepared, filters: Object.freeze({
      ...prepared.filters,
      actorKeys: Object.freeze(["opaque-vlad"]),
      relativeTimeInterval: Object.freeze({ endMs: 100_000, startMs: 0 }),
    }) });
    const result = await new HistoricalFocusedLocatorRetrievalV2({
      actorKeysForSpeaker: (speakerId) => [speakerId],
      authority: authority(meeting), authorization: authorization(), ids: new TestIds(),
      retrieval: { retrieve: async () => ({
        candidates: [providerCandidate(locator, request)], status: "available",
      }) }, store, turnHashes: { hash: ({ turnId }) => `hash:${turnId}` },
    }).retrieve({ authorizationPrincipalRef: "principal", currentMeetingId: "current-meeting",
      request, roomId: "room-1", scopeId: "scope-1" });
    expect(result.status === "current"
      ? result.candidates.map(({ turnId }) => turnId) : [])
      .toEqual(["turn-vlad-early"]);
  });

  it("returns only canonical local references in provider order", async () => {
    const { meeting, plan, prepare, store } = fixture();
    const request = await prepare.prepare({ currentMeetingId: "current-meeting",
      question: "Что Влад решил?", roomId: "room-1", scopeId: "scope-1" });
    expectPrepared(request);
    const locator = plan.documents[0]?.manifest.candidateLocator;
    if (locator === undefined) {throw new Error("missing locator");}
    const retrieval: FocusedLocatorRetrievalV2Port = {
      retrieve: vi.fn().mockResolvedValue({
        candidates: [providerCandidate(locator, request)], status: "available" }),
    };
    const useCase = new HistoricalFocusedLocatorRetrievalV2({
      authority: authority(meeting), authorization: authorization(), ids: new TestIds(),
      actorKeysForSpeaker: (speakerId) => speakerId === "opaque-vlad"
        ? ["opaque-vlad"] : [],
      retrieval, store, turnHashes: { hash: ({ turnId }) => `hash:${turnId}` },
    });
    const result = await useCase.retrieve({ authorizationPrincipalRef: "principal",
      currentMeetingId: "current-meeting", request, roomId: "room-1",
      scopeId: "scope-1" });
    expect(result).toMatchObject({ status: "current" });
    if (result.status !== "current") {throw new Error("retrieval failed");}
    expect(result.candidates).toEqual([expect.objectContaining({
      meetingId: meeting.binding.meetingId,
      transcriptId: meeting.binding.transcriptId,
      turnHash: "hash:turn-vlad",
      turnId: "turn-vlad",
    })]);
    expect(JSON.stringify(result)).not.toMatch(/approved|Tuesday/u);
    expect({ batch: store.candidateBatchReads, point: store.candidatePointReads,
      snapshots: store.snapshotReads }).toEqual({ batch: 0, point: 0, snapshots: 2 });
  });

  it.each([["meetingId", "provider-owned-meeting"], ["turnId", "provider-owned-turn"],
    ["text", "remote transcript text"]])(
    "rejects extra provider candidate field %s", async (field, value) => {
    const { meeting, plan, prepare, store } = fixture();
    const request = await prepare.prepare({ currentMeetingId: "current-meeting",
      question: "What did Vlad decide?", roomId: "room-1", scopeId: "scope-1" });
    expectPrepared(request);
    const locator = plan.documents[0]?.manifest.candidateLocator;
    if (request === null || locator === undefined) {
      throw new Error("missing Retrieval V2 fixture");}
    const result = await new HistoricalFocusedLocatorRetrievalV2({
      authority: authority(meeting), authorization: authorization(), ids: new TestIds(),
      retrieval: { retrieve: async () => ({
        candidates: [{ ...providerCandidate(locator, request), [field]: value }],
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
    expectPrepared(request);
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
        candidates: [providerCandidate(locator, request)],
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
      expectPrepared(base);
      const locator = plan.documents[0]?.manifest.candidateLocator;
      if (locator === undefined) {
        throw new Error("missing locator");
      }
      const run = async (candidateLocator: string, authorized: HistoricalAuthorizationPort,
        request = base) => await new HistoricalFocusedLocatorRetrievalV2({
          authority: authority(meeting), authorization: authorized, ids: new TestIds(),
          retrieval: { retrieve: async (_request, options) => {
            options?.signal?.throwIfAborted();
            return { candidates: [providerCandidate(candidateLocator, request)], status: "available" };
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
