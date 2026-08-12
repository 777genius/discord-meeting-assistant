import { describe, expect, it } from "vitest";

import {
  type HostedCampaignEntrypoint,
  type HostedCampaignExecutableSpec,
} from "../src/hosted-campaign-coordinator.js";
import {
  HOSTED_CAMPAIGN_ENTRYPOINT_CAPABILITY_MATRIX,
  validateHostedCampaignEntrypointCapabilities,
} from "../src/hosted-campaign-entrypoint-capabilities.js";

const produced = (kind: "campaign-verified" | "observer-subscribed") => ({
  action: { kind }, ordinal: 3, outputPath: `/evidence/${kind}.json`, runId: "run-3",
} as const);

function child(
  entrypoint: HostedCampaignEntrypoint,
  produces: HostedCampaignExecutableSpec["produces"] = [],
): HostedCampaignExecutableSpec {
  return {
    arguments: { kind: "environment" }, childId: "child", entrypoint,
    environment: {}, produces, requires: [], startBefore: { kind: "campaign" },
  };
}

describe("hosted campaign entrypoint capability matrix", () => {
  it("classifies every production entrypoint and rejects arbitrary production declarations", () => {
    expect(Object.keys(HOSTED_CAMPAIGN_ENTRYPOINT_CAPABILITY_MATRIX).toSorted()).toEqual([
      "actor", "campaign-verifier", "collector", "conversation-observer", "evidence-verifier",
      "live-observer", "playback-link-observer", "provenance-probe", "recording-ready",
      "service-levels", "supplemental-player",
    ]);
    expect(() => validateHostedCampaignEntrypointCapabilities(
      child("conversation-observer", [produced("observer-subscribed")]),
    )).not.toThrow();
    for (const entrypoint of Object.keys(HOSTED_CAMPAIGN_ENTRYPOINT_CAPABILITY_MATRIX) as HostedCampaignEntrypoint[]) {
      if (entrypoint === "conversation-observer") {continue;}
      expect(() => validateHostedCampaignEntrypointCapabilities(
        child(entrypoint, [produced("observer-subscribed")]),
      )).toThrow(new RegExp(`entrypoint ${entrypoint} cannot produce observer-subscribed`, "u"));
    }
  });

  it("rejects completion-only actions without their exact completion declaration", () => {
    expect(() => validateHostedCampaignEntrypointCapabilities(
      child("campaign-verifier", [produced("campaign-verified")]),
    )).toThrow(/cannot produce campaign-verified/u);
    expect(() => validateHostedCampaignEntrypointCapabilities(
      child("not-production" as HostedCampaignEntrypoint),
    )).toThrow(/Unsupported hosted campaign entrypoint/u);
  });
});
