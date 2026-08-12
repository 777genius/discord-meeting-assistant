export const HOSTED_CAMPAIGN_TARGET = {
  environment: "private-test-guild", mutationTarget: "test-only", deploymentScope: "private-test-deployment",
  host: "codex-workers-eu-01", project: "discord-meeting-assistant", craigProject: "craig-meeting-e2e",
  guildId: "1533228590643155034", voiceChannelId: "1533228823045214398",
  publicationChannelId: "1533228891827736657", sutApplicationId: "1533224474609057793",
  speakerAApplicationId: "1533227577286852649", speakerBApplicationId: "1533228054724346087",
  observerApplicationId: "1533867700575670282", speakerDApplicationId: "1533873978417086474",
  botikApplicationId: "1534231284467896512",
} as const;

export type HostedCampaignTarget = typeof HOSTED_CAMPAIGN_TARGET;
