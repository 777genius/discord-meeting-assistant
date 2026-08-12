import {
  HOSTED_CAMPAIGN_TARGET,
  type HostedCampaignActionReference,
  type HostedCampaignExecutableSpec,
} from "./hosted-campaign-coordinator.js";
import {
  type FixedHostedCampaignRun,
  type HostedCampaignChildContext,
  produced,
  reference,
} from "./hosted-campaign-plan-child-context.js";

export function makeProvenanceProbe(
  context: HostedCampaignChildContext,
  phase: "before" | "after",
  run: FixedHostedCampaignRun<1 | 2 | 3>,
  start: HostedCampaignActionReference & {
    readonly action: { readonly kind: "provenance-before" | "provenance-after" };
  },
): HostedCampaignExecutableSpec {
  const { barrierPath, definition, paths, remote, revisions, runVerified } = context;
  return {
    arguments: { kind: "environment" }, childId: `provenance-${phase}`,
    completion: {
      action: start.action, campaignId: definition.campaignId,
      kind: "provenance-probe", phase, runIds: definition.runIds, snapshotPath: paths.provenanceSnapshot,
    },
    entrypoint: "provenance-probe", environment: {
      ...remote, ...revisions, DISCORD_E2E_PROVENANCE_CAMPAIGN_ID: definition.campaignId,
      DISCORD_E2E_PROVENANCE_PHASE: phase,
      DISCORD_E2E_PROVENANCE_RUN_IDS_JSON: JSON.stringify(definition.runIds),
      DISCORD_E2E_PROVENANCE_SNAPSHOT_PATH: paths.provenanceSnapshot,
    },
    produces: [produced(run, start.action, barrierPath(`provenance-${phase}`))],
    requires: phase === "after" ? [runVerified[2]!] : [], startBefore: { ...start, kind: "barrier" },
  };
}

export function makeRecordingReadyCollector(
  context: HostedCampaignChildContext,
  run: FixedHostedCampaignRun<1 | 2 | 3>,
): HostedCampaignExecutableSpec {
  const { barrierPath, bindings, conversationCompleted, paths, recordingReady, remote, revisions, supplementalCompleted } = context;
  const actorCompleted = reference(run, { kind: "actor-completed", ordinal: run.ordinal, runId: run.runId });
  const prerequisites = run.ordinal === 3 ? [actorCompleted, conversationCompleted, supplementalCompleted] : [actorCompleted];
  return {
    arguments: { kind: "environment" }, childId: `recording-ready-${run.ordinal}`,
    completion: { action: recordingReady[run.ordinal - 1]!.action, kind: "recording-ready", outputPath: paths.run(run.ordinal, "recording-ready.json"), runId: run.runId },
    completionAfter: actorCompleted, entrypoint: "recording-ready", environment: {
      ...remote, ...revisions, DISCORD_E2E_ACTOR_RUN_INPUT: paths.run(run.ordinal, "actor.json"),
      DISCORD_E2E_READY_RECEIPT_OUTPUT: paths.run(run.ordinal, "recording-ready.json"),
      DISCORD_E2E_READY_RECEIPT_POLL_INTERVAL_MS: "2000", DISCORD_E2E_READY_RECEIPT_TIMEOUT_MS: "900000",
      DISCORD_E2E_REMOTE_ATTESTATION_FILE: bindings.runs[run.ordinal - 1]!.remoteAttestationPath,
      DISCORD_E2E_RUN_ID: run.runId,
    }, produces: [produced(run, recordingReady[run.ordinal - 1]!.action, barrierPath(`recording-ready-${run.ordinal}`))],
    requires: prerequisites, startBefore: { ...recordingReady[run.ordinal - 1]!, kind: "barrier" },
  };
}

export function makeReplayAttestationPublisher(
  context: HostedCampaignChildContext,
  run: FixedHostedCampaignRun<1 | 2 | 3>,
): HostedCampaignExecutableSpec {
  const { barrierPath, bindings, definition, recordingReady, replayAttestationReady } = context;
  return {
    arguments: { kind: "environment" }, childId: `replay-attestation-${run.ordinal}`,
    completion: {
      action: replayAttestationReady[run.ordinal - 1]!.action,
      fixtureManifestPath: definition.fixtureManifestPath,
      kind: "replay-attestation-publisher",
      remoteAttestationPath: bindings.runs[run.ordinal - 1]!.remoteAttestationPath,
      runId: run.runId,
    }, completionAfter: recordingReady[run.ordinal - 1]!, entrypoint: "replay-attestation-publisher",
    environment: {
      DISCORD_E2E_REPLAY_FIXTURE_MANIFEST: definition.fixtureManifestPath,
      DISCORD_E2E_REPLAY_MUTATION_TARGET: HOSTED_CAMPAIGN_TARGET.mutationTarget,
      DISCORD_E2E_REPLAY_REMOTE_ATTESTATION_FILE: bindings.runs[run.ordinal - 1]!.remoteAttestationPath,
      DISCORD_E2E_REPLAY_REMOTE_COMPOSE_FILE: definition.remote.composeFile,
      DISCORD_E2E_REPLAY_REMOTE_ENV_FILE: definition.remote.environmentFile,
      DISCORD_E2E_REPLAY_REMOTE_HOST: HOSTED_CAMPAIGN_TARGET.host,
      DISCORD_E2E_REPLAY_REMOTE_SOURCE_ROOT: definition.remote.sourceRoot,
      DISCORD_E2E_REPLAY_RUN_ID: run.runId,
    }, environmentBindings: [{
      name: "DISCORD_E2E_REPLAY_RECORDING_ID",
      valueFrom: { actionRef: recordingReady[run.ordinal - 1]!, field: "recordingId" },
    }], produces: [produced(run, replayAttestationReady[run.ordinal - 1]!.action, barrierPath(`replay-attestation-${run.ordinal}-ready`))],
    requires: [recordingReady[run.ordinal - 1]!],
    startBefore: { ...replayAttestationReady[run.ordinal - 1]!, kind: "barrier" },
  };
}

export function makePlaybackLinkObserver(context: HostedCampaignChildContext): HostedCampaignExecutableSpec {
  const { barrierPath, definition, paths, playbackLinkSeen, reconnect, recordingReady } = context;
  return {
    arguments: { kind: "environment" }, childId: "playback-link-observer",
    completion: { action: playbackLinkSeen.action, kind: "playback-link-observer", outputPath: paths.run(3, "playback-link.json"), runId: reconnect.runId },
    completionAfter: recordingReady[2]!, entrypoint: "playback-link-observer", environment: {
      DISCORD_E2E_PLAYBACK_LINK_DURATION_MS: "600000", DISCORD_E2E_PLAYBACK_LINK_MODE: "hosted",
      DISCORD_E2E_PLAYBACK_LINK_OUTPUT: paths.run(3, "playback-link.json"),
      DISCORD_E2E_PLAYBACK_LINK_POLL_INTERVAL_MS: "2000",
      DISCORD_E2E_PLAYBACK_LINK_RECORDING_PLAYBACK_ORIGIN: definition.recordingPlaybackOrigin,
      DISCORD_E2E_PLAYBACK_LINK_RESULT_CHANNEL_ID: HOSTED_CAMPAIGN_TARGET.publicationChannelId,
      DISCORD_E2E_PLAYBACK_LINK_RUN_ID: reconnect.runId,
      DISCORD_E2E_PLAYBACK_LINK_SECRET_DIRECTORY: definition.secretDirectory,
      DISCORD_E2E_PLAYBACK_LINK_SUT_APPLICATION_ID: HOSTED_CAMPAIGN_TARGET.sutApplicationId,
    }, environmentBindings: [
      { name: "DISCORD_E2E_PLAYBACK_LINK_MEETING_ID", valueFrom: { actionRef: recordingReady[2]!, field: "meetingId" } },
      { name: "DISCORD_E2E_PLAYBACK_LINK_RECORDING_ID", valueFrom: { actionRef: recordingReady[2]!, field: "recordingId" } },
    ], produces: [produced(reconnect, playbackLinkSeen.action, barrierPath("playback-link-seen"))],
    requires: [recordingReady[2]!], startBefore: { ...playbackLinkSeen, kind: "barrier" },
  };
}
