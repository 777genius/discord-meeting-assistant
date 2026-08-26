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
      "--thin-remediation",
      "thin.json",
    ])).toEqual({
      evidencePaths: ["sequential.json", "overlap.json", "reconnect.json"],
      manifestPath: "manifest.json",
      thinRemediationPath: "thin.json",
    });
  });

  it("still accepts direct node invocation without a separator", () => {
    expect(parseCampaignArguments([
      "manifest.json",
      "sequential.json",
      "overlap.json",
      "reconnect.json",
      "--thin-remediation",
      "thin.json",
    ]).manifestPath).toBe("manifest.json");
  });

  it("accepts externally supplied service-level thresholds after all evidence", () => {
    expect(parseCampaignArguments([
      "--",
      "manifest.json",
      "sequential.json",
      "overlap.json",
      "reconnect.json",
      "--thin-remediation",
      "thin.json",
      "--service-level-thresholds",
      "thresholds.json",
    ])).toEqual({
      evidencePaths: ["sequential.json", "overlap.json", "reconnect.json"],
      manifestPath: "manifest.json",
      thinRemediationPath: "thin.json",
      thresholdsPath: "thresholds.json",
    });
  });

  it("accepts a backward-compatible supplemental historical reply proof", () => {
    expect(parseCampaignArguments([
      "manifest.json",
      "sequential.json",
      "overlap.json",
      "reconnect.json",
      "--historical-reply",
      "historical-reply.json",
      "--thin-remediation",
      "thin.json",
    ])).toEqual({
      evidencePaths: ["sequential.json", "overlap.json", "reconnect.json"],
      historicalReplyPath: "historical-reply.json",
      manifestPath: "manifest.json",
      thinRemediationPath: "thin.json",
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

  it("rejects a missing historical reply proof path", () => {
    expect(() => parseCampaignArguments([
      "manifest.json", "a.json", "b.json", "c.json", "--historical-reply",
    ])).toThrow("Historical reply proof requires one JSON path");
  });

  it.each([
    ["missing", ["manifest.json", "a.json", "b.json", "c.json"]],
    ["pathless", ["manifest.json", "a.json", "b.json", "c.json", "--thin-remediation"]],
    ["duplicated", ["manifest.json", "a.json", "b.json", "c.json",
      "--thin-remediation", "one.json", "--thin-remediation", "two.json"]],
  ])("rejects a %s mandatory thin remediation proof", (_name, arguments_) => {
    expect(() => parseCampaignArguments(arguments_)).toThrow(/Thin remediation|Usage/u);
  });
});
