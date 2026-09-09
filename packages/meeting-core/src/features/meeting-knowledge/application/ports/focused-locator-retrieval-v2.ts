import { QuestionBinding, type QuestionBindingSnapshot } from "../../domain/question-job.js";
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
      readonly status: "empty";
    }
  | {
      readonly authorityGeneration: string;
      readonly status: "current";
      readonly turns: readonly RehydratedEvidenceTurn[];
    }
  | {
      readonly reason: FocusedHistoricalEvidenceV2UnavailableReason;
      readonly status: "unavailable";
    };

export type FocusedHistoricalEvidenceV2UnavailableReason =
  | "authorization_changed"
  | "authorization_denied"
  | "canonical_evidence_unavailable"
  | "canonical_provenance_invalid"
  | "historical_authority_unavailable"
  | "provider_candidate_invalid"
  | "provider_result_unavailable"
  | "request_not_admitted"
  | "retrieval_provenance_invalid"
  | "scope_not_bound"
  | "serving_not_authorized";

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

export type FocusedLocatorRetrievalV2Preparation =
  | (FocusedLocatorRetrievalV2RequestSnapshot & { readonly status: "prepared" })
  | {
      readonly reason: "no_history_or_index";
      readonly status: "empty";
    }
  | {
      readonly reason: FocusedLocatorRetrievalV2PreparationUnavailableReason;
      readonly status: "unavailable";
    };

export type FocusedLocatorRetrievalV2PreparationUnavailableReason =
  | "historical_authority_overflow"
  | "historical_authority_unavailable"
  | "scope_resolution_unavailable"
  | "query_not_admitted"
  | "retrieval_filter_denied"
  | "serving_not_authorized";

/** Read-only resolution of external topology references before request identity exists.
 * Implementations must prove complete bounded collections and unique parent-bound
 * matches. No topology creation or external-reference fallback is permitted.
 * Authority belongs to one immutable request identity, with lifetime bounded by
 * request ownership. Later resolutions must never invalidate existing bindings.
 */
export interface FocusedRetrievalScopeResolutionPort {
  matches(input: { readonly request: FocusedLocatorRetrievalV2RequestSnapshot;
    readonly spaceSlug: string; readonly roomScopeExternalRef: string;
    readonly spaceId: string; readonly memoryScopeId: string }): boolean;
  /** Recheck current topology against IDs already sealed by the local worker. */
  matchesPersisted?(input: { readonly request: FocusedLocatorRetrievalV2RequestSnapshot;
    readonly spaceSlug: string; readonly roomScopeExternalRef: string;
    readonly signal?: AbortSignal }): Promise<boolean>;
  resolve(input: {
    readonly effects?: FocusedRetrievalScopeResolutionEffects;
    readonly spaceSlug: string;
    readonly roomScopeExternalRef: string;
    readonly signal?: AbortSignal;
  }): Promise<
    | { readonly status: "resolved"; readonly spaceId: string;
        readonly memoryScopeId: string;
        /** Bind exactly one immutable request by identity; never serialized. */
        bind(request: FocusedLocatorRetrievalV2RequestSnapshot): void }
    | { readonly status: "unavailable" }
  >;
}

export interface FocusedRetrievalScopeResolutionEffects {
  beforeRead(input: { readonly kind: "scope_spaces" | "scope_memory_scopes";
    readonly requestSha256: string }): Promise<void>;
  observe(input: { readonly kind: "scope_spaces" | "scope_memory_scopes";
    readonly requestSha256: string; readonly responseSha256: string | null;
    readonly responseBytes: number; readonly status: "received" | "failed" }): Promise<void>;
}

// Worker-local authority, never a serialized field or a cache indexed by external names.
// Only the lease request preparer calls this after the worker's authorization and
// current-binding fences. Domain validation alone is not scope authority.
const persistedScopes = new WeakMap<object, readonly [string, string, string]>();

export function prepareValidatedPersistedRetrievalScope(binding: QuestionBindingSnapshot): void {
  QuestionBinding.create(binding);
  const retrieval = binding.retrievalBinding;
  if (retrieval?.retrievalPath !== "infinity_locator_v2") { return; }
  if (!Object.isFrozen(retrieval.request) || !Object.isFrozen(retrieval.request.scope)) {
    throw new TypeError("Persisted worker request must be immutable");
  }
  const previous = validatedPersistedRetrievalScopeMatches({ request: retrieval.request,
    scopeId: binding.scopeId, roomId: binding.roomId });
  if (previous === false) { throw new TypeError("Conflicting persisted worker scope"); }
  persistedScopes.set(retrieval.request,
    Object.freeze([binding.scopeId, binding.roomId, JSON.stringify(retrieval.request)] as const));
}

export function validatedPersistedRetrievalScopeMatches(input: {
  readonly request: FocusedLocatorRetrievalV2RequestSnapshot;
  readonly scopeId: string; readonly roomId: string;
}): boolean | undefined {
  const scope = persistedScopes.get(input.request);
  return scope === undefined ? undefined : scope[0] === input.scopeId &&
    scope[1] === input.roomId && scope[2] === JSON.stringify(input.request);
}
