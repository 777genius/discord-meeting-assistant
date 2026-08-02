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
});
