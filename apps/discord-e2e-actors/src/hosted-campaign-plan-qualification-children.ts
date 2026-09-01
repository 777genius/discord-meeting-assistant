import type { HostedCampaignExecutableSpec } from "./hosted-campaign-coordinator.js";
import {
  type HostedCampaignChildContext,
  produced,
} from "./hosted-campaign-plan-child-context.js";

export function makeGreetingLedgerObserver(
  context: HostedCampaignChildContext,
): HostedCampaignExecutableSpec {
  const {
    barrierPath, captures, definition, greetingLedgerReady,
    paths, reconnect, remote, voicePaths,
  } = context;
  const outputPath = paths.greetingLedger;
  return {
    arguments: { kind: "environment" },
    childId: "greeting-ledger-observer",
    completion: {
      action: greetingLedgerReady.action,
      kind: "greeting-ledger-observer",
      outputPath,
      runId: reconnect.runId,
    },
    completionAfter: captures[5]!,
    entrypoint: "greeting-ledger-observer",
    environment: {
      DISCORD_E2E_GREETING_LEDGER_CAMPAIGN_ID: definition.campaignId,
      DISCORD_E2E_GREETING_LEDGER_CAMPAIGN_PROOF_INPUT: paths.campaignProof,
      DISCORD_E2E_GREETING_LEDGER_CAPTURE_INPUTS: JSON.stringify(voicePaths.slice(0, 4)),
      DISCORD_E2E_GREETING_LEDGER_MUTATION_TARGET: "private-test-guild",
      DISCORD_E2E_GREETING_LEDGER_OUTPUT: outputPath,
      DISCORD_E2E_GREETING_LEDGER_REMOTE_COMPOSE_FILE: remote.DISCORD_E2E_REMOTE_COMPOSE_FILE,
      DISCORD_E2E_GREETING_LEDGER_REMOTE_ENV_FILE: remote.DISCORD_E2E_REMOTE_ENV_FILE,
      DISCORD_E2E_GREETING_LEDGER_REMOTE_HOST: remote.DISCORD_E2E_REMOTE_HOST,
      DISCORD_E2E_GREETING_LEDGER_REMOTE_SOURCE_ROOT: remote.DISCORD_E2E_REMOTE_SOURCE_ROOT,
      DISCORD_E2E_GREETING_LEDGER_REMOTE_TIMEOUT_MS: "60000",
      DISCORD_E2E_GREETING_LEDGER_RUN_ID: reconnect.runId,
    },
    produces: [produced(reconnect, greetingLedgerReady.action, barrierPath("greeting-ledger-ready"))],
    requires: [captures[0]!, captures[1]!, captures[2]!, captures[3]!, captures[4]!],
    startBefore: { ...captures[5]!, kind: "barrier" },
  };
}

export function makeLiveMemoryObserver(
  context: HostedCampaignChildContext,
): HostedCampaignExecutableSpec {
  const { barrierPath, definition, historicalReplyInputReady, liveMemoryReady,
    paths, reconnect, remote } = context;
  return {
    arguments: { kind: "environment" }, childId: "live-memory-observer",
    completion: { action: liveMemoryReady.action, kind: "live-memory-observer",
      outputPath: paths.liveMemory, runId: reconnect.runId },
    completionAfter: historicalReplyInputReady,
    entrypoint: "live-memory-observer",
    environment: {
      DISCORD_E2E_LIVE_MEMORY_CAMPAIGN_ID: definition.campaignId,
      DISCORD_E2E_LIVE_MEMORY_CAMPAIGN_PROOF_INPUT: paths.campaignProof,
      DISCORD_E2E_LIVE_MEMORY_MUTATION_TARGET: "private-test-guild",
      DISCORD_E2E_LIVE_MEMORY_OUTPUT: paths.liveMemory,
      DISCORD_E2E_LIVE_MEMORY_POLL_INTERVAL_MS: "250",
      DISCORD_E2E_LIVE_MEMORY_REMOTE_COMPOSE_FILE: remote.DISCORD_E2E_REMOTE_COMPOSE_FILE,
      DISCORD_E2E_LIVE_MEMORY_REMOTE_ENV_FILE: remote.DISCORD_E2E_REMOTE_ENV_FILE,
      DISCORD_E2E_LIVE_MEMORY_REMOTE_HOST: remote.DISCORD_E2E_REMOTE_HOST,
      DISCORD_E2E_LIVE_MEMORY_REMOTE_SOURCE_ROOT: remote.DISCORD_E2E_REMOTE_SOURCE_ROOT,
      DISCORD_E2E_LIVE_MEMORY_RUN_ID: reconnect.runId,
      DISCORD_E2E_LIVE_MEMORY_TIMEOUT_MS: "2700000",
    },
    produces: [produced(reconnect, liveMemoryReady.action, barrierPath("live-memory-ready"))],
    requires: [],
    startBefore: { kind: "campaign" },
  };
}

export function makeHistoricalReplyPreparer(
  context: HostedCampaignChildContext,
): HostedCampaignExecutableSpec {
  const { barrierPath, definition, historicalReplyInputReady, paths, reconnect, remote,
    runVerified } = context;
  return {
    arguments: { kind: "environment" }, childId: "historical-reply-preparer",
    completion: { action: historicalReplyInputReady.action, kind: "historical-reply-preparer",
      outputPath: paths.historicalReplyInput, runId: reconnect.runId },
    completionAfter: runVerified[2]!, entrypoint: "historical-reply-preparer",
    environment: {
      DISCORD_E2E_HISTORICAL_PREP_ARM_OUTPUT: paths.run(3, "public-reply-effect.arm.json"),
      DISCORD_E2E_HISTORICAL_PREP_CAMPAIGN_ID: definition.campaignId,
      DISCORD_E2E_HISTORICAL_PREP_EVIDENCE_INPUT: paths.run(3, "evidence.json"),
      DISCORD_E2E_HISTORICAL_PREP_LATE_GREETING_INPUT: paths.lateGreeting,
      DISCORD_E2E_HISTORICAL_PREP_MUTATION_TARGET: "private-test-guild",
      DISCORD_E2E_HISTORICAL_PREP_OBSERVATION_POLICY:
        JSON.stringify(definition.historicalReplyObservationPolicy),
      DISCORD_E2E_HISTORICAL_PREP_OUTPUT: paths.historicalReplyInput,
      DISCORD_E2E_HISTORICAL_PREP_REMOTE_COMPOSE_FILE: remote.DISCORD_E2E_REMOTE_COMPOSE_FILE,
      DISCORD_E2E_HISTORICAL_PREP_REMOTE_ENV_FILE: remote.DISCORD_E2E_REMOTE_ENV_FILE,
      DISCORD_E2E_HISTORICAL_PREP_REMOTE_HOST: remote.DISCORD_E2E_REMOTE_HOST,
      DISCORD_E2E_HISTORICAL_PREP_REMOTE_SOURCE_ROOT: remote.DISCORD_E2E_REMOTE_SOURCE_ROOT,
      DISCORD_E2E_HISTORICAL_PREP_RECORDING_READY_INPUT:
        paths.run(3, "recording-ready.json"),
      DISCORD_E2E_HISTORICAL_PREP_RUN_ID: reconnect.runId,
      DISCORD_E2E_HISTORICAL_PREP_TIMEOUT_MS: "300000",
      ...(definition.historicalReplyTemplatePath === undefined ? {} : {
        DISCORD_E2E_HISTORICAL_PREP_V2_TEMPLATE_INPUT:
          definition.historicalReplyTemplatePath,
      }),
    },
    produces: [produced(reconnect, historicalReplyInputReady.action,
      barrierPath("historical-reply-input-ready"))],
    requires: [], startBefore: { ...runVerified[2]!, kind: "barrier" },
  };
}

export function makeHistoricalReplyObserver(
  context: HostedCampaignChildContext,
): HostedCampaignExecutableSpec {
  const { barrierPath, definition, historicalReplyInputReady, historicalReplyReady,
    paths, reconnect, remote } = context;
  return {
    arguments: { kind: "environment" }, childId: "historical-reply-observer",
    completion: { action: historicalReplyReady.action, kind: "historical-reply-observer",
      outputPath: paths.historicalReply, runId: reconnect.runId },
    completionAfter: historicalReplyInputReady, entrypoint: "historical-reply-observer",
    environment: {
      DISCORD_E2E_HISTORICAL_REPLY_ANSWER_TIMEOUT_MS: "60000",
      DISCORD_E2E_HISTORICAL_REPLY_CRASH_RECEIPT_INPUT:
        paths.run(3, "public-reply-effect.triggered.json"),
      DISCORD_E2E_HISTORICAL_REPLY_INPUT: paths.historicalReplyInput,
      DISCORD_E2E_HISTORICAL_REPLY_MUTATION_TARGET: "private-test-guild",
      DISCORD_E2E_HISTORICAL_REPLY_OBSERVER_ACCOUNT: "conversation-observer",
      DISCORD_E2E_HISTORICAL_REPLY_OUTPUT: paths.historicalReply,
      DISCORD_E2E_HISTORICAL_REPLY_POLL_INTERVAL_MS: "1000",
      DISCORD_E2E_HISTORICAL_REPLY_REMOTE_COMPOSE_FILE: remote.DISCORD_E2E_REMOTE_COMPOSE_FILE,
      DISCORD_E2E_HISTORICAL_REPLY_REMOTE_ENV_FILE: remote.DISCORD_E2E_REMOTE_ENV_FILE,
      DISCORD_E2E_HISTORICAL_REPLY_REMOTE_HOST: remote.DISCORD_E2E_REMOTE_HOST,
      DISCORD_E2E_HISTORICAL_REPLY_REMOTE_SOURCE_ROOT: remote.DISCORD_E2E_REMOTE_SOURCE_ROOT,
      DISCORD_E2E_HISTORICAL_REPLY_REMOTE_TIMEOUT_MS: "60000",
      DISCORD_E2E_HISTORICAL_REPLY_RUN_ID: reconnect.runId,
      DISCORD_E2E_HISTORICAL_REPLY_SECRET_DIRECTORY: definition.secretDirectory,
    },
    produces: [produced(reconnect, historicalReplyReady.action, barrierPath("historical-reply-ready"))],
    requires: [],
    startBefore: { ...historicalReplyInputReady, kind: "barrier" },
  };
}

export function makePrivateCoverageObserver(
  context: HostedCampaignChildContext,
): HostedCampaignExecutableSpec {
  const { barrierPath, definition, historicalReplyReady, liveMemoryReady, paths,
    privateCoverageReady, reconnect } = context;
  return {
    arguments: { kind: "environment" }, childId: "private-coverage-observer",
    completion: { action: privateCoverageReady.action, kind: "private-coverage-observer",
      outputPath: paths.privateCoverage, runId: reconnect.runId },
    completionAfter: historicalReplyReady,
    entrypoint: "private-coverage-observer",
    environment: {
      DISCORD_E2E_PRIVATE_COVERAGE_CAMPAIGN_ID: definition.campaignId,
      DISCORD_E2E_PRIVATE_COVERAGE_MUTATION_TARGET: "private-test-guild",
      DISCORD_E2E_PRIVATE_COVERAGE_OUTPUT: paths.privateCoverage,
      DISCORD_E2E_PRIVATE_COVERAGE_RUN_ID: reconnect.runId,
      DISCORD_E2E_PRIVATE_COVERAGE_SOURCE_INPUT: definition.privateCoverageSourcePath,
    },
    produces: [produced(reconnect, privateCoverageReady.action,
      barrierPath("private-coverage-ready"))],
    requires: [liveMemoryReady],
    startBefore: { ...historicalReplyReady, kind: "barrier" },
  };
}

export function makeRemediationBundle(
  context: HostedCampaignChildContext,
): HostedCampaignExecutableSpec {
  const { barrierPath, definition, paths, privateCoverageReady,
    reconnect, remediationBundleReady } = context;
  return {
    arguments: { kind: "environment" }, childId: "remediation-bundle",
    completion: { action: remediationBundleReady.action, kind: "remediation-bundle",
      outputPath: paths.thinRemediation, runId: reconnect.runId },
    completionAfter: privateCoverageReady, entrypoint: "remediation-bundle",
    environment: {
      DISCORD_E2E_REMEDIATION_BUNDLE_CAMPAIGN_ID: definition.campaignId,
      DISCORD_E2E_REMEDIATION_BUNDLE_GREETING_INPUT: paths.greetingLedger,
      DISCORD_E2E_REMEDIATION_BUNDLE_HISTORICAL_INPUT: paths.historicalReply,
      DISCORD_E2E_REMEDIATION_BUNDLE_LATE_GREETING_INPUT: paths.lateGreeting,
      DISCORD_E2E_REMEDIATION_BUNDLE_LIVE_MEMORY_INPUT: paths.liveMemory,
      DISCORD_E2E_REMEDIATION_BUNDLE_PRIVATE_COVERAGE_INPUT: paths.privateCoverage,
      DISCORD_E2E_REMEDIATION_BUNDLE_OUTPUT: paths.thinRemediation,
      DISCORD_E2E_REMEDIATION_BUNDLE_RECORDING_READY_INPUT:
        paths.run(3, "recording-ready.json"),
      DISCORD_E2E_REMEDIATION_BUNDLE_RUN_ID: reconnect.runId,
      DISCORD_E2E_REMEDIATION_BUNDLE_TIMEOUT_MS: "120000",
    },
    produces: [produced(reconnect, remediationBundleReady.action,
      barrierPath("remediation-bundle-ready"))],
    requires: [],
    startBefore: { ...privateCoverageReady, kind: "barrier" },
  };
}
