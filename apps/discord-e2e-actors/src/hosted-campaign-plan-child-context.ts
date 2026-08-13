import { join, normalize, relative } from "node:path";

import {
  HOSTED_CAMPAIGN_TARGET,
  type HostedCampaignActionReference,
  type HostedCampaignBarrierAction,
  type HostedCampaignRun,
} from "./hosted-campaign-coordinator.js";
import type {
  HostedCampaignDefinitionV1,
  HostedCampaignRuntimeBindingsV1,
} from "./hosted-campaign-plan-builder.js";

export type FixedHostedCampaignRun<Ordinal extends 1 | 2 | 3> = HostedCampaignRun & { readonly ordinal: Ordinal };
export type HostedCampaignRuns = readonly [
  FixedHostedCampaignRun<1>, FixedHostedCampaignRun<2>, FixedHostedCampaignRun<3>,
];

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

export function reference<Action extends HostedCampaignActionReference["action"]>(
  run: HostedCampaignRun,
  action: Action,
): HostedCampaignActionReference & { readonly action: Action } {
  return { action, ordinal: run.ordinal, runId: run.runId };
}

function runVerifiedReference(run: HostedCampaignRun): HostedCampaignActionReference & {
  readonly action: Extract<HostedCampaignBarrierAction, { readonly kind: "run-verified" }>;
} {
  return {
    action: { kind: "run-verified", ordinal: run.ordinal, runId: run.runId },
    ordinal: run.ordinal,
    runId: run.runId,
  };
}

function provenanceReference(
  run: HostedCampaignRun,
  phase: "after" | "before",
): HostedCampaignActionReference & {
  readonly action: { readonly kind: "provenance-after" | "provenance-before" };
} {
  return {
    action: { kind: phase === "before" ? "provenance-before" : "provenance-after" },
    ordinal: run.ordinal,
    runId: run.runId,
  };
}

export function produced(
  run: HostedCampaignRun,
  action: HostedCampaignActionReference["action"],
  outputPath: string,
) {
  return { ...reference(run, action), outputPath };
}

export function makeHostedCampaignChildContext(
  definition: HostedCampaignDefinitionV1,
  bindings: HostedCampaignRuntimeBindingsV1,
  runs: HostedCampaignRuns,
  campaignRoot: string,
) {
  const ownedRoot = safeJoin(campaignRoot, definition.campaignId);
  const paths: CampaignPaths = Object.freeze({
    artifactRoot: safeJoin(ownedRoot, "barriers"),
    campaignProof: safeJoin(ownedRoot, "campaign-proof.json"),
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
  const captures = Array.from({ length: 6 }, (_, index) =>
    reference(reconnect, { kind: "capture-retained", ordinal: index + 1 }));
  const reconnectLeft = reference(reconnect, { kind: "reconnect-left" });
  const reconnectReady = reference(reconnect, { kind: "reconnect-ready" });
  const actorPlaybackCompleted = reference(reconnect, { kind: "actor-scenario-playback-completed" });
  const answerIntent = reference(reconnect, { kind: "answer-intent" });
  const answerObserverReady = reference(reconnect, { kind: "answer-observer-ready" });
  const answerFirstPacket = reference(reconnect, { kind: "answer-first-packet" });
  const conversationCompleted = reference(reconnect, {
    kind: "conversation-observer-completed", ordinal: 3, runId: reconnect.runId,
  });
  const supplementalCompleted = reference(reconnect, {
    kind: "supplemental-completed", ordinal: 3, runId: reconnect.runId,
  });
  const recordingReady = runs.map((run) => reference(run, {
    kind: "recording-ready", ordinal: run.ordinal, runId: run.runId,
  }));
  const replayAttestationReady = runs.map((run) => reference(run, {
    kind: "replay-attestation-ready", ordinal: run.ordinal, runId: run.runId,
  }));
  const playbackLinkSeen = reference(reconnect, {
    kind: "playback-link-seen", ordinal: 3, runId: reconnect.runId,
  });
  const serviceLevelSourcesReady = reference(reconnect, { kind: "service-level-sources-ready" });
  const serviceLevelsReady = reference(reconnect, { kind: "service-levels-ready" });
  const voicePaths = captures.map((_, index) => paths.run(3, `capture-${index + 1}.json`)) as
    [string, string, string, string, string, string];

  return {
    actorPlaybackCompleted, answerFirstPacket, answerIntent, answerObserverReady, barrierPath, bindings,
    campaignVerified, captures, conversationCompleted, definition, observerSubscribed, overlap,
    overlapBinding, paths, playbackLinkSeen, provenanceAfter, provenanceBefore, reconnect,
    reconnectBinding, reconnectLeft, reconnectReady, recordingReady, remote, replayAttestationReady,
    revisions, runVerified, runs, sequential, sequentialBinding, serviceLevelSourcesReady,
    serviceLevelsReady, supplementalCompleted, voicePaths,
  };
}

export type HostedCampaignChildContext = ReturnType<typeof makeHostedCampaignChildContext>;
