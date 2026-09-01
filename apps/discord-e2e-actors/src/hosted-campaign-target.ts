export const HOSTED_CAMPAIGN_TARGET = {
  environment: "private-test-guild", mutationTarget: "test-only", deploymentScope: "private-test-deployment",
  host: "codex-workers-eu-01", project: "discord-meeting-assistant", craigProject: "craig-meeting-e2e",
  guildId: "1533228590643155034", voiceChannelId: "1533228823045214398",
  publicationChannelId: "1533228891827736657", sutApplicationId: "1533224474609057793",
  speakerAApplicationId: "1533227577286852649", speakerBApplicationId: "1533228054724346087",
  observerApplicationId: "1533867700575670282", speakerDApplicationId: "1533873978417086474",
  botikApplicationId: "1533877611258708230",
} as const;

export type HostedCampaignTarget = Omit<typeof HOSTED_CAMPAIGN_TARGET, "craigProject"> & {
  readonly craigProject: string;
};

export function hostedCampaignTargetForCraigProject(craigProject: string): HostedCampaignTarget {
  if (!/^craig-e2e-[a-f\d]{20}$/u.test(craigProject) && craigProject !== HOSTED_CAMPAIGN_TARGET.craigProject) {
    throw new Error("Hosted campaign Craig project is not a canonical campaign project");
  }
  return Object.freeze({ ...HOSTED_CAMPAIGN_TARGET, craigProject });
}

export function resolveHostedCampaignCraigProject(definition: Readonly<{
  campaignId: string;
  craigProject?: string | undefined;
  craigRelease?: HostedCampaignReleaseReferenceV1 | undefined;
}>): string {
  if (definition.craigRelease !== undefined) {
    return craigProjectName(definition.campaignId, definition.craigRelease);
  }
  return definition.craigProject ?? HOSTED_CAMPAIGN_TARGET.craigProject;
}
import { craigProjectName } from "./craig-disposable-campaign-stack.js";
import type { HostedCampaignReleaseReferenceV1 } from "./hosted-campaign-release-reference.js";
