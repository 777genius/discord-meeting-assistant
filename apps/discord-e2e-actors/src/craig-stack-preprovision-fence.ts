import type { parseHostedCampaignPlan } from "./hosted-campaign-run-config.js";
import { hostedCampaignDefinitionV1Schema } from "./hosted-campaign-plan-builder.js";
import type { HostedCampaignReleaseReferenceV1 } from "./hosted-campaign-release-reference.js";
import type { PlannedCraigCampaignStackV1 } from "./craig-disposable-campaign-stack.js";
import { digestCraigCampaignStackCanonical } from "./craig-campaign-stack-digest.js";
import { craigProjectName, deriveCraigCampaignNetworkPolicy } from "./craig-campaign-network-plan.js";
import { join } from "node:path";

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
  const expectedRoot = campaignId === undefined ? undefined : join(definition.campaignRoot, campaignId);
  const expectedCredential = expectedRoot === undefined ? undefined : join(expectedRoot, "control", "craig.env");
  const expectedNetwork = campaignId === undefined || release === undefined || craig === undefined
    ? undefined
    : deriveCraigCampaignNetworkPolicy(campaignId, release, craig.networkPolicy.udpDestinationPorts);
  const { hostedPlanSha256, planSha256, ...plannedContent } = craig ?? {} as PlannedCraigCampaignStackV1;
  const expectedHostedPlanSha256 = digestCraigCampaignStackCanonical(plan);
  requireDefined(release); requireDefined(craig); requireDefined(campaignId);
  requireDefined(definition.craigRelease); requireDefined(expectedNetwork); requireDefined(expectedCredential);
  const actual = craig;
  const expected = { campaignId, campaignRoot: definition.campaignRoot,
    credentialAuthority: "compiled-release-sha256", credentialFile: expectedCredential,
    hostedPlanSha256: expectedHostedPlanSha256, networkPolicy: expectedNetwork,
    planSha256: digestCraigCampaignStackCanonical(plannedContent),
    projectName: craigProjectName(campaignId, release),
    release };
  const observed = { campaignId: actual.campaignId, campaignRoot: actual.campaignRoot,
    credentialAuthority: actual.credentialSecret?.authority, credentialFile: actual.credentialFile,
    hostedPlanSha256, networkPolicy: actual.networkPolicy, planSha256, projectName: actual.projectName,
    release: actual.release };
  if (digestCraigCampaignStackCanonical(observed) !== digestCraigCampaignStackCanonical(expected)
    || actual.projectName !== plan.target.craigProject
    || JSON.stringify(definition.craigRelease) !== JSON.stringify(release)
    || !/^(?!0{64})[a-f\d]{64}$/u.test(actual.credentialSecret?.sha256 ?? "")
    || !/^(?!0{64})[a-f\d]{64}$/u.test(planSha256 ?? "")) {
    throw new Error("Craig stack plan/release does not match the compiled hosted campaign before provisioning");
  }
}

function requireDefined<T>(value: T | undefined): asserts value is T {
  if (value === undefined) {
    throw new Error("Craig stack plan/release does not match the compiled hosted campaign before provisioning");
  }
}
