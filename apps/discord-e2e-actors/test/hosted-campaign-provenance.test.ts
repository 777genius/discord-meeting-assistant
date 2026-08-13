import { describe, expect, it } from "vitest";

import {
  collectHostedCampaignProvenanceAfter,
  collectHostedCampaignProvenanceBefore,
  provenanceBeforeCompletion,
} from "../src/hosted-campaign-provenance.js";

const correlation = {
  campaignId: "campaign-1",
  expectedRevisions: {
    craig: "a".repeat(40), meetingPlatform: "b".repeat(40),
    pipecat: "d".repeat(40), subscriptionRuntime: "c".repeat(40),
  },
  runIds: ["run-1", "run-2", "run-3"] as const,
};

describe("hosted campaign provenance", () => {
  it("collects a revision-qualified baseline and accepts an identical final snapshot", async () => {
    const collector = { collectProvenance: async () => provenance() };
    const baseline = await collectHostedCampaignProvenanceBefore(correlation, collector);
    expect(provenanceBeforeCompletion(baseline)).toMatchObject({
      campaignId: "campaign-1", phase: "before", runIds: correlation.runIds,
    });
    await expect(collectHostedCampaignProvenanceAfter({ ...correlation, baseline }, collector))
      .resolves.toMatchObject({ digestSha256: baseline.digestSha256, phase: "after" });
  });

  it("fails closed when any deployed component changes", async () => {
    const baseline = await collectHostedCampaignProvenanceBefore(correlation, {
      collectProvenance: async () => provenance(),
    });
    const changed = provenance();
    changed.meetingPlatform.containerId = "e".repeat(64);
    await expect(collectHostedCampaignProvenanceAfter({ ...correlation, baseline }, {
      collectProvenance: async () => changed,
    })).rejects.toThrow(/changed during the campaign/u);
  });

  it("rejects mismatched campaign, run, revision, and target correlation", async () => {
    const baseline = await collectHostedCampaignProvenanceBefore(correlation, {
      collectProvenance: async () => provenance(),
    });
    for (const input of [
      { ...correlation, campaignId: "campaign-2" },
      { ...correlation, runIds: ["run-1", "run-2", "other"] as const },
      { ...correlation, expectedRevisions: { ...correlation.expectedRevisions, craig: "f".repeat(40) } },
    ]) {
      await expect(collectHostedCampaignProvenanceAfter({ ...input, baseline }, {
        collectProvenance: async () => provenance(),
      })).rejects.toThrow(/correlation mismatch/u);
    }
    await expect(collectHostedCampaignProvenanceAfter({
      ...correlation, baseline: { ...baseline, target: { ...baseline.target, guildId: "999999999999999999" } },
    }, { collectProvenance: async () => provenance() })).rejects.toThrow();
  });

  it("requires all four exact release-candidate revisions", async () => {
    await expect(collectHostedCampaignProvenanceBefore({
      ...correlation, expectedRevisions: { ...correlation.expectedRevisions, pipecat: "f".repeat(40) },
    }, { collectProvenance: async () => provenance() })).rejects.toThrow(/pipecat provenance does not match/u);
  });
});

function provenance() {
  return {
    craig: service("a"), meetingPlatform: service("b"),
    pipecat: service("d"), subscriptionRuntime: service("c"),
  };
}

function service(seed: string) {
  return {
    composeConfigHash: seed.repeat(64), composeProject: `project-${seed}`, composeService: `service-${seed}`,
    containerId: seed.repeat(64), containerStartedAt: "2026-08-12T09:00:00.000Z",
    imageId: `sha256:${seed.repeat(64)}`, repositoryDigest: `registry.test/image@sha256:${seed.repeat(64)}`,
    sourceRevision: seed.repeat(40),
  };
}
