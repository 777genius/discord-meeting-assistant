import { describe, expect, it } from "vitest";

import {
  verifyE2eCampaign as verifyE2eCampaignAgainstExpectedRevision,
  type DeploymentRevisionExpectation,
  type RetainedE2eEvidence,
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

    const runFailureCodes = Object.values(verifyCurrentCampaign(runs).runResults)
      .flatMap(({ failures }) => failures.map(({ code }) => code));

    expect(runFailureCodes).toContain("DEPLOYMENT_SOURCE_REVISION_MISMATCH");
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

function verifyCurrentCampaign(runs: RetainedE2eEvidence[]) {
  return verifyE2eCampaignAgainstExpectedRevision(manifest(), runs, currentExpectedRevisions);
}

function campaignFailureCodes(runs: RetainedE2eEvidence[]) {
  return verifyCurrentCampaign(runs).failures.map(({ code }) => code);
}
