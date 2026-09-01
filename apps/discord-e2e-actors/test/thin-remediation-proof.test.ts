import { describe, expect, it } from "vitest";

import { thinRemediationProofV1Schema } from "../src/thin-remediation-proof.js";

describe("admitted remediation bundle", () => {
  it("rejects the former assertion-only child and fabricated-ID document", () => {
    expect(thinRemediationProofV1Schema.safeParse({
      campaignId: "campaign-1",
      children: [{
        admissionReceiptSha256: "a".repeat(64), childId: "greeting-observer-sequential",
        entrypoint: "greeting-observer", outputArtifactSha256: "b".repeat(64), runId: "run-1",
      }],
      greetingPhases: [], kind: "hosted-campaign-thin-remediation-proof",
      liveMemory: {}, schemaVersion: 1,
    }).success).toBe(false);
  });

  it("requires all five real child artifacts with exact output hashes", () => {
    const result = thinRemediationProofV1Schema.safeParse({
      artifacts: {}, campaignId: "campaign-1", kind: "hosted-campaign-remediation-bundle",
      release: { releaseBindingSha256: "a".repeat(64), releaseId: "release-1", trustRootSha256: "b".repeat(64) },
      runId: "run-3", schemaVersion: 2,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(({ path }) => path[0] === "artifacts")).toBe(true);
    }
  });
});
