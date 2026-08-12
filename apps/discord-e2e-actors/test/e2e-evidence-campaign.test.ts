import { describe, expect, it } from "vitest";

import {
  retainedE2eEvidenceSchema,
  retainedE2eEvidenceV9Schema,
  verifyE2eCampaign as verifyE2eCampaignAgainstExpectedRevision,
  type DeploymentRevisionExpectation,
  type RetainedE2eEvidence,
  type RetainedE2eEvidenceV9,
} from "../src/e2e-evidence.js";
import { conversationVoiceCampaignPlanDigest } from
  "../src/conversation-voice-campaign-proof.js";
import {
  currentExpectedRevisions,
  directMessageEvidence,
  expectedRevisions,
  manifest,
  overlapEvidence,
  reidentify,
  reconnectEvidence,
  retainedV4Evidence,
  retainedV5Evidence,
  retainedV6Evidence,
  retainedV7Evidence,
  retainedV8Evidence,
  sequentialEvidence,
} from "./e2e-evidence-fixtures.js";
import {
  exactServiceLevelThresholds,
  serviceLevelsProof,
} from "./e2e-service-level-fixtures.js";

describe("retained E2E campaign lifecycle gate", () => {
  it.each([2, 3, 4, 5, 6] as const)(
    "rejects a legacy v%s sequential, overlap, and reconnect campaign",
    (schemaVersion) => {
      const runs = legacyCampaign(schemaVersion);
      const result = verifyE2eCampaignAgainstExpectedRevision(
        manifest(),
        runs,
        expectedRevisionsFor(schemaVersion),
      );

      expect(result.passed).toBe(false);
      expect(result.failures).toContainEqual({
        code: "LIFECYCLE_V8_NOT_PROVEN",
        message: "campaign requires retained evidence v8 from a reconnect run",
      });
    },
  );

  it("rejects a reconnect campaign whose lifecycle proof is only v7", () => {
    const runs = currentCampaign();
    runs[2] = reidentify(retainedV7Evidence(), "reconnect-v7");

    expect(campaignFailureCodes(runs)).toContain("LIFECYCLE_V8_NOT_PROVEN");
  });

  it("rejects v8 evidence from a non-reconnect scenario", () => {
    const runs = currentCampaign();
    runs[2]!.actorRun.scenario = "overlap";

    const codes = campaignFailureCodes(runs);

    expect(codes).toEqual(expect.arrayContaining([
      "LIFECYCLE_V8_NOT_PROVEN",
      "RUN_FAILED",
      "SCENARIO_NOT_PROVEN",
    ]));
  });

  it("accepts v6 sequential and overlap runs plus one v8 reconnect run", () => {
    expect(verifyCurrentCampaign(currentCampaign()).failures).toEqual([]);
  });

  it("accepts v6 sequential and overlap runs plus one valid v9 reconnect run", () => {
    const runs = currentV9Campaign();

    const result = verifyCurrentCampaign(runs, exactServiceLevelThresholds);

    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("rejects a v9 reconnect run when externally supplied SLA thresholds are missing", () => {
    const result = verifyCurrentCampaign(currentV9Campaign());

    expect(runFailureCodes(result)).toContain("SLA_THRESHOLDS_MISSING");
    expect(result.failures.map(({ code }) => code)).toContain("RUN_FAILED");
  });

  it.each([
    ["campaign proof", (evidence: Record<string, unknown>) => {
      delete (evidence.conversation as Record<string, unknown>).campaignProof;
    }],
    ["SLA proof", (evidence: Record<string, unknown>) => {
      delete evidence.serviceLevels;
    }],
  ])("rejects v9 reconnect evidence with missing %s at the schema boundary", (
    _description,
    removeProof,
  ) => {
    const evidence = v9ReconnectEvidence() as unknown as Record<string, unknown>;
    removeProof(evidence);

    expect(retainedE2eEvidenceSchema.safeParse(evidence).success).toBe(false);
  });

  it("rejects a v9 reconnect run with a tampered campaign proof", () => {
    const runs = currentV9Campaign();
    const reconnect = runs[2] as RetainedE2eEvidenceV9;
    reconnect.conversation.campaignProof.planDigestSha256 = "0".repeat(64);

    const result = verifyCurrentCampaign(runs, exactServiceLevelThresholds);

    expect(runFailureCodes(result)).toContain("VOICE_CAMPAIGN_PROOF_INVALID");
    expect(result.failures.map(({ code }) => code)).toContain("RUN_FAILED");
  });

  it("rejects a v9 reconnect run with tampered SLA evidence", () => {
    const runs = currentV9Campaign();
    const reconnect = runs[2] as RetainedE2eEvidenceV9;
    reconnect.serviceLevels.measurements[0]!.upperBoundMs += 1;

    const result = verifyCurrentCampaign(runs, exactServiceLevelThresholds);

    expect(runFailureCodes(result)).toContain("SLA_UPPER_BOUND_TAMPERED");
    expect(result.failures.map(({ code }) => code)).toContain("RUN_FAILED");
  });

  it("rejects v5 sequential and overlap runs even with a valid v8 reconnect run", () => {
    const runs = [
      reidentify(retainedV5Evidence(sequentialEvidence()), "sequential-v5"),
      reidentify(retainedV5Evidence(overlapEvidence()), "overlap-v5"),
      reidentify(retainedV8Evidence(), "reconnect-v8"),
    ];

    const result = verifyCurrentCampaign(runs);

    expect(result.failures.filter(({ code }) => code === "SCENARIO_SCHEMA_TOO_OLD"))
      .toHaveLength(2);
    expect(Object.values(result.runResults).every(({ passed }) => passed)).toBe(true);
  });

  it("still rejects shared state across mixed-schema campaign runs", () => {
    const runs = currentCampaign();
    const overlap = runs[1]!;
    const reconnect = runs[2]!;
    reconnect.publication.messageId = overlap.publication.messageId;
    reconnect.replay.messageId = overlap.replay.messageId;

    expect(campaignFailureCodes(runs)).toContain("CAMPAIGN_STATE_LEAK");
  });

  it("still rejects deployment drift across the v6 to v8 schema boundary", () => {
    const runs = currentCampaign();
    runs[2]!.deployment.meetingPlatform.imageId = `sha256:${"f".repeat(64)}`;

    expect(campaignFailureCodes(runs)).toContain("CAMPAIGN_DEPLOYMENT_CHANGED");
  });

  it("still rejects runs retained from an older release candidate", () => {
    const runs = currentCampaign();
    for (const run of runs) {
      run.deployment.meetingPlatform.sourceRevision = "d".repeat(40);
    }

    const releaseRunFailureCodes = Object.values(verifyCurrentCampaign(runs).runResults)
      .flatMap(({ failures }) => failures.map(({ code }) => code));

    expect(releaseRunFailureCodes).toContain("DEPLOYMENT_SOURCE_REVISION_MISMATCH");
  });
});

function legacyCampaign(schemaVersion: 2 | 3 | 4 | 5 | 6 = 6): RetainedE2eEvidence[] {
  const makeEvidence = historicalEvidenceFactory(schemaVersion);
  return [
    reidentify(makeEvidence(sequentialEvidence()), `sequential-v${schemaVersion}`),
    reidentify(makeEvidence(overlapEvidence()), `overlap-v${schemaVersion}`),
    reidentify(makeEvidence(reconnectEvidence()), `reconnect-v${schemaVersion}`),
  ];
}

function historicalEvidenceFactory(schemaVersion: 2 | 3 | 4 | 5 | 6) {
  switch (schemaVersion) {
    case 2:
      return (evidence: ReturnType<typeof overlapEvidence>) => evidence;
    case 3:
      return directMessageEvidence;
    case 4:
      return retainedV4Evidence;
    case 5:
      return retainedV5Evidence;
    case 6:
      return retainedV6Evidence;
  }
}

function expectedRevisionsFor(
  schemaVersion: 2 | 3 | 4 | 5 | 6,
): DeploymentRevisionExpectation {
  if (schemaVersion >= 5) {
    return currentExpectedRevisions;
  }
  if (schemaVersion === 4) {
    return { ...expectedRevisions, subscriptionRuntime: currentExpectedRevisions.subscriptionRuntime };
  }
  return expectedRevisions;
}

function currentCampaign(): RetainedE2eEvidence[] {
  const [sequential, overlap] = legacyCampaign();
  return [
    sequential!,
    overlap!,
    reidentify(retainedV8Evidence(), "reconnect-v8"),
  ];
}

function currentV9Campaign(): RetainedE2eEvidence[] {
  const runs = currentCampaign();
  runs[2] = v9ReconnectEvidence();
  return runs;
}

function v9ReconnectEvidence(): RetainedE2eEvidenceV9 {
  const source = reidentify(retainedV8Evidence(), "reconnect-v9");
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
          authenticatedObserverBotId: "1533867700575670282",
          observedAt: "2026-08-12T10:00:00.000Z",
          planDigestSha256,
          runId: source.actorRun.runId,
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
      },
    },
    schemaVersion: 9,
    serviceLevels: serviceLevelsProof(),
  });
}

function verifyCurrentCampaign(
  runs: RetainedE2eEvidence[],
  thresholds?: typeof exactServiceLevelThresholds,
) {
  return verifyE2eCampaignAgainstExpectedRevision(
    manifest(),
    runs,
    currentExpectedRevisions,
    thresholds,
  );
}

function campaignFailureCodes(runs: RetainedE2eEvidence[]) {
  return verifyCurrentCampaign(runs).failures.map(({ code }) => code);
}

function runFailureCodes(result: ReturnType<typeof verifyCurrentCampaign>) {
  return Object.values(result.runResults)
    .flatMap(({ failures }) => failures.map(({ code }) => code));
}
