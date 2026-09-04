/**
 * Consumer-owned compatibility seam for the pending official Infinity SDK
 * exact-document contract. Implementations must be supplied by an official SDK;
 * this package deliberately contains no fallback HTTP implementation.
 */
export interface InfinityExactDocumentIdentityV1 {
  readonly documentId: string;
  readonly idempotencyKey: string;
  readonly memoryScopeExternalRef: string;
  readonly projectionGeneration: string;
  readonly sourceType: string;
  readonly spaceSlug: string;
  readonly threadExternalRef: string;
}

export type InfinityExactDocumentReconciliationV1 =
  | { readonly status: "absent" }
  | {
      readonly documentId: string;
      readonly idempotencyKey: string;
      readonly memoryScopeExternalRef: string;
      readonly processed: boolean;
      readonly projectionGeneration: string;
      readonly remoteDocumentId: string;
      readonly sourceType: string;
      readonly spaceSlug: string;
      readonly status: "active";
      readonly threadExternalRef: string;
    };

export interface InfinityExactDocumentSdkV1 {
  readonly contractVersion: "infinity.document-exact-reconciliation.v1";
  deleteExactDocument(
    input: InfinityExactDocumentIdentityV1 & {
      readonly deletionIdempotencyKey: string;
      readonly signal: AbortSignal;
    },
  ): Promise<{ readonly status: "deleted" | "outcome_unknown" }>;
  reconcileExactDocument(
    input: InfinityExactDocumentIdentityV1 & { readonly signal: AbortSignal },
  ): Promise<InfinityExactDocumentReconciliationV1>;
}

/** SDK 0.2.4 reconciles read-only exact identity, but cannot perform an
 * identity-bound delete; the full mutation seam therefore remains gated. */
export const INFINITY_EXACT_DOCUMENT_RELEASE_GATE = Object.freeze({
  contractVersion: "infinity.document-exact-reconciliation.v1" as const,
  minimumOfficialSdkVersion: "pending-exact-delete-release",
  publishedSdkVersion: "0.2.4",
  satisfiedByPublishedSdk: false,
});

export function requireInfinityExactDocumentSdk(
  sdk: InfinityExactDocumentSdkV1 | undefined,
): InfinityExactDocumentSdkV1 {
  if (sdk?.contractVersion !== INFINITY_EXACT_DOCUMENT_RELEASE_GATE.contractVersion) {
    throw new Error(
      "Infinity live projection requires the externally released official exact-document SDK",
    );
  }
  return sdk;
}
