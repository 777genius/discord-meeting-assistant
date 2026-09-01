import type {
  CanonicalEvidenceTurn,
  RehydratedEvidenceTurn,
} from "../../domain/grounding-plan.js";
import type {
  TrustedLiveMemoryIdentityInputV1,
} from "../../domain/live-finalized-memory.js";

export interface LiveFinalizedMemoryLifecyclePort {
  registerMeeting(
    identity: TrustedLiveMemoryIdentityInputV1,
  ): Promise<"accepted" | "ineligible" | "replayed">;

  observeHuman(input: {
    readonly actorId: string;
    readonly meetingId: string;
    readonly producerRevision: string;
  }): Promise<"accepted" | "ineligible" | "replayed">;

  removeHuman(input: {
    readonly actorId: string;
    readonly meetingId: string;
    readonly producerRevision: string;
  }): Promise<"accepted" | "ineligible" | "replayed">;

  sealMeeting(
    identity: TrustedLiveMemoryIdentityInputV1,
  ): Promise<"accepted" | "ineligible" | "replayed">;

  finishMeeting(meetingId: string): Promise<void>;
}

export interface LiveFinalizedMemoryLeaseV1 {
  readonly attempt: number;
  readonly enqueuedAtMs: number;
  readonly fence: number;
  readonly identityGeneration: number;
  readonly meetingId: string;
  readonly mutationId: string;
  readonly operation: "delete" | "upsert";
  /** A prior request may have committed remotely and must be reconciled first. */
  readonly requiresReconciliation: boolean;
  readonly sourceGeneration: number;
  readonly turnHash: string;
  readonly turnId: string;
}

export interface LiveFinalizedMemoryProjectionV1 {
  readonly documentId: string;
  readonly generation: number;
  readonly meetingId: string;
  readonly mutationId: string;
  readonly ordinal: number;
  readonly roomId: string;
  readonly scopeId: string;
  readonly turn: CanonicalEvidenceTurn;
  readonly turnHash: string;
}

export type LiveFinalizedMemoryProjectionResultV1 =
  | { readonly status: "applied" }
  | { readonly status: "not_found" }
  | {
      readonly code: string;
      readonly retryable: boolean;
      readonly status: "outcome_unknown" | "rejected";
    };

/** Consumer-owned provider boundary. SDK values never cross this interface. */
export interface LiveFinalizedMemoryProjectionPort {
  reconcile(
    projection: LiveFinalizedMemoryProjectionV1,
    options?: { readonly signal?: AbortSignal },
  ): Promise<LiveFinalizedMemoryProjectionResultV1>;

  upsert(
    projection: LiveFinalizedMemoryProjectionV1,
    options?: { readonly signal?: AbortSignal },
  ): Promise<LiveFinalizedMemoryProjectionResultV1>;

  reconcileRemoval(
    projection: LiveFinalizedMemoryProjectionV1,
    options?: { readonly signal?: AbortSignal },
  ): Promise<LiveFinalizedMemoryProjectionResultV1>;

  remove(
    projection: LiveFinalizedMemoryProjectionV1,
    options?: { readonly signal?: AbortSignal },
  ): Promise<LiveFinalizedMemoryProjectionResultV1>;
}

export interface LiveFinalizedMemoryTelemetryPort {
  observe(input: {
    readonly ingestToAppliedMs: number;
    readonly outcome: "applied" | "reconciled";
  }): void;
}

export interface LiveFinalizedMemorySyncStore {
  claimNext(input: {
    readonly leaseDurationMs: number;
    readonly meetingId?: string;
  }): Promise<LiveFinalizedMemoryLeaseV1 | null>;

  loadCanonicalTurn(
    lease: LiveFinalizedMemoryLeaseV1,
  ): Promise<CanonicalEvidenceTurn | null>;

  loadProjection(
    lease: LiveFinalizedMemoryLeaseV1,
  ): Promise<LiveFinalizedMemoryProjectionV1 | null>;

  apply(
    lease: LiveFinalizedMemoryLeaseV1,
    input: { readonly maximumHotTailTurns: number },
  ): Promise<{ readonly appliedAtMs: number }>;

  recordDeadLetter(
    lease: LiveFinalizedMemoryLeaseV1,
    code: string,
  ): Promise<void>;

  recordRetry(
    lease: LiveFinalizedMemoryLeaseV1,
    input: { readonly code: string; readonly retryAfterMs: number },
  ): Promise<void>;

  recordOutcomeUnknown(
    lease: LiveFinalizedMemoryLeaseV1,
    input: { readonly code: string; readonly retryAfterMs: number },
  ): Promise<void>;

  settleRemoval(lease: LiveFinalizedMemoryLeaseV1): Promise<void>;
}

export interface LiveMemoryContextV1 {
  readonly appliedGeneration: number;
  readonly humanActorIds: readonly string[];
  readonly identityGeneration: number;
  readonly knowledgeEpoch: string;
  readonly meetingId: string;
  readonly roomId: string;
  readonly scopeId: string;
  readonly sourceGeneration: number;
}

export interface LiveMemoryCandidateReferenceV1 {
  readonly meetingId: string;
  readonly sourceGeneration: number;
  readonly turnHash: string;
  readonly turnId: string;
}

export type LiveMemoryCandidateResultV1 =
  | {
      readonly candidates: readonly LiveMemoryCandidateReferenceV1[];
      readonly context: LiveMemoryContextV1;
      readonly schemaVersion: 1;
      readonly status: "current";
    }
  | {
      readonly schemaVersion: 1;
      readonly status:
        | "backpressured"
        | "degraded"
        | "ineligible"
        | "low_coverage"
        | "pending"
        | "stale"
        | "unavailable";
    };

export type LiveMemoryRehydrationResultV1 =
  | {
      readonly context: LiveMemoryContextV1;
      readonly schemaVersion: 1;
      readonly status: "current";
      readonly turns: readonly RehydratedEvidenceTurn[];
    }
  | {
      readonly schemaVersion: 1;
      readonly status: "invalid_selection" | "stale" | "unavailable";
    };

/** Candidate lookup and canonical reload are intentionally separate calls. */
export interface LiveFinalizedMemoryQueryPort {
  resolveContext(input: {
    readonly meetingId: string;
    readonly requesterActorId: string;
    readonly roomId: string;
    readonly signal?: AbortSignal;
  }): Promise<LiveMemoryContextV1 | null>;

  searchHotTail(input: {
    readonly maximumCandidates: number;
    readonly meetingId: string;
    readonly neighborTurns: number;
    readonly question: string;
    readonly requesterActorId: string;
    readonly roomId: string;
    readonly signal?: AbortSignal;
    readonly scopeId: string;
  }): Promise<LiveMemoryCandidateResultV1>;

  rehydrateHotTail(input: {
    readonly candidates: readonly LiveMemoryCandidateReferenceV1[];
    readonly expectedGeneration: number;
    readonly meetingId: string;
    readonly requesterActorId: string;
    readonly roomId: string;
    readonly signal?: AbortSignal;
    readonly scopeId: string;
  }): Promise<LiveMemoryRehydrationResultV1>;
}
