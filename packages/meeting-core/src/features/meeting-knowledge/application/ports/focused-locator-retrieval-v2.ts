import type {
  FocusedLocatorRetrievalV2RequestSnapshot,
} from "../../domain/retrieval-admission.js";
import type { FocusedRetrievalAudit, RehydratedEvidenceTurn } from
  "../../domain/grounding-plan.js";
export type {
  FocusedLocatorRetrievalV2ProviderBinding,
  FocusedLocatorRetrievalV2RequestSnapshot,
} from "../../domain/retrieval-admission.js";

export interface FocusedLocatorRetrievalV2Candidate {
  readonly locator: string;
  readonly retrievalProvenance: FocusedRetrievalAudit;
}

export type FocusedLocatorRetrievalV2Result =
  | {
      readonly candidates: readonly FocusedLocatorRetrievalV2Candidate[];
      readonly status: "available";
    }
  | {
      readonly code: string;
      readonly retryable: boolean;
      readonly status: "unavailable" | "unqualified";
    };

/**
 * Consumer-owned locator-only boundary. Provider text, citations, metadata and
 * authorization assertions cannot cross it.
 */
export interface FocusedLocatorRetrievalV2Port {
  retrieve(
    request: FocusedLocatorRetrievalV2RequestSnapshot,
    options?: { readonly signal?: AbortSignal },
  ): Promise<FocusedLocatorRetrievalV2Result>;
}

export type FocusedHistoricalEvidenceV2Result =
  | {
      readonly authorityGeneration: string;
      readonly status: "current";
      readonly turns: readonly RehydratedEvidenceTurn[];
    }
  | { readonly status: "unavailable" };

export interface FocusedHistoricalEvidenceV2Port {
  retrieve(input: {
    readonly authorizationPrincipalRef: string;
    readonly currentMeetingId: string;
    readonly maximumCandidates: number;
    readonly question: string;
    readonly roomId: string;
    readonly scopeId: string;
    readonly signal: AbortSignal;
  }): Promise<FocusedHistoricalEvidenceV2Result>;
}
