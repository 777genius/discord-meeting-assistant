import type { GroundingPlan } from "../domain/grounding-plan.js";
import type { QuestionBindingSnapshot } from "../domain/question-job.js";
import {
  authorizedForJob,
  reauthorizeHistoricalPlan,
} from "./final-reply-checks.js";
import { GroundedMeetingAnswer } from "./grounded-meeting-answer.js";
import {
  nextProviderAttemptId,
  providerAttemptAvailable,
  providerAttemptCanRetry,
  recordProviderAttemptOutcome,
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
    if (!providerAttemptAvailable(lease, this.input.policy)) {
      return this.input.publisher.publishFixed(
        lease,
        preparation.authority,
        "unavailable",
      );
    }
    const providerAttemptId = nextProviderAttemptId(lease);
    const request: GroundedAnswerGenerationRequest = {
      attemptId: providerAttemptId,
      binding,
      locale: binding.expectedLocale,
      plan: preparation.plan,
      question: lease.questionText,
    };
    const generated = await this.input.answers.execute(request, {
      beforeGenerate: async () => {
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
        return await reserveProviderAttempt(
          this.input.jobs,
          lease,
          this.input.policy,
          providerAttemptId,
        ) ? "continue" : "stale_generation";
      },
      onMeasured: async (measurement) =>
        await this.input.jobs.persistGroundingPlan({
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
        }) ? "continue" : "stale_generation",
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
    if (!await recordProviderAttemptOutcome(
      this.input.jobs,
      lease,
      providerAttemptId,
      generated.status === "failed" ? "failed" : "completed",
    )) {
      return { jobId: lease.jobId, status: "stale_generation" };
    }
    if (generated.status === "failed") {
      return this.handleFailure(lease, preparation.authority, generated.retryable);
    }
    if (generated.status !== "completed") {
      return this.input.publisher.publishFixed(
        lease,
        preparation.authority,
        "unavailable",
      );
    }
    const answerCandidate = generated.answer.toSnapshot();
    if (!await this.input.jobs.markReady({
      answerCandidate,
      generation: lease.generation,
      jobId: lease.jobId,
    })) {
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

  private async handleFailure(
    lease: QuestionJobLease,
    authority: CurrentFinalReplyBinding,
    retryable: boolean,
  ): Promise<FinalReplyJobResult> {
    if (retryable && providerAttemptCanRetry(lease, this.input.policy)) {
      const released = await this.input.jobs.releaseForRetry({
        generation: lease.generation,
        jobId: lease.jobId,
        reason: "provider_failure",
      });
      return released
        ? { jobId: lease.jobId, status: "deferred" }
        : { jobId: lease.jobId, status: "stale_generation" };
    }
    return this.input.publisher.publishFixed(lease, authority, "unavailable");
  }
}
