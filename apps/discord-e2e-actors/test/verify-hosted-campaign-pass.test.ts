import { describe, expect, it } from "vitest";

import { parsePassVerificationArguments } from
  "../src/verify-hosted-campaign-pass.js";

describe("hosted campaign pass verification arguments", () => {
  it("requires the receipt, exact plan, and artifact root", () => {
    expect(parsePassVerificationArguments([
      "--", "/proof/pass.json", "/proof/plan.json", "/proof/artifacts",
    ])).toEqual({
      artifactRoot: "/proof/artifacts",
      planPath: "/proof/plan.json",
      receiptPath: "/proof/pass.json",
    });
    expect(() => parsePassVerificationArguments([
      "/proof/pass.json", "/proof/plan.json",
    ])).toThrow(/Usage/u);
    expect(() => parsePassVerificationArguments([
      "/proof/pass.json", "relative-plan.json", "/proof/artifacts",
    ])).toThrow(/Usage/u);
  });
});
