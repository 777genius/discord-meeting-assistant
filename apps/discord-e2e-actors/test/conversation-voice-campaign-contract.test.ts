import { describe, expect, it } from "vitest";

import {
  assertConversationVoiceCampaignPlan,
  assertConversationVoiceCampaignTarget,
  conversationVoiceCampaignEvidenceIssue,
  conversationVoiceCampaignLifecycleIssue,
  conversationVoiceCampaignPreflight,
  conversationVoiceCampaignRoles,
  selectConversationVoiceCampaignLifecycle,
} from "../src/conversation-voice-campaign-contract.js";
import {
  conversationVoiceCampaignPlanDigest,
  conversationVoiceCampaignProofIssue,
  conversationVoiceCampaignProofV1Schema,
} from "../src/conversation-voice-campaign-proof.js";

describe("conversation voice campaign contract", () => {
  it("requires the pinned private Discord target", () => {
    const pinnedTarget = {
      craigBotId: "1534231284467896512",
      guildId: "1533228590643155034",
      observerApplicationId: "1533867700575670282",
      voiceChannelId: "1533228823045214398",
    };
    expect(() => {
      assertConversationVoiceCampaignTarget(pinnedTarget);
    }).not.toThrow();
    expect(() => {
      assertConversationVoiceCampaignTarget({
        ...pinnedTarget,
        observerApplicationId: "1534999999999999999",
      });
    }).toThrow("pinned Botik, observer, guild, and voice channel");
  });

  it("prints the exact safe six-capture plan", () => {
    const plan = canonicalPlan();

    expect(conversationVoiceCampaignPreflight(plan)).toEqual({
      captures: conversationVoiceCampaignRoles.map((role, index) => ({
        ...(role.correlationSource === "handshake" ? {} : { attemptId: `attempt-${index + 1}` }),
        correlation: role.correlationSource === "handshake"
          ? { source: "handshake", value: "/evidence/addressed-answer-handshake" }
          : { source: "literal", value: role.turnId },
        expectedDuration: expectedDuration(index),
        ordinal: index + 1,
        outputPath: `/evidence/capture-${index + 1}.json`,
        purpose: role.purpose,
        role: role.role,
      })),
      kind: "conversation-voice-campaign-preflight",
      status: "validated",
    });
  });

  it("rejects extra, farewell-before-answer, and greeting-after-answer plans", () => {
    expect(() => {
      assertConversationVoiceCampaignPlan([
        ...canonicalPlan(),
        canonicalPlan()[5]!,
      ]);
    }).toThrow("expected exactly 6 captures");
    expect(() => {
      assertConversationVoiceCampaignPlan([
        ...canonicalPlan().slice(0, 4),
        canonicalPlan()[5]!,
        canonicalPlan()[4]!,
      ]);
    }).toThrow("capture 5 must be speaker-d-addressed-answer");
    expect(() => {
      assertConversationVoiceCampaignPlan([
        ...canonicalPlan().slice(0, 4),
        canonicalPlan()[4]!,
        canonicalPlan()[3]!,
      ]);
    }).toThrow("capture 6 must be explicit-group-farewell");
  });

  it("rejects semantic or chronological retained-evidence drift", () => {
    const evidence = canonicalEvidence();
    expect(conversationVoiceCampaignEvidenceIssue(evidence)).toBeUndefined();
    expect(conversationVoiceCampaignEvidenceIssue([...evidence, evidence[5]!]))
      .toContain("exactly 6 captures");
    const farewellBeforeAnswer = [...evidence];
    [farewellBeforeAnswer[4], farewellBeforeAnswer[5]] =
      [farewellBeforeAnswer[5]!, farewellBeforeAnswer[4]!];
    expect(conversationVoiceCampaignEvidenceIssue(farewellBeforeAnswer))
      .toContain("capture 5 must be speaker-d-addressed-answer");
    const overlapping = structuredClone(evidence);
    overlapping[4]!.capture.firstPacketAt.epochMilliseconds =
      overlapping[3]!.capture.endedAt.epochMilliseconds;
    expect(conversationVoiceCampaignEvidenceIssue(overlapping))
      .toContain("capture 5 must start after capture 4 ends");
    const tooShort = structuredClone(evidence);
    tooShort[2]!.capture.acceptedDurationMilliseconds = 999;
    expect(conversationVoiceCampaignEvidenceIssue(tooShort))
      .toContain("capture 3 duration must be within its retained minimum and maximum");
  });

  it.each([
    ["before", 0],
    ["between", 1],
    ["after", 6],
  ] as const)("filters an unrelated lifecycle event %s campaign events", (_position, index) => {
    const captures = canonicalEvidence();
    const events = canonicalLifecycleEvents();
    const unrelated = {
      greetingLocale: "ru" as const,
      observedAt: "1970-01-01T00:00:00.250Z",
      participantId: "unrelated-participant",
      participantNameStatus: "unknown" as const,
      turnId: "participant-greeting:unrelated-participant",
      type: "greeting" as const,
    };
    const rawEvents = [...events];
    rawEvents.splice(index, 0, unrelated);

    expect(selectConversationVoiceCampaignLifecycle(captures, rawEvents)).toEqual({ events });
    expect(conversationVoiceCampaignLifecycleIssue(captures, rawEvents, 100)).toBeUndefined();
  });

  it("retains duplicate correlated lifecycle events so the campaign fails closed", () => {
    const captures = canonicalEvidence();
    const events = canonicalLifecycleEvents();

    expect(conversationVoiceCampaignLifecycleIssue(
      captures,
      [events[0]!, { ...events[0]!, observedAt: "1970-01-01T00:00:00.200Z" }, ...events.slice(1)],
      100,
    )).toContain("expected exactly 6 lifecycle events");
  });

  it("fails closed when one lifecycle event ambiguously matches multiple captures", () => {
    const captures = canonicalEvidence();
    captures[1]!.correlation.turnId = captures[0]!.correlation.turnId;
    const events = canonicalLifecycleEvents();

    expect(conversationVoiceCampaignLifecycleIssue(captures, events, 100))
      .toContain("ambiguously matches multiple captures");
  });

  it("binds the exact campaign plan, observer target, and actor run", () => {
    const plan = campaignProofPlan();
    const planDigestSha256 = conversationVoiceCampaignPlanDigest(plan);
    const proof = conversationVoiceCampaignProofV1Schema.parse({
      observerReadyReceipt: {
        authenticatedObserverBotId: "1533867700575670282",
        observedAt: "2026-08-12T10:00:00.000Z",
        planDigestSha256,
        runId: "campaign-1",
        schemaVersion: 1,
        target: {
          craigBotId: "1534231284467896512",
          guildId: "1533228590643155034",
          observerApplicationId: "1533867700575670282",
          voiceChannelId: "1533228823045214398",
        },
      },
      plan,
      planDigestSha256,
      schemaVersion: 1,
    });

    expect(conversationVoiceCampaignProofIssue(proof, "campaign-1")).toBeUndefined();
    expect(conversationVoiceCampaignProofIssue({
      ...proof,
      observerReadyReceipt: { ...proof.observerReadyReceipt, runId: "other-run" },
    }, "campaign-1")).toContain("retained actor run");
    expect(conversationVoiceCampaignProofIssue({
      ...proof,
      planDigestSha256: "0".repeat(64),
    }, "campaign-1")).toContain("computed plan digest");
    expect(conversationVoiceCampaignProofIssue({
      ...proof,
      observerReadyReceipt: {
        ...proof.observerReadyReceipt,
        target: { ...proof.observerReadyReceipt.target, voiceChannelId: "wrong-channel" },
      },
    }, "campaign-1")).toContain("pinned private-test target");
  });
});

function campaignProofPlan() {
  return {
    captures: conversationVoiceCampaignRoles.map((role, index) => ({
      resolvedAttemptId: `attempt-${index + 1}`,
      expectedDuration: { maximumMilliseconds: 1_500, minimumMilliseconds: 1_000 },
      ordinal: index + 1,
      outputPath: `/evidence/capture-${index + 1}.json`,
      purpose: role.purpose,
      role: role.role,
      resolvedTurnId: role.turnId ?? "runtime-addressed-answer-turn",
    })),
    kind: "conversation-voice-campaign-preflight" as const,
    status: "validated" as const,
  };
}

function canonicalPlan() {
  return conversationVoiceCampaignRoles.map((role, index) => ({
    expectedDuration: expectedDuration(index),
    outputPath: `/evidence/capture-${index + 1}.json`,
    purpose: role.purpose,
    ...(role.correlationSource === "handshake"
      ? { playbackHandshakeRoot: "/evidence/addressed-answer-handshake" }
      : { attemptId: `attempt-${index + 1}`, turnId: role.turnId }),
  }));
}

function canonicalEvidence() {
  return conversationVoiceCampaignRoles.map((role, index) => ({
    capture: {
      acceptedDurationMilliseconds: 1_000,
      endedAt: { epochMilliseconds: index * 1_000 + 500 },
      expectedDuration: expectedDuration(index),
      firstPacketAt: { epochMilliseconds: index * 1_000 + 100 },
    },
    correlation: {
      purpose: role.purpose,
      turnId: role.turnId ?? "runtime-answer-turn",
    },
  }));
}

function expectedDuration(index: number) {
  return {
    maximumMilliseconds: 1_500 + index * 100,
    minimumMilliseconds: 1_000,
  };
}

function canonicalLifecycleEvents() {
  const identities = {
    observer: "1533867700575670282",
    speakerD: "1533873978417086474",
    speakerEn: "1533228054724346087",
    speakerRu: "1533227577286852649",
  };
  return [
    greeting(identities.observer, "ru", "unknown", 150),
    greeting(identities.speakerRu, "ru", "known", 1_150),
    greeting(identities.speakerEn, "en", "known", 2_150),
    greeting(identities.speakerD, "ru", "unknown", 3_150),
    {
      observedAt: new Date(4_050).toISOString(),
      participantId: identities.speakerD,
      turnId: "runtime-answer-turn",
      type: "addressed-answer" as const,
    },
    {
      observedAt: new Date(5_150).toISOString(),
      turnId: "meeting-farewell:v1",
      type: "farewell" as const,
    },
  ];
}

function greeting(
  participantId: string,
  greetingLocale: "en" | "ru",
  participantNameStatus: "known" | "unknown",
  observedAt: number,
) {
  return {
    greetingLocale,
    observedAt: new Date(observedAt).toISOString(),
    participantId,
    participantNameStatus,
    turnId: `participant-greeting:${participantId}`,
    type: "greeting" as const,
  };
}
