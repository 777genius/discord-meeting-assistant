import type {
  DeployedServiceProvenance,
  DeploymentRevisionExpectation,
  RetainedE2eEvidence,
} from "./e2e-evidence-schema.js";
import type { VerificationFailureReporter } from "./e2e-evidence-verification-types.js";

export function verifyDeploymentProvenance(
  evidence: RetainedE2eEvidence,
  expectedRevisions: DeploymentRevisionExpectation,
  fail: VerificationFailureReporter,
): void {
  const { craig, meetingPlatform } = evidence.deployment;
  const components = [
    ["craig", craig],
    ["meetingPlatform", meetingPlatform],
    ...(evidence.schemaVersion === 4
      ? [["subscriptionRuntime", evidence.deployment.subscriptionRuntime] as const]
      : []),
  ] as const;
  verifyDistinctServices(components, fail);
  const recordingStartedAt = Date.parse(evidence.recording.startedAt);
  for (const [component, provenance] of components) {
    const expectedRevision = expectedRevisions[component];
    if (expectedRevision === undefined) {
      fail(
        "DEPLOYMENT_REVISION_EXPECTATION_MISSING",
        `${component} has no release-candidate revision expectation`,
      );
    } else if (provenance.sourceRevision !== expectedRevision) {
      fail(
        "DEPLOYMENT_SOURCE_REVISION_MISMATCH",
        `${component} source revision does not match the release candidate`,
      );
    }
    if (Date.parse(provenance.containerStartedAt) > recordingStartedAt) {
      fail(
        "DEPLOYMENT_STARTED_AFTER_RECORDING",
        `${component} container started after the authoritative recording began`,
      );
    }
  }
}

export function sameDeploymentProvenance(
  left: RetainedE2eEvidence["deployment"],
  right: RetainedE2eEvidence["deployment"],
): boolean {
  if (
    !sameServiceProvenance(left.craig, right.craig) ||
    !sameServiceProvenance(left.meetingPlatform, right.meetingPlatform)
  ) {
    return false;
  }
  const leftRuntime = "subscriptionRuntime" in left ? left.subscriptionRuntime : undefined;
  const rightRuntime = "subscriptionRuntime" in right ? right.subscriptionRuntime : undefined;
  return leftRuntime === undefined || rightRuntime === undefined
    ? leftRuntime === rightRuntime
    : sameServiceProvenance(leftRuntime, rightRuntime);
}

function verifyDistinctServices(
  components: ReadonlyArray<readonly [string, DeployedServiceProvenance]>,
  fail: VerificationFailureReporter,
): void {
  const identities = new Set<string>();
  for (const [component, provenance] of components) {
    const identity = `${provenance.composeProject}/${provenance.composeService}`;
    if (identities.has(identity)) {
      fail(
        "DEPLOYMENT_COMPONENT_COLLISION",
        `${component} provenance reuses Compose service ${identity}`,
      );
    }
    identities.add(identity);
  }
}

function sameServiceProvenance(
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
