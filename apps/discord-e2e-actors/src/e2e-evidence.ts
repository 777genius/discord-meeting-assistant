import { verifyCampaign } from "./e2e-evidence-campaign-verification.js";
import { verifyDeploymentProvenance } from "./e2e-evidence-deployment-verification.js";
import { playbackWindowsFrom, verifyActorRun } from "./e2e-evidence-playback-verification.js";
import { verifyProcessingEvidence } from "./e2e-evidence-processing-verification.js";
import { verifyE2eServiceLevels, type ServiceLevelThresholds } from "./e2e-service-levels.js";
import { verifyRecordingPlaybackEvidence } from "./e2e-evidence-recording-playback-verification.js";
import { verifyFixtures, verifyS3Evidence, verifyStages } from "./e2e-evidence-recording-verification.js";
import { verificationResult } from "./e2e-evidence-verification-result.js";
import {
  verifyDiscordSummaryUx,
  verifyEvidenceReferences,
  verifyReplayIdentity,
  verifySummarySemantics,
} from "./e2e-evidence-summary-verification.js";
import {
  verifyTranscript,
} from "./e2e-evidence-transcript-content-verification.js";
import { verifyConversationEvidence } from "./e2e-evidence-transcript-verification.js";
import type {
  FixtureManifestV1,
  DeploymentRevisionExpectation,
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
  conversationVoiceEvidenceV3Schema,
  deploymentRevisionExpectationSchema,
  fixtureManifestV1Schema,
  retainedE2eEvidenceSchema,
  retainedE2eEvidenceV2Schema,
  retainedE2eEvidenceV3Schema,
  retainedE2eEvidenceV4Schema,
  retainedE2eEvidenceV5Schema,
  retainedE2eEvidenceV6Schema,
  retainedE2eEvidenceV7Schema,
  retainedE2eEvidenceV8Schema,
  retainedE2eEvidenceV9Schema,
  retainedReconnectE2eEvidenceV8Schema,
  unboundActorRunEvidenceV1Schema,
} from "./e2e-evidence-schema.js";
export { supplementalPlaybackEvidenceV1Schema } from "./conversation-retained-evidence-schema.js";
export { conversationVoiceCampaignProofV1Schema } from "./conversation-voice-campaign-proof.js";
export {
  e2eServiceLevelsV1Schema,
  serviceLevelIds,
  serviceLevelMeasurementV1Schema,
  serviceLevelThresholdsSchema,
  verifyE2eServiceLevels,
} from "./e2e-service-levels.js";
export type { E2eServiceLevelsV1, ServiceLevelThresholds } from "./e2e-service-levels.js";
export type {
  ActorRunEvidenceV1,
  CurrentDeploymentProvenance,
  DeployedServiceProvenance,
  DeploymentRevisionExpectation,
  FixtureManifestV1,
  ProcessingEvidence,
  RetainedE2eEvidence,
  RetainedE2eEvidenceV2,
  RetainedE2eEvidenceV3,
  RetainedE2eEvidenceV4,
  RetainedE2eEvidenceV5,
  RetainedE2eEvidenceV6,
  RetainedE2eEvidenceV7,
  RetainedE2eEvidenceV8,
  RetainedE2eEvidenceV9,
  RetainedReconnectE2eEvidenceV8,
  UnboundActorRunEvidenceV1,
} from "./e2e-evidence-schema.js";
export { sameDeploymentProvenance } from "./e2e-evidence-deployment-verification.js";
export type {
  E2eVerificationResult,
} from "./e2e-evidence-verification-types.js";

export function verifyRetainedE2eEvidence(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidence,
  expectedRevisions: DeploymentRevisionExpectation,
  serviceLevelThresholds?: ServiceLevelThresholds,
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
  verifyDeploymentProvenance(evidence, expectedRevisions, fail);
  verifyS3Evidence(evidence, fail);
  verifyStages(evidence, fail);
  verifyProcessingEvidence(evidence, fail);
  verifyRecordingPlaybackEvidence(evidence, fail);
  const playbackWindows = playbackWindowsFrom(evidence, fail);
  const context = { evidence, fail, manifest, playbackWindows, scenario };
  verifyActorRun(context);
  verifyTranscript({ ...context, metrics });
  verifyConversationEvidence(manifest, evidence, expectedRevisions, fail);
  verifyEvidenceReferences(manifest, evidence, fail);
  verifySummarySemantics(manifest, evidence, fail);
  verifyDiscordSummaryUx(manifest, evidence, fail);
  verifyReplayIdentity(evidence, fail);
  if (evidence.schemaVersion === 9) {
    if (serviceLevelThresholds === undefined) {
      fail("SLA_THRESHOLDS_MISSING", "retained evidence v9 requires externally supplied service-level thresholds");
    } else {
      verifyE2eServiceLevels(evidence.serviceLevels, serviceLevelThresholds, fail);
    }
  }

  return verificationResult(failures, metrics);
}

export function verifyE2eCampaign(
  manifest: FixtureManifestV1,
  runs: readonly RetainedE2eEvidence[],
  expectedRevisions: DeploymentRevisionExpectation,
  serviceLevelThresholds?: ServiceLevelThresholds,
) {
  return verifyCampaign({
    manifest,
    runs,
    verifyRun: (runManifest, evidence) =>
      verifyRetainedE2eEvidence(runManifest, evidence, expectedRevisions, serviceLevelThresholds),
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
