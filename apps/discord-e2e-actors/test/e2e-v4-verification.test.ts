import { describe, expect, it } from "vitest";

import {
  sameDeploymentProvenance,
  verifyDeploymentProvenance,
} from "../src/e2e-evidence-deployment-verification.js";
import { verifyProcessingEvidence } from "../src/e2e-evidence-processing-verification.js";
import type {
  DeploymentRevisionExpectation,
  RetainedE2eEvidenceV4,
} from "../src/e2e-evidence.js";
import type { VerificationFailure } from "../src/e2e-evidence-verification-types.js";

const expectedRevisions: DeploymentRevisionExpectation = {
  craig: "6".repeat(40),
  meetingPlatform: "b".repeat(40),
  subscriptionRuntime: "e".repeat(40),
};

describe("retained E2E evidence v4 verification", () => {
  it("binds all three deployments and accepts the qualified runtime profile and latency", () => {
    const failures = verifyCurrentEvidence(currentEvidence(), expectedRevisions);
    expect(failures).toEqual([]);
  });

  it("rejects sidecar drift, excessive summary latency, and a different model profile", () => {
    const evidence = currentEvidence();
    evidence.deployment.subscriptionRuntime.sourceRevision = "f".repeat(40);
    evidence.processing.stages.find(({ stage: stageName }) => stageName === "summary")!.durationMs = 60_001;
    evidence.processing.summaryRuntimeExecutions[0]!.model = "unexpected-model";

    expect(verifyCurrentEvidence(evidence, expectedRevisions).map(({ code }) => code))
      .toEqual(expect.arrayContaining([
        "DEPLOYMENT_SOURCE_REVISION_MISMATCH",
        "STAGE_LATENCY_EXCEEDED",
        "SUMMARY_RUNTIME_PROFILE_MISMATCH",
      ]));
  });

  it("rejects a missing sidecar release expectation and detects sidecar campaign drift", () => {
    const baseline = currentEvidence();
    const changed = currentEvidence();
    changed.deployment.subscriptionRuntime.imageId = `sha256:${"f".repeat(64)}`;

    expect(verifyCurrentEvidence(baseline, {
      craig: expectedRevisions.craig,
      meetingPlatform: expectedRevisions.meetingPlatform,
    }).map(({ code }) => code)).toContain("DEPLOYMENT_REVISION_EXPECTATION_MISSING");
    expect(sameDeploymentProvenance(baseline.deployment, changed.deployment)).toBe(false);
  });
});

function verifyCurrentEvidence(
  evidence: RetainedE2eEvidenceV4,
  revisions: DeploymentRevisionExpectation,
): VerificationFailure[] {
  const failures: VerificationFailure[] = [];
  const fail = (code: string, message: string) => failures.push({ code, message });
  verifyDeploymentProvenance(evidence, revisions, fail);
  verifyProcessingEvidence(evidence, fail);
  return failures;
}

function currentEvidence(): RetainedE2eEvidenceV4 {
  return {
    schemaVersion: 4,
    deployment: {
      craig: service("craig-e2e", "bot", "4", "5", "6"),
      meetingPlatform: service("meeting-e2e", "meeting-platform", "8", "9", "b"),
      subscriptionRuntime: service("meeting-e2e", "subscription-runtime-sidecar", "c", "d", "e"),
    },
    processing: {
      stages: [
        stage("transcription", 2_000),
        stage("summary", 5_000),
        stage("publication", 500),
      ],
      summaryRuntimeExecutions: [{
        durationMs: 4_900,
        model: "gpt-5.6-sol",
        observedAt: "1970-01-01T00:00:12.900Z",
        outputSchemaName: "discord_meeting_summary_v4",
        policyVersion: "meeting-summary.subscription-runtime.v14",
        purpose: "discord_meeting.summary.generate",
        reasoningEffort: "medium",
        runId: "summary-run-1",
        status: "completed",
      }],
    },
    recording: { startedAt: "1970-01-01T00:00:00.000Z" },
  } as RetainedE2eEvidenceV4;
}

function service(
  composeProject: string,
  composeService: string,
  containerDigit: string,
  imageDigit: string,
  revisionDigit: string,
) {
  return {
    composeConfigHash: "3".repeat(64),
    composeProject,
    composeService,
    containerId: containerDigit.repeat(64),
    containerStartedAt: "1969-12-31T23:00:00.000Z",
    imageId: `sha256:${imageDigit.repeat(64)}`,
    repositoryDigest: null,
    sourceRevision: revisionDigit.repeat(40),
  };
}

function stage(stageName: "publication" | "summary" | "transcription", durationMs: number) {
  return {
    durationMs,
    observedAt: "1970-01-01T00:00:13.000Z",
    outcome: "succeeded" as const,
    stage: stageName,
  };
}
