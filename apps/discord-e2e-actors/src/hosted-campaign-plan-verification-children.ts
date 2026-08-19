import {
  HOSTED_CAMPAIGN_TARGET,
  type HostedCampaignActionReference,
  type HostedCampaignBarrierAction,
  type HostedCampaignExecutableSpec,
} from "./hosted-campaign-coordinator.js";
import {
  type FixedHostedCampaignRun,
  type HostedCampaignChildContext,
  produced,
} from "./hosted-campaign-plan-child-context.js";

export function makeCollector(
  context: HostedCampaignChildContext,
  input: Readonly<{
    action: HostedCampaignActionReference & {
      readonly action: Extract<HostedCampaignBarrierAction, { readonly kind: "run-verified" }>;
    };
    binding: HostedCampaignChildContext["sequentialBinding"];
    required: readonly HostedCampaignActionReference[];
    run: FixedHostedCampaignRun<1 | 2 | 3>;
    serviceLevelsPath: string;
  }>,
): HostedCampaignExecutableSpec {
  const { action, binding, required, run, serviceLevelsPath } = input;
  const { barrierPath, definition, paths, remote, revisions, voicePaths } = context;
  const evidencePath = paths.run(run.ordinal, "evidence.json");
  return {
    arguments: { kind: "environment" }, childId: `collector-${run.ordinal}`,
    completion: { action: action.action, evidencePath, kind: "collector", runId: run.runId },
    entrypoint: "collector", environment: {
      ...remote, ...revisions, DISCORD_E2E_ACTOR_RUN_INPUT: paths.run(run.ordinal, "actor.json"),
      DISCORD_E2E_EVIDENCE_OUTPUT: evidencePath, DISCORD_E2E_FIXTURE_MANIFEST: definition.fixtureManifestPath,
      DISCORD_E2E_READY_RECEIPT_INPUT: paths.run(run.ordinal, "recording-ready.json"),
      DISCORD_E2E_RECORDING_PLAYBACK_ORIGIN: definition.recordingPlaybackOrigin,
      DISCORD_E2E_RECORDING_PLAYBACK_READINESS: "already-ready",
      DISCORD_E2E_RECORDING_PLAYBACK_TEST_SCOPE: "private-test-deployment",
      DISCORD_E2E_REMOTE_ATTESTATION_FILE: binding.remoteAttestationPath, DISCORD_E2E_RUN_ID: run.runId,
      DISCORD_E2E_SECRET_DIRECTORY: definition.secretDirectory,
      DISCORD_E2E_SERVICE_LEVEL_THRESHOLDS_INPUT: definition.serviceLevelThresholdsPath,
      ...(run.ordinal === 3 ? {
        DISCORD_E2E_BOTIK_SPEAKER_ID: HOSTED_CAMPAIGN_TARGET.botikApplicationId,
        DISCORD_E2E_CONVERSATION_CAMPAIGN_PROOF_INPUT: paths.campaignProof,
        DISCORD_E2E_CONVERSATION_VOICE_INPUTS: JSON.stringify(voicePaths),
        DISCORD_E2E_DISCORD_PLAYBACK_LINK_PROOF_INPUT: paths.run(3, "playback-link.json"),
        DISCORD_E2E_SERVICE_LEVELS_INPUT: serviceLevelsPath,
        DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_INPUT: paths.run(3, "supplemental.json"),
      } : {}),
    }, produces: [produced(run, action.action, barrierPath(`run-${run.ordinal}-verified`))], requires: required,
    startBefore: { ...action, kind: "barrier" },
  };
}

export function makeCampaignVerifier(context: HostedCampaignChildContext): HostedCampaignExecutableSpec {
  const { barrierPath, campaignVerified, definition, paths, provenanceAfter, reconnect, revisions } = context;
  return {
    arguments: {
      evidencePaths: [paths.run(1, "evidence.json"), paths.run(2, "evidence.json"), paths.run(3, "evidence.json")],
      kind: "campaign-verifier", manifestPath: definition.fixtureManifestPath,
    }, childId: "campaign-verifier", completion: {
      action: { kind: "campaign-verified" }, campaignId: definition.campaignId,
      kind: "campaign-verifier", runIds: definition.runIds,
    }, entrypoint: "campaign-verifier", environment: revisions,
    produces: [produced(reconnect, campaignVerified.action, barrierPath("campaign-verified"))],
    requires: [provenanceAfter], startBefore: { ...campaignVerified, kind: "barrier" },
  };
}
