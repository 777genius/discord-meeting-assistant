import type {
  FocusedLocatorRetrievalV2RequestSnapshot,
} from "../../domain/retrieval-admission.js";
export type {
  FocusedLocatorRetrievalV2ProviderBinding,
  FocusedLocatorRetrievalV2RequestSnapshot,
} from "../../domain/retrieval-admission.js";

export interface FocusedLocatorRetrievalV2Candidate {
  readonly locator: string;
  readonly providerRank: number;
  readonly providerScore: number;
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
