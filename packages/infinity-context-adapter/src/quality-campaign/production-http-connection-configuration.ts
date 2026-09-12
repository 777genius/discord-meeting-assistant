import type { ProductionCanonicalExecutionConnectionConfiguration } from
  "./production-canonical-executor-factory.js";

export interface HttpConnectionConfiguration {
  readonly absenceAuthority: HttpAuthority;
  readonly absenceEndpoint: string;
  readonly adjudicators: readonly [HttpReviewer, HttpReviewer, HttpReviewer];
  readonly artifactCustody: { readonly envelopeRoot: string; readonly keyCustodySha256: string;
    readonly keyId: string; readonly keyPath: string };
  readonly canonicalExecution: ProductionCanonicalExecutionConnectionConfiguration;
  readonly credentialPath: string;
  readonly deletionAuthority: HttpAuthority;
  readonly deletionEndpoint: string;
  readonly evidenceEndpoint: string;
  readonly evidenceAuthority: HttpAuthority;
  readonly evidenceKeyId: string;
  readonly evidenceKeyPath: string;
  readonly holdoutAnswerEndpoint: string;
  readonly holdoutCapabilityEndpoint: string;
  readonly holdoutEvidenceEndpoint: string;
  readonly holdoutEvidenceAuthority: HttpAuthority;
  readonly holdoutEvidenceKeyId: string;
  readonly holdoutEvidenceKeyPath: string;
  readonly holdoutProviderResultAuthority: HttpAuthority;
  readonly holdoutRetrievalEndpoint: string;
  readonly providerResultAuthority: HttpAuthority;
  readonly rawOutcomeEndpoint: string;
  readonly releaseObservationEndpoint: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_http_connections.v5";
}
export interface HttpAuthority { readonly keyId: string; readonly publicKeyPath: string }
interface HttpReviewer extends HttpAuthority { readonly endpoint: string }
