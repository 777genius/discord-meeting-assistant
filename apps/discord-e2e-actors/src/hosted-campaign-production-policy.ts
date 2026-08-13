import type { HostedRemoteAdmissionCompositionConfig } from "./hosted-remote-admission-composition.js";
import {
  COMPILED_HOSTED_CAMPAIGN_RELEASE_TRUST_ROOT,
  createHostedCampaignReleaseConfig,
  type HostedCampaignReleaseTrustRootV1,
} from "./hosted-campaign-release-binding.js";

export const HOSTED_CAMPAIGN_PRODUCTION_POLICY = Object.freeze({
  kind: "hosted-campaign-production-policy",
  schemaVersion: 1,
} as const satisfies HostedCampaignProductionPolicy);

export interface HostedCampaignProductionTrustBinding {
  createConfig(candidate: HostedCampaignProductionCandidate): HostedRemoteAdmissionCompositionConfig;
}

export interface HostedCampaignProductionPolicy {
  readonly kind: "hosted-campaign-production-policy";
  readonly schemaVersion: 1;
  readonly trustBinding?: HostedCampaignProductionTrustBinding;
}

export function createHostedCampaignProductionPolicy(
  releaseBinding: unknown,
  trustRoot: HostedCampaignReleaseTrustRootV1 | undefined = COMPILED_HOSTED_CAMPAIGN_RELEASE_TRUST_ROOT,
): HostedCampaignProductionPolicy {
  if (releaseBinding === undefined || trustRoot === undefined) {
    return HOSTED_CAMPAIGN_PRODUCTION_POLICY;
  }
  return Object.freeze({
    kind: "hosted-campaign-production-policy",
    schemaVersion: 1,
    trustBinding: Object.freeze({
      createConfig: (candidate: HostedCampaignProductionCandidate) =>
        createHostedCampaignReleaseConfig(releaseBinding, trustRoot, candidate),
    }),
  });
}

export interface HostedCampaignProductionCandidate {
  readonly bindings: unknown;
  readonly campaignId: string;
  readonly definition: unknown;
  readonly meetingPlatformRevision: string;
  readonly plan: unknown;
  readonly planSha256: string;
}
