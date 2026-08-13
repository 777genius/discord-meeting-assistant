import { isAbsolute } from "node:path";

import { waitForActorGateArmed } from "./actor-release-gate.js";
import type { HostedCampaignArtifactStore } from "./hosted-campaign-artifact-store.js";
import type {
  HostedCampaignBoundedSignal,
  HostedCampaignExecutableSpec,
} from "./hosted-campaign-coordinator.js";
import { HOSTED_CAMPAIGN_TARGET } from "./hosted-campaign-coordinator.js";
import {
  waitForSupplementalGateArmed,
  writeSupplementalPlaybackGate,
} from "./supplemental-playback-gate.js";

export type HostedActorGatePhase = "connection" | "speaker-b" | "playback" | "end";

export async function publishHostedActorGate(input: {
  readonly artifactStore: HostedCampaignArtifactStore;
  readonly bounded: HostedCampaignBoundedSignal;
  readonly phase: HostedActorGatePhase;
  readonly spec: HostedCampaignExecutableSpec;
}): Promise<void> {
  const { artifactStore, bounded, phase, spec } = input;
  assertActive(bounded);
  const staged = phase === "connection" ? spec.releaseGate
    : phase === "speaker-b" ? spec.actorGates?.speakerB : spec.actorGates?.[phase];
  const path = staged?.path;
  const campaignId = spec.environment.DISCORD_E2E_HOSTED_RELEASE_GATE_CAMPAIGN_ID;
  const runId = spec.environment.DISCORD_E2E_RUN_ID;
  const scenario = spec.environment.DISCORD_E2E_SCENARIO;
  if (path === undefined || !isAbsolute(path) || campaignId === undefined || runId === undefined
    || !new Set(["sequential", "overlap", "reconnect"]).has(scenario ?? "")) {
    throw new Error(`Hosted campaign actor ${spec.childId} has an incomplete release gate contract`);
  }
  if (staged?.armedPath === undefined) {
    throw new Error(`Hosted campaign actor ${spec.childId} has no armed receipt for ${phase}`);
  }
  await waitForActorGateArmed({
    armedPath: staged.armedPath, campaignId, path, phase, runId,
    scenario: scenario as "overlap" | "reconnect" | "sequential",
  }, bounded.signal);
  assertActive(bounded);
  await artifactStore.writeCreateOnly(path, {
    schemaVersion: 1, campaignId, runId, scenario, phase, releasedAtEpochMs: Date.now(),
    target: { guildId: HOSTED_CAMPAIGN_TARGET.guildId, voiceChannelId: HOSTED_CAMPAIGN_TARGET.voiceChannelId,
      mutationTarget: HOSTED_CAMPAIGN_TARGET.mutationTarget },
  });
}

export async function publishHostedSupplementalGate(input: {
  readonly bounded: HostedCampaignBoundedSignal;
  readonly phase: "connection" | "playback";
  readonly spec: HostedCampaignExecutableSpec;
}): Promise<void> {
  const { bounded, phase, spec } = input;
  assertActive(bounded);
  const gate = spec.supplementalGates?.[phase];
  const campaignId = spec.environment.DISCORD_E2E_SUPPLEMENTAL_CAMPAIGN_ID;
  const runId = spec.environment.DISCORD_E2E_SUPPLEMENTAL_RUN_ID;
  if (gate === undefined || campaignId === undefined || runId === undefined) {
    throw new Error(`Hosted supplemental player ${spec.childId} has an incomplete ${phase} gate`);
  }
  await waitForSupplementalGateArmed({
    armedPath: gate.armedPath, campaignId, guildId: HOSTED_CAMPAIGN_TARGET.guildId,
    path: gate.path, phase, runId, voiceChannelId: HOSTED_CAMPAIGN_TARGET.voiceChannelId,
  }, boundedSignal(bounded));
  assertActive(bounded);
  await writeSupplementalPlaybackGate({
    armedPath: gate.armedPath, campaignId, guildId: HOSTED_CAMPAIGN_TARGET.guildId,
    path: gate.path, phase, releasedAtEpochMs: Date.now(), runId, schemaVersion: 1,
    voiceChannelId: HOSTED_CAMPAIGN_TARGET.voiceChannelId,
  });
}

function assertActive(bounded: HostedCampaignBoundedSignal): void {
  if (bounded.signal.aborted) {
    throw bounded.signal.reason ?? new Error("Hosted campaign cancelled");
  }
  if (Date.now() >= bounded.deadlineEpochMilliseconds) {
    throw new Error("Hosted campaign deadline expired");
  }
}

function boundedSignal(bounded: HostedCampaignBoundedSignal): AbortSignal {
  const remaining = bounded.deadlineEpochMilliseconds - Date.now();
  if (remaining <= 0) {return AbortSignal.abort(new Error("Hosted campaign deadline expired"));}
  return AbortSignal.any([bounded.signal, AbortSignal.timeout(remaining)]);
}
