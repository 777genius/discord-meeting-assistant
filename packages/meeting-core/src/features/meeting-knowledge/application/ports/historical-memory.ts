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
  readonly endMs: number;
  readonly indexGeneration: string;
  readonly ordinal: number;
  readonly startMs: number;
  readonly turnIds: readonly string[];
}

export interface HistoricalIndexDocumentV1 {
  readonly manifest: HistoricalBlockManifestV1;
  readonly mutationId: string;
  /** Canonical local human turns prepared for remote retrieval indexing only. */
  readonly remoteText: string;
  readonly title: string;
}

export interface HistoricalIndexPlanV1 {
  readonly binding: HistoricalReleaseBindingV1;
  readonly deleteMutationId: string;
  readonly documents: readonly HistoricalIndexDocumentV1[];
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
  readonly turns: readonly HistoricalTranscriptTurnV1[];
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

/** Purpose-specific provider boundary. SDK values cannot cross this interface. */
export interface HistoricalMemoryPort {
  indexFinalMeeting(request: HistoricalIndexPlanV1): Promise<HistoricalIndexResultV1>;

  searchRoom(request: HistoricalSearchRequestV1): Promise<HistoricalSearchResultV1>;

  deleteMeeting(request: HistoricalDeleteRequestV1): Promise<HistoricalDeleteResultV1>;
}
