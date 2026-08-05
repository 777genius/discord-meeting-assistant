import { verifyCampaign } from "./e2e-evidence-campaign-verification.js";
import { verifyDeploymentProvenance } from "./e2e-evidence-deployment-verification.js";
import { playbackWindowsFrom, verifyActorRun } from "./e2e-evidence-playback-verification.js";
import { verifyFixtures, verifyS3Evidence, verifyStages } from "./e2e-evidence-recording-verification.js";
import { verificationResult } from "./e2e-evidence-verification-result.js";
import {
  verifyDiscordSummaryUx,
  verifyEvidenceReferences,
  verifyReplayIdentity,
  verifySummarySemantics,
} from "./e2e-evidence-summary-verification.js";
import { verifyTranscript } from "./e2e-evidence-transcript-verification.js";
import type {
  FixtureManifestV1,
  RetainedE2eEvidence,
} from "./e2e-evidence-schema.js";
import type {
  E2eVerificationResult,
  SpeakerAccuracyMetrics,
  VerificationFailure,
  VerificationFailureReporter,
} from "./e2e-evidence-verification-types.js";

export {
  actorRunEvidenceV1Schema,
  fixtureManifestV1Schema,
  retainedE2eEvidenceSchema,
  retainedE2eEvidenceV2Schema,
  retainedE2eEvidenceV3Schema,
  unboundActorRunEvidenceV1Schema,
} from "./e2e-evidence-schema.js";
export type {
  ActorRunEvidenceV1,
  DeployedServiceProvenance,
  DeploymentProvenance,
  FixtureManifestV1,
  RetainedE2eEvidence,
  RetainedE2eEvidenceV2,
  RetainedE2eEvidenceV3,
  UnboundActorRunEvidenceV1,
} from "./e2e-evidence-schema.js";
export { sameDeploymentProvenance } from "./e2e-evidence-deployment-verification.js";
export type {
  E2eVerificationResult,
} from "./e2e-evidence-verification-types.js";

export function verifyRetainedE2eEvidence(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidence,
): E2eVerificationResult {
  const failures: VerificationFailure[] = [];
  const metrics: SpeakerAccuracyMetrics[] = [];
  const fail: VerificationFailureReporter = (code, message) => {
    failures.push({ code, message });
  };
  verifyEvidenceIdentity(manifest, evidence, fail);

  const scenario = manifest.scenarios.find(({ kind }) => kind === evidence.actorRun.scenario);
  if (scenario === undefined) {
    fail("UNKNOWN_SCENARIO", `scenario ${evidence.actorRun.scenario} is absent from the manifest`);
    return verificationResult(failures, metrics);
  }

  verifyFixtures(manifest, evidence, fail);
  verifyDeploymentProvenance(evidence, fail);
  verifyS3Evidence(evidence, fail);
  verifyStages(evidence, fail);
  const playbackWindows = playbackWindowsFrom(evidence, fail);
  const context = { evidence, fail, manifest, playbackWindows, scenario };
  verifyActorRun(context);
  verifyTranscript({ ...context, metrics });
  verifyEvidenceReferences(manifest, evidence, fail);
  verifySummarySemantics(manifest, evidence, fail);
  verifyDiscordSummaryUx(manifest, evidence, fail);
  verifyReplayIdentity(evidence, fail);

  return verificationResult(failures, metrics);
}

export function verifyE2eCampaign(
  manifest: FixtureManifestV1,
  runs: readonly RetainedE2eEvidence[],
) {
  return verifyCampaign({
    manifest,
    runs,
    verifyRun: verifyRetainedE2eEvidence,
  });
}

function verifyEvidenceIdentity(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidence,
  fail: VerificationFailureReporter,
): void {
  if (evidence.fixtureSetId !== manifest.fixtureSetId) {
    fail("FIXTURE_SET_MISMATCH", "retained evidence references a different fixture set");
  }
  if (
    evidence.actorRun.fixtureSetId !== manifest.fixtureSetId ||
    evidence.actorRun.recordingId !== evidence.recording.recordingId ||
    evidence.actorRun.recordingId !== evidence.meetingId
  ) {
    fail("ACTOR_RECORDING_CORRELATION_MISMATCH", "actor run is not correlated to this recording");
  }
}
