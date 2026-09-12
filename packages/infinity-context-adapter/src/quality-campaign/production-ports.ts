import type { AdjudicationEffectEvidence, RawOutcomeVaultPort } from "./adjudication.js";
import type { AttemptIdentity, ProviderExchangePort } from "./execution.js";
import type { QualityCampaignRelease } from "./release.js";
import type { ArtifactCustodyPort, CanonicalScopeObservationPort } from "./retention.js";
import type { ExactCampaignEvidence } from "./production-evidence.js";
import type { QualificationExecutionPacket, QualificationQuestionExecutorFactoryPort } from
  "./execute-admitted-qualification-question.js";
import type { PROTECTED_SOURCE_KINDS } from "./cleanup-evidence.js";

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

export interface CampaignReviewEvidence {
  readonly firstEffectEvidence: AdjudicationEffectEvidence;
  readonly firstReceipt: unknown;
  readonly predecessorPlaintextSha256: string;
  readonly rawOutcomeEnvelopeSha256: string;
  readonly resolverEffectEvidence: AdjudicationEffectEvidence | null;
  readonly resolverReceipt: unknown;
  readonly secondEffectEvidence: AdjudicationEffectEvidence;
  readonly secondReceipt: unknown;
}

export interface CampaignReviewPorts {
  readonly vault: RawOutcomeVaultPort;
  receipts(attemptId: string, context: CampaignCallContext): Promise<CampaignReviewEvidence>;
}

export interface DerivedCampaignArtifact {
  readonly artifactId: string;
  readonly kind: "derived_index" | "temporary_projection" | "temporary_prompt";
}

export interface ProtectedCampaignEvidence {
  readonly artifactId: string;
  readonly artifactSha256: string;
  readonly kind: typeof PROTECTED_SOURCE_KINDS[number] | "frozen_snapshot" |
    "frozen_signed_root";
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
    readonly executionChainSha256: string;
    readonly context: CampaignCallContext }): Promise<RawAuthenticatedEvidence>;
  holdout(input: { readonly attemptIds: readonly string[]; readonly campaignRootSha256: string;
    readonly executionChainSha256: string;
    readonly context: CampaignCallContext }): Promise<RawAuthenticatedEvidence>;
}

export interface RawAuthenticatedEvidence {
  readonly envelopeBytes: Uint8Array;
  readonly signedReceipt: unknown;
}

export interface CampaignEvidenceCustodyPort {
  open(input: { readonly attemptIds: readonly string[]; readonly campaignRootSha256: string;
    readonly delivery: RawAuthenticatedEvidence; readonly kind: "holdout" | "main";
    readonly releaseRootSha256: string }): Promise<ExactCampaignEvidence>;
}

/** Consumer-owned application view of one admitted quality-campaign scope. */
export interface QualificationScopeTopology {
  readonly currentMeetingId: string;
  readonly roomId: string;
  readonly scopeId: string;
  readonly memoryScopeId?: string;
  readonly spaceId?: string;
  readonly topologyDocumentSha256?: string;
  readonly topologyGeneration?: string;
}

/** Resolves only an already authenticated execution-safe reference. */
export interface QualificationScopeTopologyPort {
  resolve(reference: string, questionId: string, binding?: {
    readonly topologyDocumentSha256: string;
    readonly topologyGeneration: string;
  }): Promise<QualificationScopeTopology>;
}

export interface MainCanonicalEvidenceProjection {
  readonly answerAbstained: boolean;
  readonly attemptId: string;
  readonly campaignRootSha256: string;
  readonly capabilityRequestSha256: string;
  readonly capabilityResponseSha256: string;
  /** Independently authenticated execution input; never reconstructed from a retained binding. */
  readonly executionPacket: QualificationExecutionPacket;
  readonly citationLocatorIds: readonly string[];
  readonly evidenceLocatorIds: readonly string[];
  readonly evidenceTurnIds: readonly string[];
  readonly rankedLocatorIds: readonly string[];
  readonly retrievalLatencyUs: number;
  readonly retrievalRequestSha256: string;
  readonly retrievalResponseSha256: string;
  readonly terminalAnswerRequestSha256: string;
  readonly terminalAnswerResponseSha256: string;
  readonly identity: AttemptIdentity;
  /** Resolved only for V3 custody; legacy V1 verification has no topology dependency. */
  readonly topology: QualificationScopeTopology | null;
  /** Present only for diagnostic attempts and reconstructed from the frozen plan and applied receipt. */
  readonly diagnosticCustody: { readonly appliedDocumentIds: Readonly<Record<string, string>>;
    readonly frozenPlan: unknown } | null;
}

export interface VerifiedMainCanonicalEvidence {
  readonly inventorySha256: string;
}

/** Consumer-owned local proof boundary; no corpus, gold, or adjudication facts cross it. */
export interface MainCanonicalEvidenceVerificationPort extends CanonicalScopeObservationPort {
  project(input: Omit<MainCanonicalEvidenceProjection, "diagnosticCustody" | "topology">):
    Promise<MainCanonicalEvidenceProjection>;
  verify(input: { readonly attempts: readonly MainCanonicalEvidenceProjection[];
    readonly campaignRootSha256: string }): Promise<VerifiedMainCanonicalEvidence>;
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
  readonly evidenceCustody: CampaignEvidenceCustodyPort;
  readonly holdoutProvider: CampaignProviderPorts;
  readonly mainExecutorFactory: QualificationQuestionExecutorFactoryPort;
  readonly mainCanonicalEvidence: MainCanonicalEvidenceVerificationPort;
  readonly mainResultAuthority: { readonly keyId: string; readonly publicKeyPem: string };
  readonly release: ObservedProductionReleasePort;
  readonly review: CampaignReviewPorts;
}
