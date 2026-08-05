import type {
  DeployedServiceProvenance,
  DeploymentProvenance,
  RetainedE2eEvidence,
} from "./e2e-evidence-schema.js";
import type { VerificationFailureReporter } from "./e2e-evidence-verification-types.js";

export function verifyDeploymentProvenance(
  evidence: RetainedE2eEvidence,
  fail: VerificationFailureReporter,
): void {
  const { craig, meetingPlatform } = evidence.deployment;
  if (
    craig.composeProject === meetingPlatform.composeProject &&
    craig.composeService === meetingPlatform.composeService
  ) {
    fail(
      "DEPLOYMENT_COMPONENT_COLLISION",
      "Craig and Meeting Platform provenance resolve to the same Compose service",
    );
  }
  const recordingStartedAt = Date.parse(evidence.recording.startedAt);
  for (const [component, provenance] of [
    ["craig", craig],
    ["meetingPlatform", meetingPlatform],
  ] as const) {
    if (Date.parse(provenance.containerStartedAt) > recordingStartedAt) {
      fail(
        "DEPLOYMENT_STARTED_AFTER_RECORDING",
        `${component} container started after the authoritative recording began`,
      );
    }
  }
}

export function sameDeploymentProvenance(
  left: DeploymentProvenance,
  right: DeploymentProvenance,
): boolean {
  return sameServiceProvenance(left.craig, right.craig) &&
    sameServiceProvenance(left.meetingPlatform, right.meetingPlatform);
}

export function sameServiceProvenance(
  left: DeployedServiceProvenance,
  right: DeployedServiceProvenance,
): boolean {
  return left.composeConfigHash === right.composeConfigHash &&
    left.composeProject === right.composeProject &&
    left.composeService === right.composeService &&
    left.containerId === right.containerId &&
    left.containerStartedAt === right.containerStartedAt &&
    left.imageId === right.imageId &&
    left.repositoryDigest === right.repositoryDigest &&
    left.sourceRevision === right.sourceRevision;
}
