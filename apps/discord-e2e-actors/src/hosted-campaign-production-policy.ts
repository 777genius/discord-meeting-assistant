import type { HostedRemoteAdmissionCompositionConfig } from "./hosted-remote-admission-composition.js";
import {
  COMPILED_HOSTED_CAMPAIGN_RELEASE_TRUST_ROOT,
  admitCompiledHostedCampaignReleaseBinding,
  createHostedCampaignReleaseConfig,
  type HostedCampaignReleaseTrustRootV1,
} from "./hosted-campaign-release-binding.js";
import type { HostedCampaignReleaseReferenceV1 } from "./hosted-campaign-pass-receipt.js";
import type { CraigCampaignStackReceiptV2 } from "./craig-disposable-campaign-stack.js";

export const HOSTED_CAMPAIGN_PRODUCTION_POLICY = Object.freeze({
  kind: "hosted-campaign-production-policy",
  schemaVersion: 1,
} as const satisfies HostedCampaignProductionPolicy);

interface HostedCampaignProductionTrustBinding {
  createConfig(candidate: HostedCampaignProductionCandidate): HostedRemoteAdmissionCompositionConfig;
}

export interface HostedCampaignProductionPolicy {
  readonly kind: "hosted-campaign-production-policy";
  readonly releaseReference?: HostedCampaignReleaseReferenceV1;
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
  const admitted = admitCompiledHostedCampaignReleaseBinding(releaseBinding, trustRoot);
  return Object.freeze({
    kind: "hosted-campaign-production-policy",
    schemaVersion: 1,
    releaseReference: admitted.releaseReference,
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
  readonly craigStack?: CraigCampaignStackReceiptV2;
}
