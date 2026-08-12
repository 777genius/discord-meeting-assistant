import { describe, expect, it } from "vitest";

import { parseCampaignArguments } from "../src/verify-campaign.js";

describe("verify-campaign CLI arguments", () => {
  it("accepts the standard pnpm run separator without treating it as a path", () => {
    expect(parseCampaignArguments([
      "--",
      "manifest.json",
      "sequential.json",
      "overlap.json",
      "reconnect.json",
    ])).toEqual({
      evidencePaths: ["sequential.json", "overlap.json", "reconnect.json"],
      manifestPath: "manifest.json",
    });
  });

  it("still accepts direct node invocation without a separator", () => {
    expect(parseCampaignArguments([
      "manifest.json",
      "sequential.json",
      "overlap.json",
      "reconnect.json",
    ]).manifestPath).toBe("manifest.json");
  });

  it("accepts externally supplied service-level thresholds after all evidence", () => {
    expect(parseCampaignArguments([
      "--",
      "manifest.json",
      "sequential.json",
      "overlap.json",
      "reconnect.json",
      "--service-level-thresholds",
      "thresholds.json",
    ])).toEqual({
      evidencePaths: ["sequential.json", "overlap.json", "reconnect.json"],
      manifestPath: "manifest.json",
      thresholdsPath: "thresholds.json",
    });
  });

  it.each([
    ["a missing thresholds path", ["manifest.json", "a.json", "b.json", "c.json", "--service-level-thresholds"]],
    ["a thresholds flag before evidence", [
      "manifest.json",
      "--service-level-thresholds",
      "thresholds.json",
      "a.json",
      "b.json",
      "c.json",
    ]],
  ])("rejects %s", (_description, arguments_) => {
    expect(() => parseCampaignArguments(arguments_)).toThrow("Service-level thresholds");
  });
});
