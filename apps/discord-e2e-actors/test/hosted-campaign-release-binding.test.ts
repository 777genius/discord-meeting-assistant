import { describe, expect, it } from "vitest";

import {
  createHostedCampaignReleaseConfig,
  digestHostedCampaignReleaseTrustRootV1,
  hostedCampaignReleaseBindingV1Schema,
  hostedCampaignReleaseTrustRootV1Schema,
} from "../src/hosted-campaign-release-binding.js";

const services = [
  ["craig", "craig-meeting-e2e", "bot", "a"],
  ["meetingPlatform", "discord-meeting-assistant", "meeting-platform", "b"],
  ["pipecat", "discord-meeting-assistant", "pipecat-runtime", "c"],
  ["subscriptionRuntime", "discord-meeting-assistant", "subscription-runtime-sidecar", "d"],
] as const;
const endpoint = { batch: { origin: "https://voicetext.test", path: "/batch" },
  live: { origin: "wss://voicetext.test", path: "/live" } } as const;
const trust = hostedCampaignReleaseTrustRootV1Schema.parse({
  allowedNetworks: ["discord-meeting-e2e"],
  canary: { endpoint, fixturePath: "/app/fixtures/canary.ogg", fixtureSha256: "f".repeat(64),
    maximumCharacterErrorRate: 0.2, maximumTimelineDeltaMs: 3_500, maximumWordErrorRate: 0.35,
    requiredTerms: ["botik"] },
  clockMaximumSkewMs: 250, deployRoot: "/srv/e2e", discordReceiptTtlMs: 30_000,
  environmentFile: "/srv/e2e/source.env", host: "codex-workers-eu-01",
  remoteComposeFile: "/srv/e2e/source/compose.yaml", schemaVersion: 1,
  secretDirectory: "/run/secrets/discord-e2e",
  services: services.map(([component, composeProject, composeService, digit]) => ({
    component, composeProject, composeService, imageId: `sha256:${digit.repeat(64)}`,
    repositoryDigest: `registry.test/${component}@sha256:${digit.repeat(64)}`, sourceRevision: digit.repeat(40),
  })),
  sourceRoot: "/srv/e2e/source", voicetextReceiptTtlMs: 30_000, voicetextTimeoutMs: 60_000,
});
const release = {
  canary: { endpoint, expectedSegments: [{ endMs: 1_000, startMs: 0, text: "hello botik" }],
    fixturePath: "/app/fixtures/canary.ogg", fixtureSha256: "f".repeat(64), requiredTerms: ["botik"] },
  releaseId: "release-1", schemaVersion: 1,
  services: trust.services.map((entry, index) => ({ ...entry, containerId: String(index + 1).repeat(64) })),
  trustRootSha256: digestHostedCampaignReleaseTrustRootV1(trust),
} as const;
const campaign = {
  bindings: {}, campaignId: "campaign-1",
  definition: { campaignRoot: "/srv/e2e/campaigns", remote: { composeFile: trust.remoteComposeFile,
    environmentFile: trust.environmentFile, sourceRoot: trust.sourceRoot },
  revisions: { craig: "a".repeat(40), meetingPlatform: "b".repeat(40), pipecat: "c".repeat(40), subscriptionRuntime: "d".repeat(40) },
  runIds: ["run-1", "run-2", "run-3"], secretDirectory: trust.secretDirectory },
  meetingPlatformRevision: "b".repeat(40), plan: {}, planSha256: "9".repeat(64),
} as const;

describe("hosted campaign release binding", () => {
  it("requires one exact service identity for every release component", () => {
    expect(() => hostedCampaignReleaseBindingV1Schema.parse({ ...release,
      services: [release.services[0], release.services[0], release.services[2], release.services[3]] }))
      .toThrow("each service exactly once");
  });

  it("does not let operator release data self-authorize a different digest", () => {
    const changed = { ...release, services: release.services.map((entry, index) => index === 1
      ? { ...entry, repositoryDigest: `registry.test/meetingPlatform@sha256:${"e".repeat(64)}` }
      : entry) };
    expect(() => createHostedCampaignReleaseConfig(changed, trust, campaign)).toThrow("not allowed");
  });

  it("assembles host-side wiring after the exact release matches the trust root", () => {
    expect(createHostedCampaignReleaseConfig(release, trust, campaign)).toMatchObject({
      campaignId: campaign.campaignId,
      meetingPlatformRevision: campaign.meetingPlatformRevision,
      planSha256: campaign.planSha256,
    });
  });

  it("binds operator declaration to the exact compiled trust root digest", () => {
    expect(() => createHostedCampaignReleaseConfig({ ...release, trustRootSha256: "0".repeat(64) }, trust, campaign))
      .toThrow("does not select the compiled trust root");
  });
});
