import type {
  HistoricalReleaseBindingV1,
  HistoricalTranscriptTurnV1,
} from "../../domain/historical-evidence.js";

export interface HistoricalOpaqueIdPort {
  keyedId(namespace: string, parts: readonly string[]): string;
}

export interface HistoricalTopologyV1 {
  readonly indexGeneration: string;
  readonly releaseRef: string;
  readonly roomScopeExternalRef: string;
  readonly spaceSlug: string;
  readonly threadExternalRef: string;
}

export interface HistoricalBlockManifestV1 {
  readonly candidateLocator: string;
  readonly contentHash: string;
  readonly documentExternalId: string;
  readonly embeddingTokenEstimate: number;
  readonly embeddingTokenLimit: number;
  readonly embeddingTokenProfile: string;
  readonly endMs: number;
  readonly indexGeneration: string;
  readonly ordinal: number;
  readonly startMs: number;
  /** Exact local evidence coordinates for the clean embedding projection. */
  readonly turnSources: readonly HistoricalTurnSourceV1[];
  readonly turnIds: readonly string[];
}

export interface HistoricalTurnSourceV1 {
  readonly embeddingEndCodePoint: number;
  readonly embeddingStartCodePoint: number;
  readonly endMs: number;
  readonly sourceEndCodePoint: number;
  readonly sourceRef: string;
  readonly sourceStartCodePoint: number;
  readonly speakerId: string;
  readonly startMs: number;
  readonly turnId: string;
}

/** Canonical code-point slice rehydrated from one authoritative transcript turn. */
export interface HistoricalEvidenceSliceV1 extends HistoricalTranscriptTurnV1 {
  readonly sourceEndCodePoint: number;
  readonly sourceRef: string;
  readonly sourceStartCodePoint: number;
}

export interface HistoricalIndexDocumentV1 {
  /** Retrieval-only text: human speech without opaque IDs or timing noise. */
  readonly embeddingText: string;
  readonly manifest: HistoricalBlockManifestV1;
  readonly mutationId: string;
  /** Canonical local evidence payload used for identity and reconciliation. */
  readonly remoteText: string;
  readonly title: string;
}

export interface HistoricalIndexPlanV1 {
  readonly binding: HistoricalReleaseBindingV1;
  readonly deleteMutationId: string;
  readonly documents: readonly HistoricalIndexDocumentV1[];
  /** Effective deterministic overlap selected to remain inside the qualified cap. */
  readonly effectiveTurnOverlap: number;
  readonly indexMutationId: string;
  readonly planDigest: string;
  readonly schemaVersion: 1;
  readonly topology: HistoricalTopologyV1;
}

export interface LocallyRehydratedEvidenceBlockV1 {
  readonly binding: HistoricalReleaseBindingV1;
  readonly candidateLocator: string;
  readonly contentHash: string;
  readonly indexGeneration: string;
  readonly ordinal: number;
  readonly turns: readonly HistoricalEvidenceSliceV1[];
}

export type HistoricalIndexResultV1 =
  | {
      readonly remoteDocumentIds: Readonly<Record<string, string>>;
      readonly status: "applied";
    }
  | {
      readonly code: string;
      readonly retryable: boolean;
      readonly status: "outcome_unknown" | "rejected";
    };

export interface HistoricalSearchRequestV1 {
  readonly candidateLimit: number;
  readonly query: string;
  readonly roomScopeExternalRef: string;
  readonly schemaVersion: 1;
  readonly signal?: AbortSignal;
  readonly spaceSlug: string;
  readonly timeoutMs: number;
}

export interface HistoricalCandidateLocatorV1 {
  readonly locator: string;
  readonly providerRank: number;
  /** Exact finite relevance score returned by the qualified SDK search. */
  readonly providerScore: number;
}

export type HistoricalSearchResultV1 =
  | {
      readonly candidates: readonly HistoricalCandidateLocatorV1[];
      readonly hybridQualified: true;
      readonly status: "available";
    }
  | {
      readonly code: string;
      readonly retryable: boolean;
      readonly status: "unavailable" | "unqualified";
    };

export interface HistoricalDeleteRequestV1 {
  readonly deleteMutationId: string;
  /** Exact release document identities used to reconcile an unknown ingest outcome. */
  readonly documentExternalIds: readonly string[];
  readonly mode: "meeting" | "release";
  /** Persisted provider-neutral payloads used for idempotent ingest reconciliation. */
  readonly reconciliationDocuments: HistoricalIndexPlanV1["documents"];
  readonly remoteDocumentIds: Readonly<Record<string, string>>;
  readonly schemaVersion: 1;
  readonly topology: HistoricalTopologyV1;
}

export type HistoricalDeleteResultV1 =
  | { readonly status: "verified_absent" }
  | {
      readonly code: string;
      readonly retryable: boolean;
      readonly status: "absence_unverified" | "rejected";
    };

export interface HistoricalMemoryOperationOptionsV1 {
  /** Cancels the current resumable attempt without changing its mutation identity. */
  readonly signal?: AbortSignal;
}

/** Purpose-specific provider boundary. SDK values cannot cross this interface. */
export interface HistoricalMemoryPort {
  indexFinalMeeting(
    request: HistoricalIndexPlanV1,
    options?: HistoricalMemoryOperationOptionsV1,
  ): Promise<HistoricalIndexResultV1>;

  searchRoom(request: HistoricalSearchRequestV1): Promise<HistoricalSearchResultV1>;

  deleteMeeting(
    request: HistoricalDeleteRequestV1,
    options?: HistoricalMemoryOperationOptionsV1,
  ): Promise<HistoricalDeleteResultV1>;
}
