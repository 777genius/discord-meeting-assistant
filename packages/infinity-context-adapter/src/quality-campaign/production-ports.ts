import type { AdjudicationAuthorityPort, RawOutcomeVaultPort } from "./adjudication.js";
import type { ProviderExchangePort } from "./execution.js";
import type { QualityCampaignRelease } from "./release.js";

export interface CampaignClockPort {
  nowEpochMs(): number;
}

export interface CampaignProviderPorts {
  readonly answer: ProviderExchangePort;
  readonly capability: ProviderExchangePort;
  readonly resultAuthority: { readonly keyId: string; readonly publicKeyPem: string };
  readonly retrieval: ProviderExchangePort;
}

export interface CampaignReviewPorts {
  readonly first: AdjudicationAuthorityPort;
  readonly resolver: AdjudicationAuthorityPort;
  readonly second: AdjudicationAuthorityPort;
  readonly vault: RawOutcomeVaultPort;
  rawOutcomeEnvelopeSha256(attemptId: string): Promise<string>;
}

export interface DerivedCampaignArtifact {
  readonly artifactId: string;
  readonly kind: "derived_index" | "temporary_projection" | "temporary_prompt";
}

export interface CampaignDeletionPort {
  deleteDerived(input: { readonly campaignRootSha256: string;
    readonly targets: readonly DerivedCampaignArtifact[] }): Promise<readonly {
      readonly artifactId: string; readonly outcome: "absent" | "deleted" | "unknown" }[]>;
}

export interface CanonicalAbsencePort {
  observe(input: { readonly campaignRootSha256: string;
    readonly targetArtifactIds: readonly string[] }): Promise<unknown>;
}

export interface CampaignQualificationPorts {
  metrics(input: { readonly campaignRootSha256: string; readonly repetition: 1 | 2 | 3 }):
  Promise<{ readonly metricsSha256: string; readonly outcomeCount: number;
    readonly thresholdsPassed: boolean }>;
  retention(input: { readonly campaignRootSha256: string }): Promise<{
    readonly inventorySha256: string; readonly outcomeCount: number }>;
}

export interface ObservedProductionReleasePort {
  observe(): Promise<QualityCampaignRelease>;
}

export interface QualityCampaignProductionPorts {
  readonly absence: CanonicalAbsencePort;
  readonly clock: CampaignClockPort;
  readonly deletion: CampaignDeletionPort;
  readonly holdoutProvider: CampaignProviderPorts;
  readonly mainProvider: CampaignProviderPorts;
  readonly qualification: CampaignQualificationPorts;
  readonly release: ObservedProductionReleasePort;
  readonly review: CampaignReviewPorts;
}
