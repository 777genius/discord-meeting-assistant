import { describe, expect, it } from "vitest";

import { HOSTED_CAMPAIGN_TARGET } from "../src/hosted-campaign-target.js";
import {
  observePrivateCampaignCoverage,
  PRIVATE_CAMPAIGN_SCENARIOS,
  privateCampaignCoverageQualificationV1Schema,
  type PrivateCampaignCoverageQualificationV1,
} from "../src/private-campaign-coverage-qualification.js";

const runId = "run-3";
const baseTime = Date.parse("2026-08-25T10:00:00.000Z");
const at = (offset: number) => new Date(baseTime + offset).toISOString();
const admitted = new Set([
  "supported-summary-ru-canonical-alias", "supported-transcript-en-no-name",
  "supported-transcript-mixed", "unsupported-grounded-abstention",
  "duplicate-gateway-question-event", "crash-before-provider-send",
  "crash-after-provider-response", "crash-after-discord-create",
  "ambiguous-provider-outcome",
]);
const supported = new Set([
  "supported-summary-ru-canonical-alias", "supported-transcript-en-no-name",
  "supported-transcript-mixed",
]);

function proof(): PrivateCampaignCoverageQualificationV1 {
  const questionScenarios = PRIVATE_CAMPAIGN_SCENARIOS.map((scenario, index) => {
    const isAdmitted = admitted.has(scenario);
    const answerMessageId = isAdmitted ? `${930_000_000_000_000_000n + BigInt(index)}` : null;
    const rejectionReason = scenario === "stale-replaced-projection" ? "projection_replaced"
      : scenario === "deleted-projection" ? "projection_deleted"
        : scenario === "deleted-question" ? "question_deleted"
          : scenario === "authorization-loss-after-admission" ? "authorization_lost"
            : scenario === "discord-permission-loss-after-admission" ? "discord_permission_lost"
              : null;
    const recovery = scenario.startsWith("crash-") || scenario === "ambiguous-provider-outcome";
    return {
      abstained: scenario === "unsupported-grounded-abstention",
      admitted: isAdmitted,
      citations: supported.has(scenario) ? ["turn-ru"] : [],
      duplicateIngressCount: scenario === "duplicate-gateway-question-event" ? 2 : 1,
      identity: {
        actorId: HOSTED_CAMPAIGN_TARGET.observerApplicationId,
        effectId: `effect-${index + 1}`,
        generation: 7,
        questionId: `${920_000_000_000_000_000n + BigInt(index)}`,
        runId,
        scenarioId: scenario,
      },
      locale: scenario.includes("-ru-") ? "ru" : scenario.includes("mixed") ? "mixed" : "en",
      participantReference: scenario.includes("canonical-alias")
        ? "canonical-real-name-alias" : "none",
      policyFence: {
        authorizationEpochAtAdmission: 4,
        authorizationEpochAtEffect: scenario === "authorization-loss-after-admission" ? 5 : 4,
        discordPermissionEpochAtAdmission: 9,
        discordPermissionEpochAtEffect: scenario === "discord-permission-loss-after-admission" ? 10 : 9,
      },
      projection: scenario.includes("summary") ? "final-summary" : "transcript-projection",
      projectionIdentity: {
        admittedGeneration: 7,
        messageId: `${910_000_000_000_000_000n + BigInt(index)}`,
        observedGeneration: scenario === "stale-replaced-projection" ? 8 : 7,
        stateAtEffect: scenario === "stale-replaced-projection" ? "replaced"
          : scenario === "deleted-projection" ? "deleted" : "current",
      },
      questionStateAtEffect: scenario === "deleted-question" ? "deleted" : "current",
      receipt: {
        answerMessageId,
        attemptId: `attempt-${index + 1}`,
        effectId: `effect-${index + 1}`,
        effectState: isAdmitted ? "delivered" : "absent",
        externalReceipt: answerMessageId,
        generation: 7,
        jobId: `job-${index + 1}`,
        observedAt: at(20_000 + index),
        providerRequestCount: isAdmitted ? 1 : 0,
        providerResponseCount: isAdmitted ? 1 : 0,
        publicationCreateCount: isAdmitted ? 1 : 0,
        reconciliationCount: recovery ? 1 : 0,
      },
      recovery: recovery ? {
        crashedWorkerId: `worker-before-${index}`,
        injectionId: `${scenario}:${920_000_000_000_000_000n + BigInt(index)}`,
        replacementWorkerId: `worker-after-${index}`,
        stage: scenario === "crash-before-provider-send" ? "before-provider-send"
          : scenario === "crash-after-provider-response"
            ? "after-provider-response-before-reservation"
            : scenario === "crash-after-discord-create"
              ? "after-discord-create-before-completion" : "provider-outcome-unknown",
      } : null,
      rejectionReason,
      scenario,
      sourceGeneration: 7,
      transcriptTurnIds: supported.has(scenario) ? ["turn-ru"] : [],
    };
  });
  return privateCampaignCoverageQualificationV1Schema.parse({
    campaignId: "campaign-1",
    governedSurfaces: [
      { answerCreateCount: admitted.size, channelId: HOSTED_CAMPAIGN_TARGET.publicationChannelId,
        guildId: HOSTED_CAMPAIGN_TARGET.guildId, kind: "governed-target",
        parentChannelId: HOSTED_CAMPAIGN_TARGET.publicationChannelId },
      { answerCreateCount: 0, channelId: "930000000000000101",
        guildId: HOSTED_CAMPAIGN_TARGET.guildId, kind: "private-guild-other-channel",
        parentChannelId: "930000000000000101" },
      { answerCreateCount: 0, channelId: "930000000000000102",
        guildId: HOSTED_CAMPAIGN_TARGET.guildId, kind: "private-guild-thread",
        parentChannelId: HOSTED_CAMPAIGN_TARGET.publicationChannelId },
      { answerCreateCount: 0, channelId: "930000000000000103",
        guildId: HOSTED_CAMPAIGN_TARGET.guildId, kind: "wrong-scope",
        parentChannelId: "930000000000000103" },
    ],
    evidenceSources: {
      discordObservationSha256: "1".repeat(64), durableStateSha256: "2".repeat(64),
      gatewayEventSha256: "3".repeat(64), liveMemoryStateSha256: "4".repeat(64),
      providerAttemptSha256: "5".repeat(64),
    },
    kind: "discord-private-campaign-coverage-qualification",
    meetingId: "meeting-1",
    liveMemory: {
      bargeIn: { answerEffectId: "voice-effect-1", cancelledAt: at(9_000),
        citedTurnIds: ["live-ru"], latePlaybackPacketCount: 0, questionId: "voice-question-1",
        usedGroundedAnswerUseCase: true },
      botActorId: HOSTED_CAMPAIGN_TARGET.botikApplicationId,
      botTurnIdsExcluded: ["bot-turn-1"],
      finalHistoricalGeneration: { generatedAt: at(12_000), generation: 8,
        transcriptId: "transcript-1", turnIds: ["live-ru", "live-en", "live-mixed", "live-ru-correction"] },
      finalizedTurns: [
        liveTurn("live-ru", "ru", 1_000, null), liveTurn("live-en", "en", 2_000, null),
        liveTurn("live-mixed", "mixed", 3_000, null),
        liveTurn("live-ru-correction", "ru", 4_000, "live-ru"),
      ],
      interimTurnIdsExcluded: ["interim-1"],
      postFinalization: { ephemeralGeneration: 7, ephemeralServingCount: 0,
        reconciledAt: at(13_000), remoteDocumentCount: 0, state: "superseded" },
      runId,
    },
    observerActorId: HOSTED_CAMPAIGN_TARGET.observerApplicationId,
    privateTestGuildId: HOSTED_CAMPAIGN_TARGET.guildId,
    qualification: { externalProvidersExecuted: true, officialBotApplicationsOnly: true,
      productionEvidence: true, providerFreeStructural: false, publicOrUserGuild: false },
    release: { releaseBindingSha256: "6".repeat(64), releaseId: "release-1",
      trustRootSha256: "7".repeat(64) },
    questionScenarios,
    schemaVersion: 1,
    simultaneousGreetings: {
      cohortId: "cohort-1",
      dispatches: [
        greeting(HOSTED_CAMPAIGN_TARGET.speakerAApplicationId, 1, 100),
        greeting(HOSTED_CAMPAIGN_TARGET.speakerBApplicationId, 2, 150),
      ],
      observationEndedAt: at(2_000), observationStartedAt: at(0),
      reconnectGreetingCount: 0, runId,
    },
    surfaceInventory: { activeThreadsComplete: true, allPrivateTestGuildChannelsEnumerated: true,
      archivedThreadsComplete: true, endedAt: at(30_000), startedAt: at(0) },
    sutActorId: HOSTED_CAMPAIGN_TARGET.sutApplicationId,
  });
}

function liveTurn(turnId: string, locale: "en" | "mixed" | "ru", offset: number,
  supersedesTurnId: string | null) {
  return { acceptedAt: at(offset), availableAt: at(offset + 500), canonicalRowCount: 1,
    generation: 7, identityGeneration: 7, ingressEventCount: turnId === "live-en" ? 2 : 1,
    interim: false, locale, source: "human-final",
    speakerId: HOSTED_CAMPAIGN_TARGET.speakerAApplicationId, supersedesTurnId, turnId };
}

function greeting(actorId: string, joinOrdinal: number, offset: number) {
  return { actorId, firstAudioAt: at(offset + 500), firstJoinAt: at(offset),
    greetingEffectId: `greeting-${joinOrdinal}`, greetingReceiptCount: 1, joinOrdinal };
}

describe("private Discord campaign coverage qualification", () => {
  it("accepts the complete externally observed scenario matrix", async () => {
    const value = proof();
    expect(privateCampaignCoverageQualificationV1Schema.parse(value).questionScenarios)
      .toHaveLength(PRIVATE_CAMPAIGN_SCENARIOS.length);
    await expect(observePrivateCampaignCoverage({ observe: async () => value }))
      .resolves.toMatchObject({ campaignId: "campaign-1", schemaVersion: 1 });
  });

  it.each([
    ["reordered scenario", (value: PrivateCampaignCoverageQualificationV1) => value.questionScenarios.reverse()],
    ["duplicate question identity", (value: PrivateCampaignCoverageQualificationV1) => {
      value.questionScenarios[1]!.identity.questionId = value.questionScenarios[0]!.identity.questionId;
    }],
    ["blind provider repeat", (value: PrivateCampaignCoverageQualificationV1) => {
      value.questionScenarios.at(-1)!.receipt.providerRequestCount = 2;
    }],
    ["duplicate Discord create", (value: PrivateCampaignCoverageQualificationV1) => {
      value.questionScenarios[0]!.receipt.publicationCreateCount = 2;
    }],
    ["off-scope Botik answer", (value: PrivateCampaignCoverageQualificationV1) => {
      value.governedSurfaces[1]!.answerCreateCount = 1;
    }],
    ["unsupported citation", (value: PrivateCampaignCoverageQualificationV1) => {
      value.questionScenarios[3]!.citations = ["turn-ru"];
    }],
    ["stale projection provider send", (value: PrivateCampaignCoverageQualificationV1) => {
      value.questionScenarios[4]!.receipt.providerRequestCount = 1;
    }],
    ["live turn slower than five seconds", (value: PrivateCampaignCoverageQualificationV1) => {
      value.liveMemory.finalizedTurns[0]!.availableAt = at(7_000);
    }],
    ["missing correction", (value: PrivateCampaignCoverageQualificationV1) => {
      value.liveMemory.finalizedTurns[3]!.supersedesTurnId = null;
    }],
    ["ephemeral generation still serving", (value: PrivateCampaignCoverageQualificationV1) => {
      Reflect.set(value.liveMemory.postFinalization, "ephemeralServingCount", 1);
    }],
    ["late simultaneous greeting", (value: PrivateCampaignCoverageQualificationV1) => {
      value.simultaneousGreetings.dispatches[0]!.firstAudioAt = at(2_000);
    }],
    ["provider-free fabrication", (value: PrivateCampaignCoverageQualificationV1) => {
      Reflect.set(value.qualification, "providerFreeStructural", true);
      Reflect.set(value.qualification, "productionEvidence", false);
    }],
  ])("fails closed for %s", (_name, mutate) => {
    const value = structuredClone(proof());
    mutate(value);
    expect(privateCampaignCoverageQualificationV1Schema.safeParse(value).success).toBe(false);
  });

  it.each(PRIVATE_CAMPAIGN_SCENARIOS)(
    "rejects a cross-generation %s receipt",
    (scenario) => {
      const value = structuredClone(proof());
      const retained = value.questionScenarios.find(
        (candidate: { scenario: string }) => candidate.scenario === scenario,
      );
      if (retained === undefined) { throw new Error(`Missing scenario ${scenario}`); }
      retained.receipt.generation += 1;
      expect(privateCampaignCoverageQualificationV1Schema.safeParse(value).success).toBe(false);
    },
  );
});
