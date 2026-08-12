import type { HostedCampaignExecutableSpec } from "./hosted-campaign-coordinator.js";
import { type HostedCampaignChildContext, produced } from "./hosted-campaign-plan-child-context.js";

interface ServiceLevelPaths {
  readonly clock: string;
  readonly database: string;
  readonly levels: string;
  readonly levelsReport: string;
  readonly logs: string;
  readonly report: string;
  readonly s3: string;
}

export function makeServiceLevelPaths(context: HostedCampaignChildContext): ServiceLevelPaths {
  const { paths } = context;
  return {
    clock: paths.run(3, "sla-clock.json"), database: paths.run(3, "sla-database.json"),
    levels: paths.run(3, "service-levels.json"), levelsReport: paths.run(3, "service-levels-report.json"),
    logs: paths.run(3, "sla-meeting-platform-logs.json"), report: paths.run(3, "sla-sources-report.json"),
    s3: paths.run(3, "sla-s3.json"),
  };
}

export function makeServiceLevelSources(
  context: HostedCampaignChildContext,
  sourcePaths: ServiceLevelPaths,
): HostedCampaignExecutableSpec {
  const {
    barrierPath, conversationCompleted, definition, paths, playbackLinkSeen, reconnect, recordingReady,
    remote, serviceLevelSourcesReady, supplementalCompleted, voicePaths,
  } = context;
  return {
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
}

export function makeServiceLevels(
  context: HostedCampaignChildContext,
  sourcePaths: ServiceLevelPaths,
): HostedCampaignExecutableSpec {
  const { barrierPath, definition, paths, reconnect, recordingReady, serviceLevelSourcesReady, serviceLevelsReady, voicePaths } = context;
  return {
    arguments: { kind: "environment" }, childId: "service-levels",
    completion: { action: serviceLevelsReady.action, campaignId: definition.campaignId, kind: "service-levels", outputPath: sourcePaths.levels, reportPath: sourcePaths.levelsReport, runId: reconnect.runId },
    entrypoint: "service-levels", environment: {
      DISCORD_E2E_SLA_CAMPAIGN_ID: definition.campaignId,
      DISCORD_E2E_SLA_CAMPAIGN_PROOF_INPUT: paths.campaignProof,
      DISCORD_E2E_SLA_CLOCK_ATTESTATIONS_INPUT: sourcePaths.clock,
      DISCORD_E2E_SLA_DATABASE_INPUT: sourcePaths.database,
      DISCORD_E2E_SLA_FIXTURE_MANIFEST_INPUT: definition.fixtureManifestPath,
      DISCORD_E2E_SLA_MEETING_PLATFORM_LOG_INPUT: sourcePaths.logs,
      DISCORD_E2E_SLA_OUTPUT: sourcePaths.levels,
      DISCORD_E2E_SLA_PLAYBACK_LINK_PROOF_INPUT: paths.run(3, "playback-link.json"),
      DISCORD_E2E_SLA_READY_RECEIPT_INPUT: paths.run(3, "recording-ready.json"),
      DISCORD_E2E_SLA_REPORT_OUTPUT: sourcePaths.levelsReport, DISCORD_E2E_SLA_RUN_ID: reconnect.runId,
      DISCORD_E2E_SLA_S3_INPUT: sourcePaths.s3,
      DISCORD_E2E_SLA_SUPPLEMENTAL_PLAYBACK_INPUT: paths.run(3, "supplemental.json"),
      DISCORD_E2E_SLA_VOICE_INPUTS: JSON.stringify(voicePaths),
    }, environmentBindings: [
      { name: "DISCORD_E2E_SLA_MEETING_ID", valueFrom: { actionRef: recordingReady[2]!, field: "meetingId" } },
      { name: "DISCORD_E2E_SLA_RECORDING_ID", valueFrom: { actionRef: recordingReady[2]!, field: "recordingId" } },
    ], produces: [produced(reconnect, serviceLevelsReady.action, barrierPath("service-levels-ready"))],
    requires: [recordingReady[2]!, serviceLevelSourcesReady], startBefore: { ...serviceLevelsReady, kind: "barrier" },
  };
}
