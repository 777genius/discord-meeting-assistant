import {
  GroundedAnswer,
  type GroundedAnswerCandidate,
} from "../domain/grounded-answer.js";
import {
  exhaustiveCoverageProvesAbsence,
  type GroundingPlan,
} from "../domain/grounding-plan.js";
import {
  authorityMatchesBinding,
  authorizedForJob,
  planEvidenceIsCurrent,
  rebuildGroundingPlan,
  referencesFromPlan,
  reauthorizeHistoricalPlan,
  sameEvidenceIdentity,
  sameGroundingPlanEvidenceSections,
} from "./final-reply-checks.js";
import { admittedHumanActors } from "./admitted-human-evidence.js";
import type {
  AnswerPublicationPort,
  CurrentFinalReplyBinding,
  FinalReplyEvidencePort,
  ExhaustiveMemoryRetrievalPort,
  FinalReplyRendererPort,
  FocusedMemoryRetrievalPort,
  LocalFinalReplyPolicy,
  QuestionAuthorizationObservation,
  QuestionAuthorizationPort,
  QuestionJobLease,
  QuestionJobStore,
  QuestionJobTerminalOutcome,
} from "./ports/final-reply.js";

export type FinalReplyJobResult = {
  readonly jobId: string;
  readonly outcome?: QuestionJobTerminalOutcome;
  readonly status: "deferred" | "settled" | "stale_generation";
};

function effectMarker(jobId: string): string {
  return `meeting-knowledge-answer:v1:${jobId}`;
}

interface PublicationFences {
  readonly coverageCurrent?: () => Promise<boolean>;
  readonly historicalAuthorizationCurrent?: () => Promise<boolean>;
  readonly sourceMeetingIds?: readonly string[];
}

function sourceMeetingsForPlan(
  lease: QuestionJobLease,
  plan: GroundingPlan,
): readonly string[] {
  return Object.freeze([...new Set([
    lease.binding.meetingId,
    ...plan.evidence.map((turn) => turn.source?.meetingId ?? lease.binding.meetingId),
  ])].toSorted());
}

async function fenceIsCurrent(
  fence: (() => Promise<boolean>) | undefined,
): Promise<boolean> {
  return fence === undefined || await fence();
}

export class PublishFinalReply {
  private readonly authorization: QuestionAuthorizationPort;
  private readonly evidence: FinalReplyEvidencePort;
  private readonly exhaustiveMemory: ExhaustiveMemoryRetrievalPort | undefined;
  private readonly jobs: QuestionJobStore;
  private readonly memory: FocusedMemoryRetrievalPort;
  private readonly publication: AnswerPublicationPort;
  private readonly renderer: FinalReplyRendererPort;
  private readonly policy: LocalFinalReplyPolicy;
  private readonly workerId: string;

  public constructor(input: {
    readonly authorization: QuestionAuthorizationPort;
    readonly evidence: FinalReplyEvidencePort;
    readonly exhaustiveMemory?: ExhaustiveMemoryRetrievalPort;
    readonly jobs: QuestionJobStore;
    readonly memory: FocusedMemoryRetrievalPort;
    readonly publication: AnswerPublicationPort;
    readonly renderer: FinalReplyRendererPort;
    readonly policy: LocalFinalReplyPolicy;
    readonly workerId: string;
  }) {
    this.authorization = input.authorization;
    this.evidence = input.evidence;
    this.exhaustiveMemory = input.exhaustiveMemory;
    this.jobs = input.jobs;
    this.memory = input.memory;
    this.publication = input.publication;
    this.renderer = input.renderer;
    this.policy = input.policy;
    this.workerId = input.workerId;
  }

  public async publishCandidate(
    lease: QuestionJobLease,
    previousAuthority: CurrentFinalReplyBinding,
    plan: GroundingPlan,
    candidate: GroundedAnswerCandidate,
  ): Promise<FinalReplyJobResult> {
    const coverage = await this.resolveCoverageRecheck(lease, plan);
    if (coverage.status === "stale") {
      return this.settle(lease, "stale_binding");
    }
    const coverageCurrent = coverage.recheck;
    const historicalAuthorizationCurrent = () => reauthorizeHistoricalPlan(this.memory, lease.binding, plan);
    const publicationEvidenceCurrent = () => planEvidenceIsCurrent(this.evidence, lease.binding, plan, coverageCurrent);
    if (!await historicalAuthorizationCurrent()) {
      return this.settle(lease, "stale_authorization");
    }
    const beforeHydration = await this.observe(lease, "before_hydration");
    if (!authorizedForJob(beforeHydration, previousAuthority, lease.binding)) {
      return this.settle(lease, "stale_authorization");
    }
    const absenceProven = exhaustiveCoverageProvesAbsence(plan);
    const rehydrated = absenceProven
      ? await recheckAbsenceAuthority(this.evidence, lease.binding)
      : await this.evidence.rehydrateSelectedEvidence(
          lease.binding,
          referencesFromPlan(lease.binding, plan),
        );
    if (
      rehydrated.status !== "current" ||
      !authorityMatchesBinding(rehydrated.binding, lease.binding) ||
      !authorityMatchesBinding(previousAuthority, lease.binding)
    ) {
      return this.settle(lease, "stale_binding");
    }
    let currentPlan: GroundingPlan;
    try {
      const humanActorIds = admittedHumanActors(rehydrated);
      currentPlan = rebuildGroundingPlan(plan, rehydrated.turns, humanActorIds);
    } catch {
      return this.publishFixed(lease, rehydrated.binding, "unavailable");
    }
    if (
      !sameEvidenceIdentity(plan.evidence, currentPlan.evidence) ||
      !sameGroundingPlanEvidenceSections(plan, currentPlan)
    ) {
      return this.settle(lease, "stale_binding");
    }
    let answer;
    try {
      answer = GroundedAnswer.create({
        candidate,
        evidence: currentPlan.evidence,
        expectedLocale: lease.binding.expectedLocale,
        exhaustiveAbsenceProven: absenceProven,
        groundingMode: currentPlan.mode,
        question: lease.questionText,
      });
    } catch {
      return this.publishFixed(lease, rehydrated.binding, "unavailable");
    }
    if (answer.status === "insufficient_evidence") {
      return this.publishFixed(lease, rehydrated.binding, "insufficient_evidence");
    }
    if (answer.status === "not_a_question") {
      return this.publishFixed(lease, rehydrated.binding, "not_a_question");
    }
    try {
      return this.publishRendered(
        lease,
        rehydrated.binding,
        this.renderer.renderAnswer({
          answer,
          evidence: currentPlan.evidence,
          maximumCharacters: this.policy.answerMessageMaximumCharacters,
        }),
        "answered",
        {
          coverageCurrent: publicationEvidenceCurrent,
          historicalAuthorizationCurrent,
          sourceMeetingIds: sourceMeetingsForPlan(lease, currentPlan),
        },
      );
    } catch {
      return this.publishFixed(lease, rehydrated.binding, "unsupported_size");
    }
  }

  public publishFixed(
    lease: QuestionJobLease,
    authority: CurrentFinalReplyBinding,
    outcome: Extract<
      QuestionJobTerminalOutcome,
      | "insufficient_evidence"
      | "not_a_question"
      | "processing"
      | "unavailable"
      | "unsupported_size"
    >,
  ): Promise<FinalReplyJobResult> {
    return this.publishRendered(
      lease,
      authority,
      this.renderer.renderFixed({
        locale: lease.binding.expectedLocale,
        outcome,
      }),
      outcome,
    );
  }

  public async settle(
    lease: QuestionJobLease,
    outcome: QuestionJobTerminalOutcome,
  ): Promise<FinalReplyJobResult> {
    const settled = await this.jobs.settle({
      generation: lease.generation,
      jobId: lease.jobId,
      outcome,
    });
    return settled
      ? { jobId: lease.jobId, outcome, status: "settled" }
      : { jobId: lease.jobId, status: "stale_generation" };
  }

  private observe(
    lease: QuestionJobLease,
    checkpoint: Parameters<QuestionAuthorizationPort["observe"]>[0]["checkpoint"],
  ): Promise<QuestionAuthorizationObservation> {
    return this.authorization.observe({
      authorizationPrincipalRef: lease.binding.authorizationPrincipalRef,
      checkpoint,
      expectedContainerId: lease.binding.projectionTargetContainerId,
      expectedScopeId: lease.binding.scopeId,
      questionId: lease.binding.questionId,
    });
  }

  private async publishRendered(
    lease: QuestionJobLease,
    authority: CurrentFinalReplyBinding,
    content: string,
    outcome: Extract<
      QuestionJobTerminalOutcome,
      | "answered"
      | "insufficient_evidence"
      | "not_a_question"
      | "processing"
      | "unavailable"
      | "unsupported_size"
    >,
    fences: PublicationFences = {},
  ): Promise<FinalReplyJobResult> {
    if (!await fenceIsCurrent(fences.historicalAuthorizationCurrent)) {
      return this.settle(lease, "stale_authorization");
    }
    const beforeReservation = await this.observe(lease, "before_effect_reservation");
    if (!authorizedForJob(beforeReservation, authority, lease.binding)) {
      return this.settle(lease, "stale_authorization");
    }
    const stillCurrent = await this.evidence.recheckCurrentBinding(lease.binding);
    if (
      stillCurrent.status !== "current" ||
      !authorityMatchesBinding(stillCurrent.binding, lease.binding)
    ) {
      return this.settle(lease, "stale_binding");
    }
    if (!await fenceIsCurrent(fences.coverageCurrent)) {
      return this.settle(lease, "stale_binding");
    }
    if (!await this.activeLease(lease)) {
      return { jobId: lease.jobId, status: "stale_generation" };
    }
    let reservation;
    try {
      reservation = await this.publication.reserve({
        authorizationDigest: beforeReservation.digest,
        binding: lease.binding,
        content,
        deliveryContainerId: lease.binding.deliveryContainerId,
        marker: effectMarker(lease.jobId),
        projectionTargetContainerId: stillCurrent.binding.projectionTargetContainerId,
        questionGeneration: lease.generation,
        replyToRemoteMessageId: lease.binding.questionId,
        sourceMeetingIds: fences.sourceMeetingIds ?? [lease.binding.meetingId],
      });
    } catch {
      return this.settle(lease, "unavailable");
    }
    if (reservation.status === "already_delivered") {
      return this.settle(lease, outcome);
    }
    if (reservation.status === "rejected_before_request") {
      return { jobId: lease.jobId, status: "stale_generation" };
    }
    const beforeSend = await this.observe(lease, "before_send_cas");
    if (!authorizedForJob(beforeSend, stillCurrent.binding, lease.binding)) {
      return this.cancelReservedAndSettle(
        lease,
        "authorization_drift",
        "stale_authorization",
      );
    }
    if (
      !await fenceIsCurrent(fences.historicalAuthorizationCurrent)
    ) {
      return this.cancelReservedAndSettle(
        lease,
        "authorization_drift",
        "stale_authorization",
      );
    }
    const preEffectEvidence = await this.evidence.recheckCurrentBinding(lease.binding);
    if (
      preEffectEvidence.status !== "current" ||
      !authorityMatchesBinding(preEffectEvidence.binding, lease.binding)
    ) {
      return this.cancelReservedAndSettle(
        lease,
        "binding_drift",
        "stale_binding",
      );
    }
    if (!await fenceIsCurrent(fences.coverageCurrent)) {
      return this.cancelReservedAndSettle(
        lease,
        "binding_drift",
        "stale_binding",
      );
    }
    if (!await this.activeLease(lease)) {
      await this.publication.cancelBeforeRequest({
        questionId: lease.binding.questionId,
        reason: "binding_drift",
      });
      return { jobId: lease.jobId, status: "stale_generation" };
    }
    const delivery = await this.publication.send({
      authorizationDigest: beforeSend.digest,
      effectId: reservation.effectId,
      questionGeneration: lease.generation,
      workerId: this.workerId,
    });
    if (delivery.status === "delivered") {
      return this.settle(lease, outcome);
    }
    return this.settle(
      lease,
      delivery.status === "outcome_unknown" ? "delivery_unknown" : "unavailable",
    );
  }

  private activeLease(lease: QuestionJobLease): Promise<boolean> {
    return this.jobs.confirmActiveLease({
      generation: lease.generation,
      jobId: lease.jobId,
    });
  }

  private coverageRecheck(
    lease: QuestionJobLease,
    plan: GroundingPlan,
  ): (() => Promise<boolean>) | undefined {
    const digest = plan.coveragePlanDigest;
    if (this.exhaustiveMemory === undefined || digest === undefined) {
      return undefined;
    }
    return () => this.exhaustiveMemory?.recheck({
      authorizationPrincipalRef: lease.binding.authorizationPrincipalRef,
      coveragePlanDigest: digest,
      expectedAuthorityGeneration: lease.binding.memoryGeneration,
      question: lease.questionText,
      requestId: lease.jobId,
      roomId: lease.binding.roomId,
      scopeId: lease.binding.scopeId,
    }) ?? Promise.resolve(false);
  }

  private async resolveCoverageRecheck(
    lease: QuestionJobLease,
    plan: GroundingPlan,
  ): Promise<
    | { readonly recheck?: () => Promise<boolean>; readonly status: "current" }
    | { readonly status: "stale" }
  > {
    if (plan.authorityGeneration !== lease.binding.memoryGeneration) {
      return { status: "stale" };
    }
    if (plan.mode !== "exhaustive_coverage") {
      return { status: "current" };
    }
    const recheck = this.coverageRecheck(lease, plan);
    return recheck !== undefined && await recheck()
      ? { recheck, status: "current" }
      : { status: "stale" };
  }

  private async cancelReservedAndSettle(
    lease: QuestionJobLease,
    reason: "authorization_drift" | "binding_drift",
    outcome: "stale_authorization" | "stale_binding",
  ): Promise<FinalReplyJobResult> {
    const cancelled = await this.publication.cancelBeforeRequest({
      questionId: lease.binding.questionId,
      reason,
    });
    return this.settle(lease, cancelled ? outcome : "delivery_unknown");
  }
}

async function recheckAbsenceAuthority(
  evidence: FinalReplyEvidencePort,
  binding: QuestionJobLease["binding"],
) {
  const current = await evidence.recheckCurrentBinding(binding);
  return current.status === "current"
    ? { binding: current.binding, status: "current" as const, turns: [] }
    : current;
}
