import type { HostedRemoteAdmissionCompositionConfig } from "./hosted-remote-admission-composition.js";

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

export interface HostedCampaignProductionCandidate {
  readonly bindings: unknown;
  readonly campaignId: string;
  readonly definition: unknown;
  readonly meetingPlatformRevision: string;
  readonly plan: unknown;
  readonly planSha256: string;
}

/** Explicit test/build seam. Never populate this policy from environment or campaign JSON. */
export function createFullyBoundHostedCampaignProductionPolicyForTest(
  trustBinding: HostedCampaignProductionTrustBinding,
): HostedCampaignProductionPolicy {
  return Object.freeze({
    kind: "hosted-campaign-production-policy",
    schemaVersion: 1,
    trustBinding,
  });
}
