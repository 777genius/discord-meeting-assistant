import type { GroundingPlan } from "../domain/grounding-plan.js";
import type { QuestionBindingSnapshot } from "../domain/question-job.js";
import {
  authorizedForJob,
  reauthorizeHistoricalPlan,
} from "./final-reply-checks.js";
import { GroundedMeetingAnswer } from "./grounded-meeting-answer.js";
import {
  completeProviderAttempt,
  failProviderAttempt,
  nextProviderAttemptId,
  providerAttemptAvailable,
  reserveProviderAttempt,
} from "./provider-attempt-accounting.js";
import {
  PublishFinalReply,
  type FinalReplyJobResult,
} from "./publish-final-reply.js";
import type {
  CurrentFinalReplyBinding,
  ExhaustiveMemoryRetrievalPort,
  ExhaustiveMemoryRetrievalRequest,
  FocusedMemoryRetrievalPort,
  GroundedAnswerGenerationRequest,
  LocalFinalReplyPolicy,
  QuestionAuthorizationObservation,
  QuestionAuthorizationPort,
  QuestionJobLease,
  QuestionJobStore,
} from "./ports/final-reply.js";

export interface PreparedAnswerGrounding {
  readonly authority: CurrentFinalReplyBinding;
  readonly exhaustive?: ExhaustiveMemoryRetrievalRequest & {
    readonly coveragePlanDigest: string;
  };
  readonly plan: GroundingPlan;
  readonly providerAttemptId?: string;
}

export class FinalReplyAnswerGeneration {
  public constructor(
    private readonly input: {
      readonly answers: GroundedMeetingAnswer;
      readonly authorization: QuestionAuthorizationPort;
      readonly exhaustiveMemory?: ExhaustiveMemoryRetrievalPort;
      readonly jobs: QuestionJobStore;
      readonly memory: FocusedMemoryRetrievalPort;
      readonly policy: LocalFinalReplyPolicy;
      readonly publisher: PublishFinalReply;
    },
  ) {}

  public async execute(
    lease: QuestionJobLease,
    binding: QuestionBindingSnapshot,
    preparation: PreparedAnswerGrounding,
  ): Promise<FinalReplyJobResult> {
    if (
      preparation.providerAttemptId === undefined &&
      !providerAttemptAvailable(lease, this.input.policy)
    ) {
      return this.input.publisher.publishFixed(
        lease,
        preparation.authority,
        "unavailable",
      );
    }
    const providerAttemptId = preparation.providerAttemptId ??
      nextProviderAttemptId(lease);
    const request: GroundedAnswerGenerationRequest = {
      attemptId: providerAttemptId,
      binding,
      locale: binding.expectedLocale,
      plan: preparation.plan,
      question: lease.questionText,
    };
    const generated = await this.input.answers.execute(request, {
      beforeGenerate: async (measurement) => {
        if (!await reauthorizeHistoricalPlan(
          this.input.memory,
          binding,
          preparation.plan,
        )) {
          return "stale_authorization";
        }
        if (
          preparation.exhaustive !== undefined &&
          (this.input.exhaustiveMemory === undefined ||
            !await this.input.exhaustiveMemory.recheck(preparation.exhaustive))
        ) {
          return "stale_binding";
        }
        const beforeGeneration = await this.observe(lease);
        if (!authorizedForJob(beforeGeneration, preparation.authority, binding)) {
          return "stale_authorization";
        }
        if (!await this.input.jobs.persistGroundingPlan({
          binding,
          generation: lease.generation,
          jobId: lease.jobId,
          measurement,
          plan: preparation.plan,
          runtimeProfile: measurement.runtimeProfile,
          sourceMeetingIds: Object.freeze([...new Set([
            binding.meetingId,
            ...preparation.plan.evidence.map((turn) =>
              turn.source?.meetingId ?? binding.meetingId
            ),
          ])].toSorted()),
        })) {
          return "stale_generation";
        }
        return preparation.providerAttemptId !== undefined
          ? "continue"
          : await reserveProviderAttempt(
              this.input.jobs,
              lease,
              this.input.policy,
              providerAttemptId,
            ) ? "continue" : "stale_generation";
      },
    });
    if (generated.status === "stopped") {
      return generated.checkpoint === "stale_generation"
        ? { jobId: lease.jobId, status: "stale_generation" }
        : this.input.publisher.settle(
            lease,
            generated.checkpoint === "stale_binding"
              ? "stale_binding"
              : "stale_authorization",
          );
    }
    if (generated.status === "unsupported_size") {
      return this.input.publisher.publishFixed(
        lease,
        preparation.authority,
        "unsupported_size",
      );
    }
    if (generated.status !== "completed") {
      const disposition = await failProviderAttempt(
        this.input.jobs,
        lease,
        this.input.policy,
        providerAttemptId,
        {
          reason: generated.status === "failed"
            ? generated.code
            : "provider_" + generated.status,
          retryable: generated.status === "failed" && generated.retryable,
        },
      );
      if (disposition === "stale") {
        return { jobId: lease.jobId, status: "stale_generation" };
      }
      return disposition === "deferred"
        ? { jobId: lease.jobId, status: "deferred" }
        : { jobId: lease.jobId, outcome: "unavailable", status: "settled" };
    }
    const answerCandidate = generated.answer.toSnapshot();
    if (!await completeProviderAttempt(
      this.input.jobs,
      lease,
      providerAttemptId,
      answerCandidate,
    )) {
      return { jobId: lease.jobId, status: "stale_generation" };
    }
    return this.input.publisher.publishCandidate(
      lease,
      preparation.authority,
      preparation.plan,
      answerCandidate,
    );
  }

  private observe(lease: QuestionJobLease): Promise<QuestionAuthorizationObservation> {
    return this.input.authorization.observe({
      authorizationPrincipalRef: lease.binding.authorizationPrincipalRef,
      checkpoint: "before_generation",
      expectedContainerId: lease.binding.projectionTargetContainerId,
      expectedScopeId: lease.binding.scopeId,
      questionId: lease.binding.questionId,
    });
  }
}
