import { describe, expect, it } from "vitest";

import { buildResolvedHostedCampaignPlanV1 } from "../src/hosted-campaign-plan-builder.js";
import {
  createHostedCampaignProductionComposition,
  HostedCampaignProductionCompositionError,
} from "../src/hosted-campaign-production-composition.js";

const definition = {
  answerFirstPacketMilliseconds: 4_000,
  campaignId: "campaign-1",
  campaignRoot: "/private/evidence/campaigns",
  clockPreflightPath: "/private/evidence/clock-preflight.json",
  fixtureManifestPath: "/private/evidence/fixture-manifest.json",
  recordingPlaybackOrigin: "https://recordings.test.example",
  remote: {
    composeFile: "/srv/discord-meeting/compose.yaml",
    environmentFile: "/srv/discord-meeting/source.env",
    sourceRoot: "/srv/discord-meeting/source",
  },
  revisions: {
    craig: "a".repeat(40), meetingPlatform: "b".repeat(40),
    pipecat: "c".repeat(40), subscriptionRuntime: "d".repeat(40),
  },
  runIds: ["run-1", "run-2", "run-3"],
  schemaVersion: 1,
  secretDirectory: "/run/secrets/discord-e2e",
  speakerFixtures: { a: "/private/evidence/speaker-a.ogg", b: "/private/evidence/speaker-b.ogg" },
  serviceLevelThresholdsPath: "/private/evidence/service-level-thresholds.json",
  supplementalManifestPath: "/private/evidence/supplemental-manifest.json",
} as const;
const bindings = {
  runs: [
    { remoteAttestationPath: "/tmp/discord-e2e-attestations/run-1.json" },
    { remoteAttestationPath: "/tmp/discord-e2e-attestations/run-2.json" },
    { remoteAttestationPath: "/tmp/discord-e2e-attestations/run-3.json" },
  ], schemaVersion: 1,
} as const;
const plan = buildResolvedHostedCampaignPlanV1(definition, bindings);

describe("hosted campaign production composition", () => {
  it("exposes the exact release reference selected by its trusted policy", () => {
    const releaseReference = {
      releaseBindingSha256: "1".repeat(64), releaseId: "release-1", trustRootSha256: "2".repeat(64),
    } as const;
    const production = createHostedCampaignProductionComposition({
      kind: "hosted-campaign-production-policy", releaseReference, schemaVersion: 1,
      trustBinding: { createConfig: () => { throw new Error("probe not requested"); } },
    });
    expect(production.releaseReference).toEqual(releaseReference);
  });

  it("fails closed with one typed stable reason when the reviewed release trust binding is absent", () => {
    const production = createHostedCampaignProductionComposition();
    expect(() => production.assertReadyForRun()).toThrow("RELEASE_BINDING_REQUIRED");
    expect(() => production.createInitialAdmissionProbe({ bindings, definition, plan }))
      .toThrow("RELEASE_BINDING_REQUIRED");
  });

  it("rejects an incomplete custom policy before any candidate or probe is needed", () => {
    const production = createHostedCampaignProductionComposition({
      kind: "hosted-campaign-production-policy", schemaVersion: 1,
      trustBinding: { createConfig: () => { throw new Error("remote probe must not be created"); } },
    });

    expect(() => production.assertReadyForRun()).toThrow("RELEASE_BINDING_REQUIRED");
  });

  it("does not accept operator candidate fields as a substitute for the static trust root", () => {
    const production = createHostedCampaignProductionComposition();
    const operatorAuthored = {
      ...definition,
      productionTrustBinding: { imageDigestSha256: "f".repeat(64), trusted: true },
    };
    expect(() => production.createInitialAdmissionProbe({
      bindings, definition: operatorAuthored, plan,
    })).toThrow();
  });

  it("checks deadline headroom before attempting the post-lease full probe", async () => {
    const production = createHostedCampaignProductionComposition(undefined, () => 10_000);
    await expect(production.authorizeFreshAdmission({
      bindings, deadlineEpochMs: 14_999, definition, minimumHeadroomMs: 5_000,
      plan, signal: new AbortController().signal,
    })).rejects.toMatchObject({
      reason: "INSUFFICIENT_LAUNCH_HEADROOM",
    } satisfies Partial<HostedCampaignProductionCompositionError>);
  });

  it("propagates an already aborted signal before touching external work", async () => {
    const controller = new AbortController();
    const reason = new Error("operator interrupted campaign");
    controller.abort(reason);
    const production = createHostedCampaignProductionComposition(undefined, () => 10_000);
    await expect(production.authorizeFreshAdmission({
      bindings, deadlineEpochMs: 20_000, definition, minimumHeadroomMs: 5_000,
      plan, signal: controller.signal,
    })).rejects.toBe(reason);
  });
});
