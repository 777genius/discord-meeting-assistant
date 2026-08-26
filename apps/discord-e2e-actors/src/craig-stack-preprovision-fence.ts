import type { parseHostedCampaignPlan } from "./hosted-campaign-run-config.js";
import { hostedCampaignDefinitionV1Schema } from "./hosted-campaign-plan-builder.js";
import type { HostedCampaignReleaseReferenceV1 } from "./hosted-campaign-release-reference.js";
import type { PlannedCraigCampaignStackV1 } from "./craig-disposable-campaign-stack.js";

export function assertPlannedCraigStackMatchesHostedCampaign(
  definitionValue: unknown,
  plan: ReturnType<typeof parseHostedCampaignPlan>,
  release: HostedCampaignReleaseReferenceV1 | undefined,
  craig: PlannedCraigCampaignStackV1 | undefined,
  provisioningEnabled: boolean,
): void {
  if (!provisioningEnabled && craig === undefined) { return; }
  const definition = hostedCampaignDefinitionV1Schema.parse(definitionValue);
  const campaignIds = new Set(plan.runs.map(({ campaignId }) => campaignId));
  const campaignId = campaignIds.size === 1 ? [...campaignIds][0] : undefined;
  if (release === undefined || craig === undefined || campaignId === undefined
    || definition.craigRelease === undefined
    || JSON.stringify(definition.craigRelease) !== JSON.stringify(release)
    || craig.campaignId !== campaignId || craig.projectName !== plan.target.craigProject
    || JSON.stringify(craig.release) !== JSON.stringify(release)) {
    throw new Error("Craig stack plan/release does not match the compiled hosted campaign before provisioning");
  }
}
