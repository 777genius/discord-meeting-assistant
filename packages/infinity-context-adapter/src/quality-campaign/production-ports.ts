import type { AdjudicationAuthorityPort, RawOutcomeVaultPort } from "./adjudication.js";
import type { ProviderExchangePort } from "./execution.js";
import type { QualityCampaignRelease } from "./release.js";
import type { ArtifactCustodyPort } from "./retention.js";
import type { ExactCampaignEvidence, ExactAdjudicationEvidence,
  ExactOutcomeEvidence } from "./production-evidence.js";

export interface CampaignCallContext {
  readonly deadlineEpochMs: number;
  readonly signal: AbortSignal;
}

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
  rawOutcomeEnvelopeSha256(attemptId: string, context: CampaignCallContext): Promise<string>;
}

export interface DerivedCampaignArtifact {
  readonly artifactId: string;
  readonly kind: "derived_index" | "temporary_projection" | "temporary_prompt";
}

export interface CampaignDeletionPort {
  readonly authorityId: string;
  deleteDerived(input: { readonly campaignRootSha256: string;
    readonly context: CampaignCallContext;
    readonly targets: readonly DerivedCampaignArtifact[] }): Promise<readonly {
      readonly artifactId: string; readonly outcome: "absent" | "deleted" | "unknown" }[]>;
}

export interface CanonicalAbsencePort {
  readonly authorityId: string;
  observe(input: { readonly campaignRootSha256: string;
    readonly cleanupManifestSha256: string;
    readonly context: CampaignCallContext;
    readonly targetArtifactIds: readonly string[] }): Promise<unknown>;
}

export interface CampaignExactEvidencePort {
  main(input: { readonly attemptIds: readonly string[]; readonly campaignRootSha256: string;
    readonly context: CampaignCallContext }): Promise<ExactCampaignEvidence>;
  holdout(input: { readonly attemptIds: readonly string[]; readonly campaignRootSha256: string;
    readonly context: CampaignCallContext }): Promise<{ readonly adjudications:
      readonly ExactAdjudicationEvidence[]; readonly outcomes: readonly ExactOutcomeEvidence[] }>;
}

export interface ObservedProductionReleasePort {
  observe(context: CampaignCallContext): Promise<QualityCampaignRelease>;
}

export interface QualityCampaignProductionPorts {
  readonly absence: CanonicalAbsencePort;
  readonly artifactCustody: ArtifactCustodyPort;
  readonly clock: CampaignClockPort;
  readonly deletion: CampaignDeletionPort;
  readonly evidence: CampaignExactEvidencePort;
  readonly holdoutProvider: CampaignProviderPorts;
  readonly mainProvider: CampaignProviderPorts;
  readonly release: ObservedProductionReleasePort;
  readonly review: CampaignReviewPorts;
}
