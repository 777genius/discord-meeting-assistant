import type { AnswerLocale } from "../../domain/answer-locale.js";
import type { FixedFinalReplyOutcome, GroundedAnswer, GroundedAnswerCandidate } from
  "../../domain/grounded-answer.js";
import type {
  CanonicalEvidenceTurn,
  FocusedMemoryReference,
  GroundingEvidence,
  GroundingPlan,
  GroundingCoverageReduction,
  GroundingRequestMeasurement,
  GroundingSafetyLimits,
  RehydratedEvidenceTurn,
} from "../../domain/grounding-plan.js";
import type { RetrievalAdmissionRollout, RetrievalBindingSnapshot } from
  "../../domain/retrieval-admission.js";
import type { FocusedLocatorRetrievalV2Preparation } from
  "./focused-locator-retrieval-v2.js";
import type { QuestionBindingSnapshot, QuestionJobState } from "../../domain/question-job.js";

export interface CanonicalEvidenceTurnHashPort {
  hash(turn: CanonicalEvidenceTurn): string
}

/** Consumer-owned rendering boundary; transport-specific markup stays in adapters. */
export interface FinalReplyRendererPort {
  renderAnswer(input: {
    readonly answer: GroundedAnswer; readonly evidence: readonly GroundingEvidence[];
    readonly maximumCharacters: number;
  }): string;

  renderFixed(input: {
    readonly locale: AnswerLocale; readonly outcome: FixedFinalReplyOutcome;
  }): string;
}

export type QuestionAuthorizationCheckpoint =
  | "admission"
  | "before_effect_reservation"
  | "before_generation"
  | "before_hydration"
  | "before_retrieval"
  | "before_send_cas";

export type QuestionAuthorizationObservation =
  | {
      readonly actorId: string; readonly containerId: string;
      readonly deliveryContainerId: string; readonly digest: string;
      readonly expiresAt: string; readonly observedAt: string;
      readonly policyVersion: string; readonly scopeId: string;
      readonly source: "authoritative_remote";
      readonly status: "authorized";
    }
  | {
      readonly reason: "absent" | "denied" | "expired" | "partial" | "unavailable";
      readonly status: "denied";
    };

export interface QuestionAuthorizationPort {
  observe(input: {
    readonly authorizationPrincipalRef: string;
    readonly checkpoint: QuestionAuthorizationCheckpoint;
    readonly expectedContainerId: string;
    readonly expectedQuestion?: {
      readonly botApplicationIdentity: string; readonly deliveryContainerId: string;
      readonly finalProjectionReceipt: string; readonly questionHash: string;
      readonly requesterSubject: string;
    };
    readonly expectedScopeId: string;
    readonly questionId: string;
  }): Promise<QuestionAuthorizationObservation>;
}

export function exactQuestionObservation(
  binding: QuestionBindingSnapshot,
): NonNullable<Parameters<QuestionAuthorizationPort["observe"]>[0][
  "expectedQuestion"
]> {
  return Object.freeze({
    botApplicationIdentity: binding.botApplicationIdentity,
    deliveryContainerId: binding.deliveryContainerId,
    finalProjectionReceipt: binding.finalProjectionReceipt,
    questionHash: binding.questionHash,
    requesterSubject: binding.requesterSubject,
  });
}

export interface CurrentFinalReplyBinding {
  readonly botApplicationIdentity: string; readonly canonicalEvidenceHash: string;
  readonly finalProjectionEpoch: string; readonly finalProjectionReceipt: string;
  readonly humanActorIds: readonly string[]; readonly meetingId: string;
  readonly meetingRevision: number; readonly memoryGeneration: string;
  readonly projectionTargetContainerId: string; readonly roomId: string;
  readonly scopeId: string; readonly transcriptId: string;
  readonly transcriptVersion: number;
}

export type CurrentFinalReplyBindingResult =
  | { readonly binding: CurrentFinalReplyBinding; readonly status: "current" }
  | { readonly status: "stale" | "unavailable" };

export type CanonicalFinalReplyEvidenceResult =
  | { readonly binding: CurrentFinalReplyBinding; readonly status: "current";
      readonly turns: readonly RehydratedEvidenceTurn[] }
  | { readonly status: "invalid_selection" | "stale" | "unavailable" };

export interface FinalReplyEvidencePort {
  findCurrentBinding(input: {
    readonly finalProjectionReceipt: string;
    readonly projectionTargetContainerId: string;
  }): Promise<CurrentFinalReplyBinding | null>;

  recheckCurrentBinding(
    binding: QuestionBindingSnapshot,
  ): Promise<CurrentFinalReplyBindingResult>;

  rehydrateSelectedEvidence(
    binding: QuestionBindingSnapshot,
    references: readonly FocusedMemoryReference[],
  ): Promise<CanonicalFinalReplyEvidenceResult>;
}

export type FocusedMemoryRetrievalResult =
  | { readonly authorityGeneration: string;
      readonly candidates: readonly FocusedMemoryReference[];
      readonly schemaVersion: 1;
      readonly status: "current";
    }
  | {
      readonly authorityGeneration: string;
      readonly schemaVersion: 1;
      readonly status: "low_coverage";
    }
  | {
      readonly schemaVersion: 1;
      readonly status:
        | "pending"
        | "stale"
        | "unavailable";
    };

/**
 * Candidate retrieval is deliberately text-free. Concrete memory/provider text
 * must be discarded in its adapter before this boundary is crossed.
 */
export interface FocusedMemoryRetrievalPort {
  retrieve(input: {
    /** Required by same-room serving; local-only adapters may omit it. */
    readonly authorizationPrincipalRef?: string;
    readonly canonicalEvidenceHash: string;
    readonly expectedAuthorityGeneration: string;
    readonly finalProjectionReceipt: string;
    /** Canonical hard filters reapplied after every local hydration boundary. */
    readonly hardFilters?: {
      readonly relativeTimeInterval: {
        readonly endMs: number;
        readonly startMs: number;
      } | null;
      readonly requiresSpeakerMatch: boolean;
      readonly speakerIds: readonly string[];
    };
    readonly maximumCandidates: number;
    readonly meetingId: string;
    readonly meetingRevision: number;
    readonly neighborTurns: number;
    readonly projectionTargetContainerId: string;
    readonly question: string;
    readonly retrievalBinding?: RetrievalBindingSnapshot;
    readonly roomId: string;
    readonly scopeId: string;
    readonly signal?: AbortSignal;
    readonly transcriptId: string;
    readonly transcriptVersion: number;
  }): Promise<FocusedMemoryRetrievalResult>;

  /**
   * Optional only for current-meeting-only implementations. A plan containing
   * historical evidence fails closed when this fresh same-room fence is absent.
   */
  reauthorizeHistoricalEvidence?(input: {
    readonly authorizationPrincipalRef: string;
    readonly roomId: string;
    readonly scopeId: string;
  }): Promise<boolean>;
}

export type ExhaustiveMemoryRetrievalResult =
  | {
      readonly authorityGeneration: string;
      readonly candidates: readonly FocusedMemoryReference[];
      readonly coverageBitmap: readonly true[];
      readonly coveragePlanDigest: string;
      readonly coverageReduction: GroundingCoverageReduction;
      readonly schemaVersion: 1;
      readonly status: "current";
    }
  | {
      readonly schemaVersion: 1;
      readonly status:
        | "incomplete"
        | "insufficient_evidence"
        | "stale"
        | "unauthorized"
        | "unavailable"
        | "unsupported";
    };

export interface ExhaustiveMemoryRetrievalRequest {
  readonly authorizationPrincipalRef: string;
  readonly expectedAuthorityGeneration: string;
  readonly question: string;
  readonly requestId: string;
  readonly roomId: string;
  readonly signal?: AbortSignal;
  readonly scopeId: string;
}

/** Explicit every-block path; top-k implementations cannot satisfy this port. */
export interface ExhaustiveMemoryRetrievalPort {
  retrieve(
    input: ExhaustiveMemoryRetrievalRequest,
  ): Promise<ExhaustiveMemoryRetrievalResult>;

  recheck(input: ExhaustiveMemoryRetrievalRequest & {
    readonly coveragePlanDigest: string;
  }): Promise<boolean>;
}

export interface QuestionAdmissionRatePolicy {
  readonly guildQuestionsPerHour: number;
  readonly jobTtlSeconds: number;
  readonly requesterQuestionsPerHour: number;
}

export type QuestionAdmissionCommitResult =
  | { readonly jobId: string; readonly status: "committed" | "duplicate" }
  | { readonly status: "conflict" | "rate_limited" | "stale" };

export interface QuestionAdmissionCommitPort {
  commit(input: {
    readonly authorization: Extract<
      QuestionAuthorizationObservation,
      { readonly status: "authorized" }
    >;
    readonly binding: QuestionBindingSnapshot;
    readonly questionText: string;
    readonly ratePolicy: QuestionAdmissionRatePolicy;
  }): Promise<QuestionAdmissionCommitResult>;

  recordQuestionMutation?(input: {
    readonly kind: "delete" | "edit";
    readonly questionId: string;
    readonly retentionSeconds: number;
  }): Promise<void>;

  withdrawProjection(input: {
    readonly finalProjectionReceipt: string;
  }): Promise<readonly string[]>;
}

export interface FocusedLocatorRetrievalV2AdmissionPort {
  prepare(input: {
    readonly currentMeetingId: string;
    readonly question: string;
    readonly roomId: string;
    readonly scopeId: string;
    readonly signal?: AbortSignal;
  }): Promise<FocusedLocatorRetrievalV2Preparation>;
}

export type QuestionJobTerminalOutcome =
  | "answered"
  | "cancelled"
  | "delivery_unknown"
  | "expired"
  | "insufficient_evidence"
  | "not_a_question"
  | "processing"
  | "stale_authorization"
  | "stale_binding"
  | "unavailable"
  | "unsupported_size";

export interface QuestionJobLease {
  readonly answerCandidate: GroundedAnswerCandidate | null;
  readonly attempts: number;
  readonly binding: QuestionBindingSnapshot;
  readonly generation: number;
  readonly groundingPlan: GroundingPlan | null;
  readonly jobId: string;
  readonly questionText: string;
  readonly state: Extract<QuestionJobState, "ready" | "running">;
}

export interface QuestionJobStore {
  leaseNext(input: {
    readonly leaseSeconds: number;
    readonly maximumProviderAttempts: number;
    readonly workerId: string;
  }): Promise<QuestionJobLease | null>;

  reserveProviderAttempt(input: {
    readonly attemptId: string;
    readonly generation: number;
    readonly jobId: string;
    readonly leaseSeconds: number;
    readonly maximumProviderAttempts: number;
  }): Promise<boolean>;

  completeProviderAttempt(input: {
    readonly answerCandidate: GroundedAnswerCandidate;
    readonly attemptId: string;
    readonly generation: number;
    readonly jobId: string;
  }): Promise<boolean>;

  failProviderAttempt(input: {
    readonly attemptId: string;
    readonly generation: number;
    readonly jobId: string;
    readonly maximumProviderAttempts: number;
    readonly reason: string;
    readonly retryable: boolean;
  }): Promise<"deferred" | "settled" | "stale">;

  persistGroundingPlan(input: {
    readonly attemptAlreadyReserved: boolean;
    readonly attemptId: string;
    readonly binding: QuestionBindingSnapshot;
    readonly generation: number;
    readonly jobId: string;
    readonly leaseSeconds: number;
    readonly maximumProviderAttempts: number;
    readonly measurement: GroundingRequestMeasurement;
    readonly plan: GroundingPlan;
    readonly question: string;
    readonly runtimeProfile: string;
    readonly sourceMeetingIds: readonly string[];
  }): Promise<boolean>;

  settle(input: {
    readonly generation: number;
    readonly jobId: string;
    readonly outcome: QuestionJobTerminalOutcome;
  }): Promise<boolean>;

  cancelQuestion(questionId: string): Promise<void>;

  hasActiveQuestion(questionId: string): Promise<boolean>;
  convergeDeliveredQuestion?(questionId: string): Promise<boolean>;
  confirmActiveLease(input: {
    readonly generation: number;
    readonly jobId: string;
  }): Promise<boolean>;
  listActiveQuestionsForReconciliation?(input: { readonly afterQuestionId: string | null;
    readonly maximumRows: number }): Promise<readonly {
    readonly authorizationPrincipalRef: string | null;
    readonly botApplicationIdentity: string | null;
    readonly deliveryContainerId: string | null; readonly reconciliationDisposition?: "quarantined" | "reconcile";
    readonly finalProjectionReceipt: string;
    readonly questionHash: string;
    readonly questionId: string;
    readonly requesterSubject: string;
    readonly scopeId: string;
  }[]>;
  loadQuestionReconciliationCursor?(): Promise<string | null>; saveQuestionReconciliationCursor?(
    input: { readonly expectedAfterQuestionId: string | null; readonly nextAfterQuestionId:
      string | null }): Promise<boolean>;
}

export interface FinalReplyMaintenancePort {
  maintain(input: {
    readonly maximumJobs: number;
    readonly servingEnabled: boolean;
  }): Promise<{
    readonly cancelled: number;
    readonly expired: number;
  }>;
}

/**
 * Minimal release identity required by the provider-neutral generation edge.
 * A Discord question binding is structurally compatible, while live voice can
 * supply its independently fenced memory generation without inventing a
 * Discord message or persistence aggregate.
 */
export interface GroundedAnswerGenerationBinding {
  readonly canonicalEvidenceHash: string;
  readonly memoryGeneration: string;
  readonly transcriptVersion: number;
}

export interface GroundedAnswerGenerationRequest {
  readonly attemptId: string;
  readonly binding: GroundedAnswerGenerationBinding;
  readonly locale: AnswerLocale;
  readonly plan: GroundingPlan;
  readonly question: string;
}

export interface GroundedAnswerMeasurement extends GroundingRequestMeasurement {
  readonly runtimeProfile: string;
}

export type GroundedAnswerGenerationResult =
  | { readonly answer: GroundedAnswerCandidate; readonly status: "completed" }
  | { readonly code: string; readonly retryable: boolean; readonly status: "failed" };

export interface GroundedAnswerGenerator {
  measure(
    request: GroundedAnswerGenerationRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<GroundedAnswerMeasurement>;

  generate(
    request: GroundedAnswerGenerationRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<GroundedAnswerGenerationResult>;
}

export type AnswerEffectReservation =
  | { readonly effectId: string; readonly status: "already_delivered" }
  | { readonly effectId: string; readonly status: "rejected_before_request" }
  | { readonly effectId: string; readonly status: "reserved" };

export type AnswerEffectDeliveryResult =
  | { readonly externalReceipt: string; readonly status: "delivered" }
  | { readonly status: "outcome_unknown" | "rejected_before_request" };

export interface AnswerPublicationPort {
  reserve(input: {
    readonly authorizationDigest: string;
    readonly binding: QuestionBindingSnapshot;
    readonly content: string;
    readonly deliveryContainerId: string;
    readonly marker: string;
    readonly projectionTargetContainerId: string;
    readonly questionGeneration: number;
    readonly replyToRemoteMessageId: string;
    readonly sourceMeetingIds: readonly string[];
  }): Promise<AnswerEffectReservation>;

  send(input: {
    readonly authorizationDigest: string;
    readonly effectId: string;
    readonly questionGeneration: number;
    readonly workerId: string;
  }): Promise<AnswerEffectDeliveryResult>;

  cancelBeforeRequest(input: {
    readonly questionId: string;
    readonly reason: "authorization_drift" | "binding_drift";
  }): Promise<boolean>;
}

export interface LocalFinalReplyPolicy {
  readonly admission: QuestionAdmissionRatePolicy;
  readonly answerMessageMaximumCharacters: number;
  readonly authorizationPolicyVersion: string;
  readonly groundingSafety: GroundingSafetyLimits;
  readonly jobLeaseSeconds: number;
  readonly maximumProviderAttempts: number;
  readonly policyVersion: string;
  readonly retrieval: {
    readonly maximumCandidates: number;
    readonly neighborTurns: number;
  };
  readonly retrievalAdmission: RetrievalAdmissionRollout;
}
