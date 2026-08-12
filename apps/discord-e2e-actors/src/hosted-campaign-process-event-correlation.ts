import type { HostedCampaignExecutableSpec } from "./hosted-campaign-coordinator.js";

export function expectedHostedCampaignEventCorrelation(spec: HostedCampaignExecutableSpec): {
  readonly campaignId: string;
  readonly runId: string;
} {
  const campaignId = spec.environment.DISCORD_E2E_HOSTED_CAMPAIGN_ID ??
    spec.environment.DISCORD_E2E_HOSTED_RELEASE_GATE_CAMPAIGN_ID;
  const runId = spec.environment.DISCORD_E2E_CONVERSATION_VOICE_RUN_ID ??
    spec.environment.DISCORD_E2E_RUN_ID;
  if (campaignId === undefined || runId === undefined) {
    throw new Error(`Hosted campaign child ${spec.childId} has no exact event correlation`);
  }
  return { campaignId, runId };
}
