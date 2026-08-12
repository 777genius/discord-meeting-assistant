import { describe, expect, it } from "vitest";

import {
  retainedE2eEvidenceSchema,
  retainedE2eEvidenceV9Schema,
  type RetainedE2eEvidenceV9,
  verifyRetainedE2eEvidence,
} from "../src/e2e-evidence.js";
import { conversationVoiceCampaignPlanDigest } from
  "../src/conversation-voice-campaign-proof.js";
import {
  currentExpectedRevisions,
  manifest,
  retainedV8Evidence,
} from "./e2e-evidence-fixtures.js";
import {
  exactServiceLevelThresholds,
  serviceLevelsProof,
} from "./e2e-service-level-fixtures.js";

const pinnedTarget = {
  craigBotId: "1534231284467896512",
  guildId: "1533228590643155034",
  observerApplicationId: "1533867700575670282",
  voiceChannelId: "1533228823045214398",
} as const;

describe("retained conversation V9 campaign proof verification", () => {
  it("accepts a V9 run whose campaign proof binds its plan, target, and actor run", () => {
    const result = verify(v9Evidence());

    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("rejects a tampered retained plan digest", () => {
    const evidence = v9Evidence();
    evidence.conversation.campaignProof.planDigestSha256 = "0".repeat(64);

    expect(failureCodes(evidence)).toContain("VOICE_CAMPAIGN_PROOF_INVALID");
  });

  it("rejects a campaign receipt bound to another actor run", () => {
    const evidence = v9Evidence();
    evidence.conversation.campaignProof.observerReadyReceipt.runId = "other-run";

    expect(failureCodes(evidence)).toContain("VOICE_CAMPAIGN_PROOF_INVALID");
  });

  it("rejects a campaign receipt bound to another target", () => {
    const evidence = v9Evidence();
    evidence.conversation.campaignProof.observerReadyReceipt.target.voiceChannelId =
      "wrong-channel";

    expect(failureCodes(evidence)).toContain("VOICE_CAMPAIGN_PROOF_INVALID");
  });

  it("rejects a re-digested plan whose resolved capture no longer matches its role", () => {
    const evidence = v9Evidence();
    const proof = evidence.conversation.campaignProof;
    proof.plan.captures[0]!.resolvedTurnId = "participant-greeting:other-observer";
    const digest = conversationVoiceCampaignPlanDigest(proof.plan);
    proof.planDigestSha256 = digest;
    proof.observerReadyReceipt.planDigestSha256 = digest;

    expect(failureCodes(evidence)).toContain("VOICE_CAMPAIGN_PROOF_INVALID");
  });

  it.each([
    ["attempt ID", (evidence: RetainedE2eEvidenceV9) => {
      evidence.conversation.campaignProof.plan.captures[2]!.resolvedAttemptId = "other-attempt";
    }],
    ["turn ID", (evidence: RetainedE2eEvidenceV9) => {
      evidence.conversation.campaignProof.plan.captures[4]!.resolvedTurnId = "other-turn";
    }],
    ["purpose", (evidence: RetainedE2eEvidenceV9) => {
      evidence.conversation.campaignProof.plan.captures[2]!.purpose = "farewell";
    }],
    ["minimum expected duration", (evidence: RetainedE2eEvidenceV9) => {
      evidence.conversation.campaignProof.plan.captures[3]!.expectedDuration.minimumMilliseconds += 1;
    }],
    ["maximum expected duration", (evidence: RetainedE2eEvidenceV9) => {
      evidence.conversation.campaignProof.plan.captures[3]!.expectedDuration.maximumMilliseconds += 1;
    }],
    ["ordinal", (evidence: RetainedE2eEvidenceV9) => {
      evidence.conversation.campaignProof.plan.captures[1]!.ordinal = 6;
    }],
    ["role", (evidence: RetainedE2eEvidenceV9) => {
      evidence.conversation.campaignProof.plan.captures[1]!.role = "observer-unknown";
    }],
    ["capture order", (evidence: RetainedE2eEvidenceV9) => {
      const captures = evidence.conversation.campaignProof.plan.captures;
      [captures[0], captures[1]] = [captures[1]!, captures[0]!];
    }],
  ] as const)("rejects a re-digested plan with a mutated %s", (_field, mutate) => {
    const evidence = v9Evidence();
    mutate(evidence);
    redigestCampaignProof(evidence);

    expect(failureCodes(evidence)).toContain("VOICE_CAMPAIGN_PROOF_INVALID");
  });

  it("keeps historical V8 readable, valid, and untouched by the V9 gate", () => {
    const evidence = retainedV8Evidence();
    const beforeVerification = structuredClone(evidence);
    const parsed = retainedE2eEvidenceSchema.parse(evidence);
    const result = verifyRetainedE2eEvidence(
      manifest(),
      parsed,
      currentExpectedRevisions,
    );

    expect(parsed.schemaVersion).toBe(8);
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(evidence).toEqual(beforeVerification);
  });
});

function v9Evidence(): RetainedE2eEvidenceV9 {
  const source = retainedV8Evidence();
  const captures = source.conversation.voice.map((voice, index) => ({
    expectedDuration: voice.capture.expectedDuration,
    ordinal: index + 1,
    outputPath: `/evidence/capture-${index + 1}.json`,
    purpose: voice.correlation.purpose,
    resolvedAttemptId: voice.correlation.attemptId,
    resolvedTurnId: voice.correlation.turnId,
    role: [
      "observer-unknown",
      "speaker-ru-known",
      "speaker-en-known",
      "speaker-d-unknown",
      "speaker-d-addressed-answer",
      "explicit-group-farewell",
    ][index]!,
  }));
  const plan = {
    captures,
    kind: "conversation-voice-campaign-preflight" as const,
    status: "validated" as const,
  };
  const planDigestSha256 = conversationVoiceCampaignPlanDigest(plan);

  return retainedE2eEvidenceV9Schema.parse({
    ...source,
    conversation: {
      ...source.conversation,
      campaignProof: {
        observerReadyReceipt: {
          authenticatedObserverBotId: pinnedTarget.observerApplicationId,
          observedAt: "2026-08-12T10:00:00.000Z",
          planDigestSha256,
          runId: source.actorRun.runId,
          schemaVersion: 1,
          target: pinnedTarget,
        },
        plan,
        planDigestSha256,
        schemaVersion: 1,
      },
    },
    schemaVersion: 9,
    serviceLevels: serviceLevelsProof(),
  });
}

function verify(evidence: RetainedE2eEvidenceV9) {
  return verifyRetainedE2eEvidence(
    manifest(),
    evidence,
    currentExpectedRevisions,
    exactServiceLevelThresholds,
  );
}

function redigestCampaignProof(evidence: RetainedE2eEvidenceV9): void {
  const proof = evidence.conversation.campaignProof;
  const digest = conversationVoiceCampaignPlanDigest(proof.plan);
  proof.planDigestSha256 = digest;
  proof.observerReadyReceipt.planDigestSha256 = digest;
}

function failureCodes(evidence: RetainedE2eEvidenceV9): readonly string[] {
  return verify(evidence).failures.map(({ code }) => code);
}
