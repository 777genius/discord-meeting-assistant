import { describe, expect, it } from "vitest";

import {
  assertConversationVoiceCampaignPlan,
  assertConversationVoiceCampaignTarget,
  conversationVoiceCampaignEvidenceIssue,
  conversationVoiceCampaignPreflight,
  conversationVoiceCampaignRoles,
} from "../src/conversation-voice-campaign-contract.js";

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
        attemptId: `attempt-${index + 1}`,
        correlation: role.turnIdSource === "file"
          ? { source: "file", value: "/evidence/addressed-answer.turn-id" }
          : { source: "literal", value: role.turnId },
        expectedDuration: { maximumMilliseconds: 1_500, minimumMilliseconds: 1_000 },
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
});

function canonicalPlan() {
  return conversationVoiceCampaignRoles.map((role, index) => ({
    attemptId: `attempt-${index + 1}`,
    expectedDuration: { maximumMilliseconds: 1_500, minimumMilliseconds: 1_000 },
    outputPath: `/evidence/capture-${index + 1}.json`,
    purpose: role.purpose,
    ...(role.turnIdSource === "file"
      ? { turnIdFile: "/evidence/addressed-answer.turn-id" }
      : { turnId: role.turnId }),
  }));
}

function canonicalEvidence() {
  return conversationVoiceCampaignRoles.map((role, index) => ({
    capture: {
      acceptedDurationMilliseconds: 1_000,
      endedAt: { epochMilliseconds: index * 1_000 + 500 },
      expectedDuration: { maximumMilliseconds: 1_500, minimumMilliseconds: 1_000 },
      firstPacketAt: { epochMilliseconds: index * 1_000 + 100 },
    },
    correlation: {
      purpose: role.purpose,
      turnId: role.turnId ?? "runtime-answer-turn",
    },
  }));
}
