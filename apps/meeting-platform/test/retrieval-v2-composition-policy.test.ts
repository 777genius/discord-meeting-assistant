import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import * as infinityAdapter from "@discord-meeting/infinity-context-adapter";
import * as meetingKnowledge from "@discord-meeting/meeting-core/meeting-knowledge";

import { createDiscordInfinityActorCustody } from
  "../src/composition/discord-infinity-actor-custody.js";
import { localFinalReplyPolicy, meetingKnowledgeRetrievalProfilePreimages,
  meetingKnowledgeLocalServingEnabled, retrievalProfileFingerprint } from
  "../src/composition/meeting-knowledge.js";
import { createPersistedFocusedMemoryRoute } from
  "../src/composition/meeting-knowledge-retrieval-router.js";
import { historicalActorA, mixedLaneQuestion, platformConfig, roomId, scopeId } from
  "./meeting-knowledge-production-composition-fixtures.js";
import { assertHistoricalSelection } from
  "./meeting-knowledge-production-composition-assertions.js";
import { assertRetrievalRequestPrivacy } from
  "./meeting-knowledge-production-composition-privacy.js";

it("fails closed when configured historical retrieval has no runtime", () => {
    const configured = platformConfig("http://127.0.0.1:1", false, true, "test");
    const config = {
      ...configured,
      meetingKnowledge: {
        ...configured.meetingKnowledge,
        localFinalReply: true as const,
      },
    };

    expect(meetingKnowledgeLocalServingEnabled(config, false)).toBe(false);
    expect(meetingKnowledgeLocalServingEnabled(config, true)).toBe(true);
    const { retrievalV2ProviderBinding: _binding, ...localOnly } =
      config.meetingKnowledge;
    void _binding;
    expect(meetingKnowledgeLocalServingEnabled({
      ...config,
      meetingKnowledge: localOnly,
    }, false)).toBe(true);
});

it("matches provider actor filters to the exact scoped or unscoped intent", () => {
    const actorKeys = [
      `dactor1.synthetic-r0.${"r".repeat(43)}`,
      `dactor1.synthetic-r1.${"a".repeat(43)}`,
    ];
    const retrievalBodies = [
      { filters: { actor_keys: actorKeys }, queries: [{ query: "participant pine-golf" }] },
      { filters: {}, queries: [{ query: "current-anchor pine-golf" }] },
      { filters: { actor_keys: [] }, queries: [{ query: "current-anchor pine-golf" }] },
    ];
    const infinity = {
      endpoint: {
        exactHttpRequests: retrievalBodies.map((body) => ({
          bodyBytes: new TextEncoder().encode(JSON.stringify(body)),
          path: "/v1/context/retrieve",
        })),
        requests: [
          { body: { retrieval_projection: { actor_keys: [actorKeys[1]] } },
            path: "/v1/documents" },
          ...retrievalBodies.map((body) => ({ body, path: "/v1/context/retrieve" })),
        ],
      },
    } as unknown as Parameters<typeof assertRetrievalRequestPrivacy>[0];

    expect(assertRetrievalRequestPrivacy(infinity, 0)).toBe(3);
});

describe("bounded meeting retrieval composition policy", () => {
  it("prints only the closed historical reason when direct selection fails", () => {
    let failure: unknown;
    try {
      assertHistoricalSelection({
        candidateLocator: "must-not-escape-candidate-locator",
        reason: "provider_result_unavailable",
        status: "unavailable",
        text: "must-not-escape-canonical-text",
      } as Parameters<typeof assertHistoricalSelection>[0]);
    } catch (error) {
      failure = error;
    }
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).toContain("provider_result_unavailable");
    expect(message).not.toMatch(/must-not-escape|candidateLocator|canonical-text/u);
  });

  it("binds indexed and explicit local paths under one deterministic epoch", () => {
    expect(localFinalReplyPolicy.retrievalAdmission).toEqual({
      compositeProfileFingerprint: retrievalProfileFingerprint(
        meetingKnowledgeRetrievalProfilePreimages.composite,
      ),
      cutoverEpoch: "composite-retrieval-authority-r3",
      infinityProfileFingerprint: retrievalProfileFingerprint(
        meetingKnowledgeRetrievalProfilePreimages.infinity,
      ),
      localProfileFingerprint: retrievalProfileFingerprint(
        meetingKnowledgeRetrievalProfilePreimages.local,
      ),
    });
    expect(localFinalReplyPolicy.retrievalAdmission.infinityProfileFingerprint)
      .toMatch(/^[a-f0-9]{64}$/u);
    const canonicalCompositePreimage = JSON.stringify({
      candidatePolicy: "bounded-lane-round-robin-dedupe.v1",
      historicalLane: "infinity-context-retrieval-v2-exact-request",
      interleavePolicy: "local-then-historical-per-rank.v1",
      localLane: "canonical-local-exact-lexical-v1", maximumCandidates: 24,
      profileId: "meeting-knowledge.composite-retrieval.v1",
      provenanceVerification: "request-result-lane-accounting.v2", version: 1,
    });
    expect(localFinalReplyPolicy.retrievalAdmission.compositeProfileFingerprint).toBe(
      createHash("sha256").update(canonicalCompositePreimage, "utf8").digest("hex"),
    );
    const canonicalInfinityPreimage = JSON.stringify({
      authoritySnapshot: "repeatable-read-cursor-room-snapshot.v1",
      candidateIsolation: "malformed-candidate-only;batch-overflow-churn-abort",
      contract: "context-retrieval.v2",
      digestCanonicalization: "utf8-lexicographic-json.v1",
      evidenceByteLimit: 16_000, path: "infinity_locator_v2",
      provenance: "exact-request-response-digests-and-lane-accounting.v2",
      rankingPolicy: "weighted_rrf_canonical_preferences.v1", version: 2,
    });
    expect(localFinalReplyPolicy.retrievalAdmission.infinityProfileFingerprint).toBe(
      createHash("sha256").update(canonicalInfinityPreimage, "utf8").digest("hex"),
    );
    expect(localFinalReplyPolicy.retrievalAdmission.localProfileFingerprint).toBe(
      createHash("sha256").update(JSON.stringify({
        algorithm: "nfkc-lowercase-token-exact-match-balanced-speaker-minute.v1",
        candidateLimit: 100,
        digestCanonicalization: "utf8-lexicographic-json.v1",
        evidenceByteLimit: 16_000,
        hardFilters: "sealed-speaker-and-relative-time-overlap.v1",
        path: "canonical_local_exact_lexical_v1",
        profileId: "meeting-knowledge.local-current.v2",
        provenance: "exact-original-question-request-result-digests.v2",
        queryTermPolicy: "temporal-scaffolding-stop-terms.v2",
        resultLimit: 10, version: 2 }),
      "utf8").digest("hex"),
    );
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

  it("keeps the mixed-lane qualification question free of an actor hard filter",
    async () => {
      const custody = createDiscordInfinityActorCustody(
        platformConfig("http://127.0.0.1:1", false, false, "test"),
        "t".repeat(32),
      );
      const request = await new meetingKnowledge.PrepareFocusedLocatorRetrievalV2Request({
        actorReferences: custody.actorReferences,
        ids: custody.historicalIds,
        identitySkeletons: custody.identitySkeletons,
        providerBinding: {
          capabilityFingerprint: "a".repeat(64),
          contractVersion: "context-retrieval.v2",
          indexProfileDigest: "b".repeat(64),
          profileId: "synthetic-mixed-lane-profile",
          rankingPolicy: "weighted_rrf_canonical_preferences.v1",
          requiredProviderLanes: ["postgres_keyword", "qdrant_dense"],
          serviceRevision: "c".repeat(40),
        },
        snapshot: {
          loadRoomAuthoritySnapshot: async () => ({
            entries: [{ plan: { topology: {
              indexGeneration: "synthetic-generation",
              releaseRef: "synthetic-release",
            } } }] as never,
            schemaVersion: 1,
            status: "current",
          }),
        },
        speakerAliases: custody.speakerAliases,
      }).prepare({
        currentMeetingId: "synthetic-current-meeting",
        question: mixedLaneQuestion,
        roomId,
        scopeId,
      });

      expect(request.status).toBe("prepared");
      if (request.status !== "prepared") {
        throw new Error("expected prepared Retrieval V2 request");
      }
      expect(request.filters.actorKeys).toEqual([]);
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
