import { describe, expect, it } from "vitest";

import {
  sameDeploymentProvenance,
  verifyDeploymentProvenance,
} from "../src/e2e-evidence-deployment-verification.js";
import { verifyProcessingEvidence } from "../src/e2e-evidence-processing-verification.js";
import type {
  DeploymentRevisionExpectation,
  RetainedE2eEvidenceV5,
} from "../src/e2e-evidence.js";
import type { VerificationFailure } from "../src/e2e-evidence-verification-types.js";
import {
  currentExpectedRevisions as expectedRevisions,
  retainedV5Evidence,
} from "./e2e-evidence-fixtures.js";

describe("retained E2E evidence v5 verification", () => {
  it("binds all four deployments and accepts the qualified runtime profile and latency", () => {
    const failures = verifyCurrentEvidence(retainedV5Evidence(), expectedRevisions);
    expect(failures).toEqual([]);
  });

  it("rejects runtime drift, excessive summary latency, and a different model profile", () => {
    const evidence = retainedV5Evidence();
    evidence.deployment.subscriptionRuntime.sourceRevision = "f".repeat(40);
    evidence.deployment.pipecat!.sourceRevision = "0".repeat(40);
    evidence.processing.stages.find(({ stage: stageName }) => stageName === "summary")!.durationMs = 60_001;
    evidence.processing.summaryRuntimeExecutions[0]!.model = "unexpected-model";

    expect(verifyCurrentEvidence(evidence, expectedRevisions).map(({ code }) => code))
      .toEqual(expect.arrayContaining([
        "DEPLOYMENT_SOURCE_REVISION_MISMATCH",
        "STAGE_LATENCY_EXCEEDED",
        "SUMMARY_RUNTIME_PROFILE_MISMATCH",
      ]));
  });

  it("rejects missing runtime expectations and detects Pipecat campaign drift", () => {
    const baseline = retainedV5Evidence();
    const changed = retainedV5Evidence();
    changed.deployment.pipecat!.imageId = `sha256:${"f".repeat(64)}`;

    expect(verifyCurrentEvidence(baseline, {
      craig: expectedRevisions.craig,
      meetingPlatform: expectedRevisions.meetingPlatform,
    }).map(({ code }) => code)).toContain("DEPLOYMENT_REVISION_EXPECTATION_MISSING");
    expect(sameDeploymentProvenance(baseline.deployment, changed.deployment)).toBe(false);
  });

  it("supports summary-only evidence and requires Pipecat only when expected", () => {
    const evidence = retainedV5Evidence();
    delete evidence.deployment.pipecat;
    const summaryOnlyRevisions = {
      craig: expectedRevisions.craig,
      meetingPlatform: expectedRevisions.meetingPlatform,
      subscriptionRuntime: expectedRevisions.subscriptionRuntime,
    };

    expect(verifyCurrentEvidence(evidence, summaryOnlyRevisions)).toEqual([]);
    expect(verifyCurrentEvidence(evidence, expectedRevisions).map(({ code }) => code))
      .toContain("DEPLOYMENT_COMPONENT_MISSING");
  });
});

function verifyCurrentEvidence(
  evidence: RetainedE2eEvidenceV5,
  revisions: DeploymentRevisionExpectation,
): VerificationFailure[] {
  const failures: VerificationFailure[] = [];
  const fail = (code: string, message: string) => failures.push({ code, message });
  verifyDeploymentProvenance(evidence, revisions, fail);
  verifyProcessingEvidence(evidence, fail);
  return failures;
}
