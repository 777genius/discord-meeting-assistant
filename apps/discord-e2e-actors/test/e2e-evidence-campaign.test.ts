import { describe, expect, it } from "vitest";

import {
  retainedE2eEvidenceSchema,
  verifyE2eCampaign as verifyE2eCampaignAgainstExpectedRevision,
  type DeploymentRevisionExpectation,
  type RetainedE2eEvidence,
  type RetainedVoiceE2eEvidenceV10,
} from "../src/e2e-evidence.js";
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
import { currentV10Campaign } from "./e2e-evidence-v10-fixtures.js";
import {
  exactServiceLevelThresholds,
} from "./e2e-service-level-fixtures.js";

describe("retained E2E campaign lifecycle gate", () => {
  it("rejects missing TTS attestation and cancellation campaign proof", () => {
    const missingAttestation = currentV10Campaign();
    const voice = missingAttestation[2] as RetainedVoiceE2eEvidenceV10;
    const receipt = voice.conversation.lifecycle.playbackReceipts.find(
      ({ speechProvenance }) => speechProvenance !== undefined,
    );
    if (receipt === undefined) {
      throw new Error("TTS receipt fixture is missing");
    }
    delete receipt.ttsAttestation;
    expect(runFailureCodes(verifyCurrentCampaign(missingAttestation)))
      .toContain("GROUNDED_ANSWER_SPEECH_PROVENANCE_INVALID");

    const missingCancellation = currentV10Campaign();
    const cancellationVoice = missingCancellation[2] as RetainedVoiceE2eEvidenceV10;
    cancellationVoice.conversation.lifecycle.groundedAnswers =
      cancellationVoice.conversation.lifecycle.groundedAnswers.filter(
        ({ status }) => status !== "cancelled",
      );
    expect(verifyCurrentCampaign(missingCancellation).failures.map(({ code }) => code))
      .toContain("GROUNDED_CANCELLATION_PROOF_MISSING");
  });

  it("rejects factual PCM retained after grounded cancellation", () => {
    const runs = currentV10Campaign();
    const voice = runs[2] as RetainedVoiceE2eEvidenceV10;
    const cancellation = voice.conversation.lifecycle.groundedAnswers.find(
      ({ status }) => status === "cancelled",
    );
    if (cancellation?.status !== "cancelled") {
      throw new Error("cancellation fixture is missing");
    }
    cancellation.turnId = "human-question-1";
    cancellation.observedAt = "1970-01-01T00:00:03.950Z";
    expect(runFailureCodes(verifyCurrentCampaign(runs)))
      .toContain("GROUNDED_CANCELLATION_PCM_AFTER_CANCEL");
  });

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
        code: "CURRENT_CAMPAIGN_SCHEMA_REQUIRED",
        message: "campaign qualification requires every run to use retained evidence schema v10",
      });
    },
  );

  it("rejects a reconnect campaign whose lifecycle proof is only v7", () => {
    const runs = currentCampaign();
    runs[2] = reidentify(retainedV7Evidence(), "reconnect-v7");

    expect(campaignFailureCodes(runs)).toContain("CURRENT_CAMPAIGN_SCHEMA_REQUIRED");
  });

  it("rejects v8 evidence from a non-reconnect scenario", () => {
    const runs = currentCampaign();
    runs[2]!.actorRun.scenario = "overlap";

    const codes = campaignFailureCodes(runs);

    expect(codes).toEqual(expect.arrayContaining([
      "CURRENT_CAMPAIGN_SCHEMA_REQUIRED",
      "RUN_FAILED",
      "SCENARIO_NOT_PROVEN",
    ]));
  });

  it("rejects v6 sequential and overlap runs plus one v8 reconnect run as obsolete", () => {
    expect(campaignFailureCodes(currentCampaign())).toContain("CURRENT_CAMPAIGN_SCHEMA_REQUIRED");
  });

  it("accepts three release-bound V10 runs with one current voice qualification", () => {
    const runs = currentV10Campaign();

    const result = verifyCurrentCampaign(runs);

    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("uses retained governed V10 thresholds without an external verifier file", () => {
    const result = verifyCurrentCampaign(currentV10Campaign());
    expect(runFailureCodes(result)).not.toContain("SLA_THRESHOLDS_MISSING");
  });

  it("rejects missing prepared-farewell asset or widened cue latency evidence", () => {
    const missingAsset = currentV10Campaign();
    const missingVoice = missingAsset[2] as RetainedVoiceE2eEvidenceV10;
    const farewellStarted = missingVoice.conversation.lifecycle.playbackReceipts.find(
      ({ status, turnId }) => status === "started" && turnId === "meeting-farewell:v1",
    );
    if (farewellStarted === undefined) {
      throw new Error("farewell start fixture is missing");
    }
    delete farewellStarted.preparedAssetSha256;
    expect(runFailureCodes(verifyCurrentCampaign(missingAsset)))
      .toContain("FAREWELL_PREPARED_CUE_PROVENANCE_MISSING");

    const slowCue = currentV10Campaign();
    const slowVoice = slowCue[2] as RetainedVoiceE2eEvidenceV10;
    const slowStart = slowVoice.conversation.lifecycle.playbackReceipts.find(
      ({ status, turnId }) => status === "started" && turnId === "meeting-farewell:v1",
    );
    if (slowStart?.status !== "started") {
      throw new Error("farewell start fixture is missing");
    }
    slowStart.playbackStartedAtEpochMs = 5_000;
    expect(runFailureCodes(verifyCurrentCampaign(slowCue)))
      .toContain("FAREWELL_PREPARED_CUE_LATENCY_EXCEEDED");
  });

  it("rejects a grounded answer citation or TTS provenance not retained from the active turn", () => {
    const runs = currentV10Campaign();
    const voice = runs[2] as RetainedVoiceE2eEvidenceV10;
    const grounded = voice.conversation.lifecycle.groundedAnswers.find(
      ({ status }) => status === "validated",
    );
    if (grounded?.status !== "validated") {
      throw new Error("grounded answer fixture is missing");
    }
    grounded.citationTurnIds[0] = "missing-turn";
    expect(runFailureCodes(verifyCurrentCampaign(runs)))
      .toContain("GROUNDED_ANSWER_PROVENANCE_INVALID");
  });

  it.each([
    ["campaign proof", (evidence: Record<string, unknown>) => {
      delete (evidence.conversation as Record<string, unknown>).campaignProof;
    }],
    ["SLA proof", (evidence: Record<string, unknown>) => {
      delete evidence.serviceLevels;
    }],
  ])("rejects V10 reconnect evidence with missing %s at the schema boundary", (
    _description,
    removeProof,
  ) => {
    const evidence = currentV10Campaign()[2] as unknown as Record<string, unknown>;
    removeProof(evidence);

    expect(retainedE2eEvidenceSchema.safeParse(evidence).success).toBe(false);
  });

  it("rejects a V10 reconnect run with a tampered campaign proof", () => {
    const runs = currentV10Campaign();
    const reconnect = runs[2] as RetainedVoiceE2eEvidenceV10;
    reconnect.conversation.campaignProof.planDigestSha256 = "0".repeat(64);

    const result = verifyCurrentCampaign(runs);

    expect(runFailureCodes(result)).toContain("VOICE_CAMPAIGN_PROOF_INVALID");
    expect(result.failures.map(({ code }) => code)).toContain("RUN_FAILED");
  });

  it("rejects a V10 reconnect run with tampered SLA evidence", () => {
    const runs = currentV10Campaign();
    const reconnect = runs[2] as RetainedVoiceE2eEvidenceV10;
    reconnect.serviceLevels.measurements[0]!.upperBoundMs += 1;

    const result = verifyCurrentCampaign(runs);

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
    const runs = currentV10Campaign();
    const overlap = runs[1]!;
    const reconnect = runs[2]!;
    reconnect.publication.messageId = overlap.publication.messageId;
    reconnect.replay.messageId = overlap.replay.messageId;

    expect(campaignFailureCodes(runs)).toContain("CAMPAIGN_STATE_LEAK");
  });

  it("still rejects deployment drift across the v6 to v8 schema boundary", () => {
    const runs = currentV10Campaign();
    runs[2]!.deployment.meetingPlatform.imageId = `sha256:${"f".repeat(64)}`;

    expect(campaignFailureCodes(runs)).toContain("CAMPAIGN_DEPLOYMENT_CHANGED");
  });

  it("still rejects runs retained from an older release candidate", () => {
    const runs = currentV10Campaign();
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
