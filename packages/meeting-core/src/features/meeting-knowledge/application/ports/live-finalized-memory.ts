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
  readonly fence: number;
  readonly identityGeneration: number;
  readonly meetingId: string;
  readonly mutationId: string;
  readonly sourceGeneration: number;
  readonly turnHash: string;
  readonly turnId: string;
}

export interface LiveFinalizedMemorySyncStore {
  claimNext(input: {
    readonly leaseDurationMs: number;
    readonly meetingId?: string;
  }): Promise<LiveFinalizedMemoryLeaseV1 | null>;

  loadCanonicalTurn(
    lease: LiveFinalizedMemoryLeaseV1,
  ): Promise<CanonicalEvidenceTurn | null>;

  apply(
    lease: LiveFinalizedMemoryLeaseV1,
    input: { readonly maximumHotTailTurns: number },
  ): Promise<void>;

  recordDeadLetter(
    lease: LiveFinalizedMemoryLeaseV1,
    code: string,
  ): Promise<void>;

  recordRetry(
    lease: LiveFinalizedMemoryLeaseV1,
    input: { readonly code: string; readonly retryAfterMs: number },
  ): Promise<void>;
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
      readonly status: "ineligible" | "low_coverage" | "pending" | "stale" | "unavailable";
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
