import { join, normalize, relative } from "node:path";

import { HOSTED_CAMPAIGN_TARGET, type HostedCampaignActionReference, type HostedCampaignBarrierAction, type HostedCampaignExecutableSpec, type HostedCampaignRun } from "./hosted-campaign-coordinator.js";
import type { HostedCampaignDefinitionV1, HostedCampaignRuntimeBindingsV1 } from "./hosted-campaign-plan-builder.js";

type FixedHostedCampaignRun<Ordinal extends 1 | 2 | 3> = HostedCampaignRun & { readonly ordinal: Ordinal };
type HostedCampaignRuns = readonly [FixedHostedCampaignRun<1>, FixedHostedCampaignRun<2>, FixedHostedCampaignRun<3>];

interface CampaignPaths {
  readonly artifactRoot: string;
  readonly campaignProof: string;
  readonly provenanceSnapshot: string;
  readonly run: (ordinal: 1 | 2 | 3, leaf: string) => string;
}

function safeJoin(root: string, ...parts: readonly string[]): string {
  const normalizedRoot = normalize(root);
  const candidate = normalize(join(normalizedRoot, ...parts));
  const relation = relative(normalizedRoot, candidate);
  if (relation === "" || relation === ".." || relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Hosted campaign path escaped or replaced its owned root");
  }
  return candidate;
}

function reference<Action extends HostedCampaignActionReference["action"]>(run: HostedCampaignRun, action: Action): HostedCampaignActionReference & { readonly action: Action } {
  return { action, ordinal: run.ordinal, runId: run.runId };
}

function runVerifiedReference(run: HostedCampaignRun): HostedCampaignActionReference & { readonly action: Extract<HostedCampaignBarrierAction, { readonly kind: "run-verified" }> } {
  return { action: { kind: "run-verified", ordinal: run.ordinal, runId: run.runId }, ordinal: run.ordinal, runId: run.runId };
}

function provenanceReference(run: HostedCampaignRun, phase: "after" | "before"): HostedCampaignActionReference & { readonly action: { readonly kind: "provenance-after" | "provenance-before" } } {
  return { action: { kind: phase === "before" ? "provenance-before" : "provenance-after" }, ordinal: run.ordinal, runId: run.runId };
}

function produced(run: HostedCampaignRun, action: HostedCampaignActionReference["action"], outputPath: string) {
  return { ...reference(run, action), outputPath };
}

export function makeHostedCampaignChildren(
  definition: HostedCampaignDefinitionV1,
  bindings: HostedCampaignRuntimeBindingsV1,
  runs: HostedCampaignRuns,
  campaignRoot: string,
): readonly HostedCampaignExecutableSpec[] {
  const ownedRoot = safeJoin(campaignRoot, definition.campaignId);
  const paths: CampaignPaths = Object.freeze({
    artifactRoot: safeJoin(ownedRoot, "barriers"), campaignProof: safeJoin(ownedRoot, "campaign-proof.json"),
    provenanceSnapshot: safeJoin(ownedRoot, "provenance.json"),
    run: (ordinal: 1 | 2 | 3, leaf: string) => safeJoin(ownedRoot, `run-${ordinal}`, leaf),
  });
  const [sequential, overlap, reconnect] = runs;
  const [sequentialBinding, overlapBinding, reconnectBinding] = bindings.runs;
  const provenanceBefore = provenanceReference(sequential, "before");
  const observerSubscribed = reference(reconnect, { kind: "observer-subscribed" });
  const runVerified = runs.map(runVerifiedReference);
  const provenanceAfter = provenanceReference(reconnect, "after");
  const campaignVerified = reference(reconnect, { kind: "campaign-verified" });
  const revisions = {
    DISCORD_E2E_EXPECTED_CRAIG_SOURCE_REVISION: definition.revisions.craig,
    DISCORD_E2E_EXPECTED_MEETING_PLATFORM_SOURCE_REVISION: definition.revisions.meetingPlatform,
    DISCORD_E2E_EXPECTED_PIPECAT_SOURCE_REVISION: definition.revisions.pipecat,
    DISCORD_E2E_EXPECTED_SUBSCRIPTION_RUNTIME_SOURCE_REVISION: definition.revisions.subscriptionRuntime,
  };
  const remote = {
    DISCORD_E2E_MUTATION_TARGET: HOSTED_CAMPAIGN_TARGET.mutationTarget,
    DISCORD_E2E_REMOTE_COMPOSE_FILE: definition.remote.composeFile,
    DISCORD_E2E_REMOTE_CRAIG_PROJECT: HOSTED_CAMPAIGN_TARGET.craigProject,
    DISCORD_E2E_REMOTE_CRAIG_SERVICE: "bot",
    DISCORD_E2E_REMOTE_ENV_FILE: definition.remote.environmentFile,
    DISCORD_E2E_REMOTE_HOST: HOSTED_CAMPAIGN_TARGET.host,
    DISCORD_E2E_REMOTE_PROJECT: HOSTED_CAMPAIGN_TARGET.project,
    DISCORD_E2E_REMOTE_SOURCE_ROOT: definition.remote.sourceRoot,
  };
  const barrierPath = (name: string) => safeJoin(paths.artifactRoot, `${name}.json`);
  const provenance = (
    phase: "before" | "after",
    run: HostedCampaignRun,
    start: HostedCampaignActionReference & { readonly action: { readonly kind: "provenance-before" | "provenance-after" } },
  ): HostedCampaignExecutableSpec => ({
    arguments: { kind: "environment" }, childId: `provenance-${phase}`,
    completion: {
      action: start.action, campaignId: definition.campaignId,
      kind: "provenance-probe", phase, runIds: definition.runIds, snapshotPath: paths.provenanceSnapshot,
    },
    entrypoint: "provenance-probe", environment: {
      ...remote, ...revisions, DISCORD_E2E_PROVENANCE_CAMPAIGN_ID: definition.campaignId,
      DISCORD_E2E_PROVENANCE_PHASE: phase, DISCORD_E2E_PROVENANCE_RUN_IDS_JSON: JSON.stringify(definition.runIds),
      DISCORD_E2E_PROVENANCE_SNAPSHOT_PATH: paths.provenanceSnapshot,
    }, produces: [produced(run, start.action, barrierPath(`provenance-${phase}`))], requires: phase === "after" ? [runVerified[2]!] : [],
    startBefore: { ...start, kind: "barrier" },
  });
  const captures = Array.from({ length: 6 }, (_, index) =>
    reference(reconnect, { kind: "capture-retained", ordinal: index + 1 }));
  const reconnectLeft = reference(reconnect, { kind: "reconnect-left" });
  const reconnectReady = reference(reconnect, { kind: "reconnect-ready" });
  const actorPlaybackCompleted = reference(reconnect, { kind: "actor-scenario-playback-completed" });
  const answerIntent = reference(reconnect, { kind: "answer-intent" });
  const answerObserverReady = reference(reconnect, { kind: "answer-observer-ready" });
  const answerFirstPacket = reference(reconnect, { kind: "answer-first-packet" });
  const conversationCompleted = reference(reconnect, { kind: "conversation-observer-completed", ordinal: 3, runId: reconnect.runId });
  const supplementalCompleted = reference(reconnect, { kind: "supplemental-completed", ordinal: 3, runId: reconnect.runId });
  const recordingReady = runs.map((run) => reference(run, { kind: "recording-ready", ordinal: run.ordinal, runId: run.runId }));
  const replayAttestationReady = runs.map((run) => reference(run, {
    kind: "replay-attestation-ready", ordinal: run.ordinal, runId: run.runId,
  }));
  const playbackLinkSeen = reference(reconnect, { kind: "playback-link-seen", ordinal: 3, runId: reconnect.runId });
  const serviceLevelSourcesReady = reference(reconnect, { kind: "service-level-sources-ready" });
  const serviceLevelsReady = reference(reconnect, { kind: "service-levels-ready" });
  const voicePaths = captures.map((_, index) => paths.run(3, `capture-${index + 1}.json`)) as
    [string, string, string, string, string, string];
  const conversationObserver: HostedCampaignExecutableSpec = {
    arguments: { kind: "environment" }, childId: "conversation-observer", entrypoint: "conversation-observer",
    completion: { action: conversationCompleted.action, kind: "conversation-observer", outputPaths: voicePaths, runId: reconnect.runId },
    completionAfter: captures[5]!,
    environment: {
      DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON: JSON.stringify([
        { attemptId: `${reconnect.runId}:capture-2`, expectedDuration: { maximumMilliseconds: 2_500, minimumMilliseconds: 2_000 }, outputPath: voicePaths[1], purpose: "greeting", turnId: `participant-greeting:${HOSTED_CAMPAIGN_TARGET.speakerAApplicationId}` },
        { attemptId: `${reconnect.runId}:capture-3`, expectedDuration: { maximumMilliseconds: 3_500, minimumMilliseconds: 3_000 }, outputPath: voicePaths[2], purpose: "greeting", turnId: `participant-greeting:${HOSTED_CAMPAIGN_TARGET.speakerBApplicationId}` },
        { attemptId: `${reconnect.runId}:capture-4`, expectedDuration: { maximumMilliseconds: 4_500, minimumMilliseconds: 4_000 }, outputPath: voicePaths[3], purpose: "greeting", turnId: `participant-greeting:${HOSTED_CAMPAIGN_TARGET.speakerDApplicationId}` },
        { expectedDuration: { maximumMilliseconds: 3_500, minimumMilliseconds: 3_000 }, outputPath: voicePaths[4], playbackHandshakeRoot: paths.run(3, "answer-handshakes"), purpose: "addressed-answer" },
        { attemptId: `${reconnect.runId}:capture-6`, expectedDuration: { maximumMilliseconds: 6_500, minimumMilliseconds: 6_000 }, outputPath: voicePaths[5], purpose: "farewell", turnId: "meeting-farewell:v1" },
      ]),
      DISCORD_E2E_CONVERSATION_VOICE_ATTEMPT_ID: `${reconnect.runId}:capture-1`,
      DISCORD_E2E_CONVERSATION_VOICE_CAPTURE_TIMEOUT_MS: "60000",
      DISCORD_E2E_CONVERSATION_VOICE_CAMPAIGN_PROOF_OUTPUT: paths.campaignProof,
      DISCORD_E2E_CONVERSATION_VOICE_CRAIG_BOT_ID: HOSTED_CAMPAIGN_TARGET.botikApplicationId,
      DISCORD_E2E_CONVERSATION_VOICE_EXPECTED_DURATION_MS: "1000",
      DISCORD_E2E_CONVERSATION_VOICE_GUILD_ID: HOSTED_CAMPAIGN_TARGET.guildId,
      DISCORD_E2E_CONVERSATION_VOICE_GREETING_HANDSHAKE_ROOT: paths.run(3, "greeting-handshakes"),
      DISCORD_E2E_CONVERSATION_VOICE_OBSERVER_APPLICATION_ID: HOSTED_CAMPAIGN_TARGET.observerApplicationId,
      DISCORD_E2E_CONVERSATION_VOICE_OUTPUT: voicePaths[0],
      DISCORD_E2E_CONVERSATION_VOICE_PRIVATE_TEST_GUILD: "private-test-guild",
      DISCORD_E2E_CONVERSATION_VOICE_PURPOSE: "greeting",
      DISCORD_E2E_CONVERSATION_VOICE_RUN_ID: reconnect.runId,
      DISCORD_E2E_CONVERSATION_VOICE_SECRET_DIRECTORY: definition.secretDirectory,
      DISCORD_E2E_CONVERSATION_VOICE_TURN_ID: `participant-greeting:${HOSTED_CAMPAIGN_TARGET.observerApplicationId}`,
      DISCORD_E2E_CONVERSATION_VOICE_VOICE_CHANNEL_ID: HOSTED_CAMPAIGN_TARGET.voiceChannelId,
      DISCORD_E2E_HOSTED_CAMPAIGN_ID: definition.campaignId,
    }, produces: [
      produced(reconnect, observerSubscribed.action, barrierPath("observer-subscribed")),
      ...captures.map((item) => produced(reconnect, item.action, barrierPath(`capture-${item.action.ordinal}`))),
      produced(reconnect, answerIntent.action, barrierPath("answer-intent")),
      produced(reconnect, answerObserverReady.action, barrierPath("answer-observer-ready")),
      produced(reconnect, answerFirstPacket.action, barrierPath("answer-first-packet")),
      produced(reconnect, conversationCompleted.action, barrierPath("conversation-observer-completed")),
    ],
    requires: [runVerified[1]!], startBefore: { ...observerSubscribed, kind: "barrier" },
  };
  const actor = (
    run: FixedHostedCampaignRun<1 | 2 | 3>,
    release: HostedCampaignActionReference,
    completionAfter: HostedCampaignActionReference = release,
  ): HostedCampaignExecutableSpec => {
    const completed = reference(run, { kind: "actor-completed", ordinal: run.ordinal, runId: run.runId });
    const releasePath = paths.run(run.ordinal, "actor-release.json");
    const releaseArmedPath = paths.run(run.ordinal, "actor-release-armed.json");
    const playbackPath = paths.run(run.ordinal, "actor-playback.json");
    const playbackArmedPath = paths.run(run.ordinal, "actor-playback-armed.json");
    const endPath = paths.run(run.ordinal, "actor-end.json");
    const endArmedPath = paths.run(run.ordinal, "actor-end-armed.json");
    const speakerBPath = paths.run(run.ordinal, "actor-speaker-b.json");
    const speakerBArmedPath = paths.run(run.ordinal, "actor-speaker-b-armed.json");
    return {
      arguments: { kind: "environment" }, childId: `actor-${run.ordinal}`,
      completion: { action: completed.action, kind: "actor", outputPath: paths.run(run.ordinal, "actor.json"), runId: run.runId, scenario: run.scenario },
      completionAfter, entrypoint: "actor", environment: {
        DISCORD_E2E_ACTOR_RUN_OUTPUT: paths.run(run.ordinal, "actor.json"),
        DISCORD_E2E_FIXTURE_MANIFEST: definition.fixtureManifestPath,
        DISCORD_E2E_GUILD_ID: HOSTED_CAMPAIGN_TARGET.guildId,
        DISCORD_E2E_HOSTED_RELEASE_GATE_CAMPAIGN_ID: definition.campaignId,
        DISCORD_E2E_HOSTED_RELEASE_GATE_ARMED_PATH: releaseArmedPath,
        DISCORD_E2E_HOSTED_RELEASE_GATE_PATH: releasePath,
        DISCORD_E2E_HOSTED_RELEASE_GATE_TIMEOUT_MS: "600000",
        ...(run.ordinal === 3 ? {
          DISCORD_E2E_HOSTED_PLAYBACK_GATE_PATH: playbackPath,
          DISCORD_E2E_HOSTED_PLAYBACK_GATE_ARMED_PATH: playbackArmedPath,
          DISCORD_E2E_HOSTED_END_GATE_PATH: endPath,
          DISCORD_E2E_HOSTED_END_GATE_ARMED_PATH: endArmedPath,
          DISCORD_E2E_HOSTED_SPEAKER_B_GATE_PATH: speakerBPath,
          DISCORD_E2E_HOSTED_SPEAKER_B_GATE_ARMED_PATH: speakerBArmedPath,
        } : {}),
        DISCORD_E2E_PLAYBACK_TIMEOUT_MS: "120000", DISCORD_E2E_READY_TIMEOUT_MS: "120000",
        DISCORD_E2E_RECORDER_BOT_ID: HOSTED_CAMPAIGN_TARGET.sutApplicationId,
        DISCORD_E2E_RUN_ID: run.runId, DISCORD_E2E_SCENARIO: run.scenario,
        DISCORD_E2E_SECRET_DIRECTORY: definition.secretDirectory,
        DISCORD_E2E_SPEAKER_A_FIXTURE: definition.speakerFixtures.a,
        DISCORD_E2E_SPEAKER_B_FIXTURE: definition.speakerFixtures.b,
        DISCORD_E2E_VOICE_CHANNEL_ID: HOSTED_CAMPAIGN_TARGET.voiceChannelId,
      }, produces: [
        produced(run, completed.action, barrierPath(`actor-${run.ordinal}-completed`)),
        ...(run.ordinal === 3 ? [produced(run, reconnectLeft.action, barrierPath("reconnect-left")), produced(run, reconnectReady.action, barrierPath("reconnect-ready"))] : []),
        ...(run.ordinal === 3 ? [produced(run, actorPlaybackCompleted.action, barrierPath("actor-playback-completed"))] : []),
      ], releaseGate: { action: release.action, armedPath: releaseArmedPath, ordinal: release.ordinal, path: releasePath, runId: release.runId },
      ...(run.ordinal === 3 ? { actorGates: {
        speakerB: { armedPath: speakerBArmedPath, path: speakerBPath, trigger: captures[1]! },
        playback: { armedPath: playbackArmedPath, path: playbackPath, trigger: captures[3]! },
        end: { armedPath: endArmedPath, path: endPath, trigger: conversationCompleted },
      } } : {}),
      requires: [], startBefore: { ...release, kind: "barrier" },
    };
  };
  const readyCollector = (run: FixedHostedCampaignRun<1 | 2 | 3>): HostedCampaignExecutableSpec => {
    const actorCompleted = reference(run, { kind: "actor-completed", ordinal: run.ordinal, runId: run.runId });
    const prerequisites = run.ordinal === 3 ? [actorCompleted, conversationCompleted, supplementalCompleted] : [actorCompleted];
    return {
      arguments: { kind: "environment" }, childId: `recording-ready-${run.ordinal}`,
      completion: { action: recordingReady[run.ordinal - 1]!.action, kind: "recording-ready", outputPath: paths.run(run.ordinal, "recording-ready.json"), runId: run.runId },
      completionAfter: actorCompleted,
      entrypoint: "recording-ready", environment: {
        ...remote, ...revisions, DISCORD_E2E_ACTOR_RUN_INPUT: paths.run(run.ordinal, "actor.json"),
        DISCORD_E2E_READY_RECEIPT_OUTPUT: paths.run(run.ordinal, "recording-ready.json"),
        DISCORD_E2E_READY_RECEIPT_POLL_INTERVAL_MS: "2000", DISCORD_E2E_READY_RECEIPT_TIMEOUT_MS: "900000",
        DISCORD_E2E_REMOTE_ATTESTATION_FILE: bindings.runs[run.ordinal - 1]!.remoteAttestationPath,
        DISCORD_E2E_RUN_ID: run.runId,
      }, produces: [produced(run, recordingReady[run.ordinal - 1]!.action, barrierPath(`recording-ready-${run.ordinal}`))],
      requires: prerequisites, startBefore: { ...recordingReady[run.ordinal - 1]!, kind: "barrier" },
    };
  };
  const supplemental: HostedCampaignExecutableSpec = {
    arguments: { kind: "environment" }, childId: "supplemental-player",
    completion: { action: supplementalCompleted.action, kind: "supplemental-player", outputPath: paths.run(3, "supplemental.json"), runId: reconnect.runId },
    completionAfter: conversationCompleted, entrypoint: "supplemental-player", environment: {
      DISCORD_E2E_SUPPLEMENTAL_CAMPAIGN_ID: definition.campaignId,
      DISCORD_E2E_SUPPLEMENTAL_CONNECTION_GATE_PATH: paths.run(3, "supplemental-connect.gate"),
      DISCORD_E2E_SUPPLEMENTAL_CONNECTION_GATE_ARMED_PATH: paths.run(3, "supplemental-connect.armed.json"),
      DISCORD_E2E_SUPPLEMENTAL_EVIDENCE_OUTPUT: paths.run(3, "supplemental.json"),
      DISCORD_E2E_SUPPLEMENTAL_GATE_TIMEOUT_MS: "120000",
      DISCORD_E2E_SUPPLEMENTAL_MANIFEST: definition.supplementalManifestPath,
      DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_GATE_PATH: paths.run(3, "supplemental-play.gate"),
      DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_GATE_ARMED_PATH: paths.run(3, "supplemental-play.armed.json"),
      DISCORD_E2E_SUPPLEMENTAL_PRIVATE_TEST_GUILD: "private-test-guild",
      DISCORD_E2E_SUPPLEMENTAL_RUN_ID: reconnect.runId,
      DISCORD_E2E_SUPPLEMENTAL_SECRET_DIRECTORY: definition.secretDirectory,
    }, produces: [produced(reconnect, supplementalCompleted.action, barrierPath("supplemental-completed"))],
    requires: [runVerified[1]!], startBefore: { ...observerSubscribed, kind: "barrier" },
    supplementalGates: {
      connection: { armedPath: paths.run(3, "supplemental-connect.armed.json"), path: paths.run(3, "supplemental-connect.gate"), trigger: captures[2]! },
      playback: { armedPath: paths.run(3, "supplemental-play.armed.json"), path: paths.run(3, "supplemental-play.gate"), trigger: actorPlaybackCompleted },
    },
  };
  const playbackObserver: HostedCampaignExecutableSpec = {
    arguments: { kind: "environment" }, childId: "playback-link-observer",
    completion: { action: playbackLinkSeen.action, kind: "playback-link-observer", outputPath: paths.run(3, "playback-link.json"), runId: reconnect.runId },
    completionAfter: recordingReady[2]!, entrypoint: "playback-link-observer", environment: {
      DISCORD_E2E_PLAYBACK_LINK_DURATION_MS: "600000", DISCORD_E2E_PLAYBACK_LINK_MODE: "hosted",
      DISCORD_E2E_PLAYBACK_LINK_OUTPUT: paths.run(3, "playback-link.json"),
      DISCORD_E2E_PLAYBACK_LINK_POLL_INTERVAL_MS: "2000",
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
  const replayAttestation = (run: FixedHostedCampaignRun<1 | 2 | 3>): HostedCampaignExecutableSpec => ({
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
  });
  const sourcePaths = {
    clock: paths.run(3, "sla-clock.json"), database: paths.run(3, "sla-database.json"),
    logs: paths.run(3, "sla-meeting-platform-logs.json"), report: paths.run(3, "sla-sources-report.json"),
    s3: paths.run(3, "sla-s3.json"),
  };
  const serviceLevelSources: HostedCampaignExecutableSpec = {
    arguments: { kind: "environment" }, childId: "service-level-sources",
    completion: {
      action: serviceLevelSourcesReady.action, campaignId: definition.campaignId,
      clockAttestationsPath: sourcePaths.clock, databasePath: sourcePaths.database,
      kind: "service-level-sources", meetingPlatformLogsPath: sourcePaths.logs,
      reportPath: sourcePaths.report, runId: reconnect.runId, s3Path: sourcePaths.s3,
    }, entrypoint: "service-level-sources", environment: {
      ...remote, DISCORD_E2E_SLA_CAMPAIGN_ID: definition.campaignId,
      DISCORD_E2E_SLA_CAMPAIGN_PROOF_INPUT: paths.campaignProof,
      DISCORD_E2E_SLA_CLOCK_ATTESTATIONS_INPUT: sourcePaths.clock,
      DISCORD_E2E_SLA_CLOCK_PREFLIGHT_INPUT: definition.clockPreflightPath,
      DISCORD_E2E_SLA_DATABASE_INPUT: sourcePaths.database,
      DISCORD_E2E_SLA_FIXTURE_MANIFEST_INPUT: definition.fixtureManifestPath,
      DISCORD_E2E_SLA_MEETING_PLATFORM_LOG_INPUT: sourcePaths.logs,
      DISCORD_E2E_SLA_PLAYBACK_LINK_PROOF_INPUT: paths.run(3, "playback-link.json"),
      DISCORD_E2E_SLA_READY_RECEIPT_INPUT: paths.run(3, "recording-ready.json"),
      DISCORD_E2E_SLA_RUN_ID: reconnect.runId, DISCORD_E2E_SLA_S3_INPUT: sourcePaths.s3,
      DISCORD_E2E_SLA_SOURCE_REPORT_OUTPUT: sourcePaths.report,
      DISCORD_E2E_SLA_SUPPLEMENTAL_PLAYBACK_INPUT: paths.run(3, "supplemental.json"),
      DISCORD_E2E_SLA_VOICE_INPUTS: JSON.stringify(voicePaths),
    }, environmentBindings: [
      { name: "DISCORD_E2E_SLA_MEETING_ID", valueFrom: { actionRef: recordingReady[2]!, field: "meetingId" } },
      { name: "DISCORD_E2E_SLA_RECORDING_ID", valueFrom: { actionRef: recordingReady[2]!, field: "recordingId" } },
    ], produces: [produced(reconnect, serviceLevelSourcesReady.action, barrierPath("service-level-sources-ready"))],
    requires: [recordingReady[2]!, playbackLinkSeen, supplementalCompleted, conversationCompleted],
    startBefore: { ...serviceLevelSourcesReady, kind: "barrier" },
  };
  const serviceLevelsPath = paths.run(3, "service-levels.json");
  const serviceLevelsReport = paths.run(3, "service-levels-report.json");
  const serviceLevels: HostedCampaignExecutableSpec = {
    arguments: { kind: "environment" }, childId: "service-levels",
    completion: { action: serviceLevelsReady.action, campaignId: definition.campaignId, kind: "service-levels", outputPath: serviceLevelsPath, reportPath: serviceLevelsReport, runId: reconnect.runId },
    entrypoint: "service-levels", environment: {
      DISCORD_E2E_SLA_CAMPAIGN_ID: definition.campaignId,
      DISCORD_E2E_SLA_CAMPAIGN_PROOF_INPUT: paths.campaignProof,
      DISCORD_E2E_SLA_CLOCK_ATTESTATIONS_INPUT: sourcePaths.clock,
      DISCORD_E2E_SLA_DATABASE_INPUT: sourcePaths.database,
      DISCORD_E2E_SLA_FIXTURE_MANIFEST_INPUT: definition.fixtureManifestPath,
      DISCORD_E2E_SLA_MEETING_PLATFORM_LOG_INPUT: sourcePaths.logs,
      DISCORD_E2E_SLA_OUTPUT: serviceLevelsPath,
      DISCORD_E2E_SLA_PLAYBACK_LINK_PROOF_INPUT: paths.run(3, "playback-link.json"),
      DISCORD_E2E_SLA_READY_RECEIPT_INPUT: paths.run(3, "recording-ready.json"),
      DISCORD_E2E_SLA_REPORT_OUTPUT: serviceLevelsReport, DISCORD_E2E_SLA_RUN_ID: reconnect.runId,
      DISCORD_E2E_SLA_S3_INPUT: sourcePaths.s3,
      DISCORD_E2E_SLA_SUPPLEMENTAL_PLAYBACK_INPUT: paths.run(3, "supplemental.json"),
      DISCORD_E2E_SLA_VOICE_INPUTS: JSON.stringify(voicePaths),
    }, environmentBindings: [
      { name: "DISCORD_E2E_SLA_MEETING_ID", valueFrom: { actionRef: recordingReady[2]!, field: "meetingId" } },
      { name: "DISCORD_E2E_SLA_RECORDING_ID", valueFrom: { actionRef: recordingReady[2]!, field: "recordingId" } },
    ], produces: [produced(reconnect, serviceLevelsReady.action, barrierPath("service-levels-ready"))],
    requires: [recordingReady[2]!, serviceLevelSourcesReady], startBefore: { ...serviceLevelsReady, kind: "barrier" },
  };
  const collector = (
    run: HostedCampaignRun & { readonly ordinal: 1 | 2 | 3 },
    action: HostedCampaignActionReference & { readonly action: Extract<HostedCampaignBarrierAction, { readonly kind: "run-verified" }> },
    binding: typeof sequentialBinding,
    required: readonly HostedCampaignActionReference[],
  ): HostedCampaignExecutableSpec => {
    const evidencePath = paths.run(run.ordinal, "evidence.json");
    return {
      arguments: { kind: "environment" }, childId: `collector-${run.ordinal}`,
      completion: { action: action.action, evidencePath, kind: "collector", runId: run.runId },
      entrypoint: "collector", environment: {
        ...remote, ...revisions, DISCORD_E2E_ACTOR_RUN_INPUT: paths.run(run.ordinal, "actor.json"),
        DISCORD_E2E_EVIDENCE_OUTPUT: evidencePath, DISCORD_E2E_FIXTURE_MANIFEST: definition.fixtureManifestPath,
        DISCORD_E2E_READY_RECEIPT_INPUT: paths.run(run.ordinal, "recording-ready.json"),
        DISCORD_E2E_RECORDING_PLAYBACK_ORIGIN: definition.recordingPlaybackOrigin,
        DISCORD_E2E_RECORDING_PLAYBACK_READINESS: "already-ready", DISCORD_E2E_RECORDING_PLAYBACK_TEST_SCOPE: "private-test-deployment",
        DISCORD_E2E_REMOTE_ATTESTATION_FILE: binding.remoteAttestationPath, DISCORD_E2E_RUN_ID: run.runId,
        DISCORD_E2E_SECRET_DIRECTORY: definition.secretDirectory,
        ...(run.ordinal === 3 ? {
          DISCORD_E2E_BOTIK_SPEAKER_ID: HOSTED_CAMPAIGN_TARGET.botikApplicationId,
          DISCORD_E2E_CONVERSATION_CAMPAIGN_PROOF_INPUT: paths.campaignProof,
          DISCORD_E2E_CONVERSATION_VOICE_INPUTS: JSON.stringify(voicePaths),
          DISCORD_E2E_DISCORD_PLAYBACK_LINK_PROOF_INPUT: paths.run(3, "playback-link.json"),
          DISCORD_E2E_SERVICE_LEVELS_INPUT: serviceLevelsPath,
          DISCORD_E2E_SERVICE_LEVEL_THRESHOLDS_INPUT: definition.serviceLevelThresholdsPath,
          DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_INPUT: paths.run(3, "supplemental.json"),
        } : {}),
      }, produces: [produced(run, action.action, barrierPath(`run-${run.ordinal}-verified`))], requires: required,
      startBefore: { ...action, kind: "barrier" },
    };
  };
  const campaignVerifier: HostedCampaignExecutableSpec = {
    arguments: {
      evidencePaths: [paths.run(1, "evidence.json"), paths.run(2, "evidence.json"), paths.run(3, "evidence.json")],
      kind: "campaign-verifier", manifestPath: definition.fixtureManifestPath, thresholdsPath: definition.serviceLevelThresholdsPath,
    }, childId: "campaign-verifier", completion: {
      action: { kind: "campaign-verified" }, campaignId: definition.campaignId, kind: "campaign-verifier", runIds: definition.runIds,
    }, entrypoint: "campaign-verifier", environment: revisions,
    produces: [produced(reconnect, campaignVerified.action, barrierPath("campaign-verified"))],
    requires: [provenanceAfter], startBefore: { ...campaignVerified, kind: "barrier" },
  };
  return Object.freeze([
    actor(sequential, provenanceBefore), actor(overlap, runVerified[0]!), actor(reconnect, captures[0]!, supplementalCompleted),
    provenance("before", sequential, provenanceBefore), readyCollector(sequential), replayAttestation(sequential),
    collector(sequential, runVerified[0]!, sequentialBinding, [provenanceBefore, recordingReady[0]!, replayAttestationReady[0]!, reference(sequential, { kind: "actor-completed", ordinal: 1, runId: sequential.runId })]),
    readyCollector(overlap), replayAttestation(overlap), collector(overlap, runVerified[1]!, overlapBinding, [runVerified[0]!, recordingReady[1]!, replayAttestationReady[1]!, reference(overlap, { kind: "actor-completed", ordinal: 2, runId: overlap.runId })]),
    conversationObserver, supplemental, readyCollector(reconnect), replayAttestation(reconnect), playbackObserver, serviceLevelSources, serviceLevels,
    collector(reconnect, runVerified[2]!, reconnectBinding, [recordingReady[2]!, replayAttestationReady[2]!, playbackLinkSeen, serviceLevelsReady, conversationCompleted, supplementalCompleted]),
    provenance("after", reconnect, provenanceAfter), campaignVerifier,
  ]);
}
