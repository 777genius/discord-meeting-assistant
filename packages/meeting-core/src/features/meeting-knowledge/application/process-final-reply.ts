import { requiresExhaustiveCoverage } from "../domain/question-scope.js";
import {
  type GroundingPlan,
} from "../domain/grounding-plan.js";
import {
  QuestionBinding,
  type QuestionBindingSnapshot,
} from "../domain/question-job.js";
import {
  authorityMatchesBinding,
  authorizedForJob,
  reauthorizeHistoricalPlan,
} from "./final-reply-checks.js";
import { admittedHumanActors } from "./admitted-human-evidence.js";
import { prepareExhaustiveFinalReply } from "./exhaustive-final-reply.js";
import { GroundedMeetingAnswer } from "./grounded-meeting-answer.js";
import {
  fixedOutcomeForFocusedRetrieval,
  createPlanFromFocusedHydration,
  mergeFocusedHydrationReferences,
  retrieveFocusedMemory,
} from "./ports/focused-memory-contract.js";
import {
  PublishFinalReply,
  type FinalReplyJobResult,
} from "./publish-final-reply.js";
import type {
  AnswerPublicationPort,
  CurrentFinalReplyBinding,
  ExhaustiveMemoryRetrievalPort,
  ExhaustiveMemoryRetrievalRequest,
  FinalReplyEvidencePort,
  FinalReplyRendererPort,
  FocusedMemoryRetrievalPort,
  GroundedAnswerGenerationRequest,
  GroundedAnswerGenerator,
  LocalFinalReplyPolicy,
  QuestionAuthorizationObservation,
  QuestionAuthorizationPort,
  QuestionJobLease,
  QuestionJobStore,
} from "./ports/final-reply.js";

export type ProcessFinalReplyResult =
  | { readonly status: "idle" }
  | FinalReplyJobResult;

type GroundingPreparation =
  | {
      readonly authority: CurrentFinalReplyBinding;
      readonly exhaustive?: ExhaustiveMemoryRetrievalRequest & {
        readonly coveragePlanDigest: string;
      };
      readonly plan: GroundingPlan;
      readonly status: "prepared";
    }
  | {
      readonly result: FinalReplyJobResult;
      readonly status: "settled";
    };

function attemptId(lease: QuestionJobLease): string {
  return `${lease.jobId}:generation:${lease.generation}:attempt:${lease.attempts}`;
}

export class ProcessFinalReplyJob {
  private readonly answers: GroundedMeetingAnswer;
  private readonly publisher: PublishFinalReply;

  public constructor(
    private readonly input: {
      readonly answerPublication: AnswerPublicationPort;
      readonly answers?: GroundedMeetingAnswer;
      readonly authorization: QuestionAuthorizationPort;
      readonly evidence: FinalReplyEvidencePort;
      readonly exhaustiveMemory?: ExhaustiveMemoryRetrievalPort;
      readonly generator: GroundedAnswerGenerator;
      readonly jobs: QuestionJobStore;
      readonly memory: FocusedMemoryRetrievalPort;
      readonly policy: LocalFinalReplyPolicy;
      readonly renderer: FinalReplyRendererPort;
      readonly workerId: string;
    },
  ) {
    this.answers = input.answers ?? new GroundedMeetingAnswer(
      input.generator,
      input.policy.groundingSafety,
    );
    this.publisher = new PublishFinalReply({
      authorization: input.authorization,
      evidence: input.evidence,
      ...(input.exhaustiveMemory === undefined
        ? {}
        : { exhaustiveMemory: input.exhaustiveMemory }),
      jobs: input.jobs,
      memory: input.memory,
      policy: input.policy,
      publication: input.answerPublication,
      renderer: input.renderer,
      workerId: input.workerId,
    });
  }

  public async executeOnce(): Promise<ProcessFinalReplyResult> {
    const lease = await this.input.jobs.leaseNext({
      leaseSeconds: this.input.policy.jobLeaseSeconds,
      workerId: this.input.workerId,
    });
    if (lease === null) {
      return { status: "idle" };
    }
    const binding = QuestionBinding.create(lease.binding).toSnapshot();
    if (
      lease.state === "ready" &&
      lease.answerCandidate !== null &&
      lease.groundingPlan !== null
    ) {
      return this.resumeReady(lease, binding);
    }
    const preparation = await this.prepareFocusedGrounding(lease, binding);
    return preparation.status === "prepared"
      ? this.generateAndPublish(lease, binding, preparation)
      : preparation.result;
  }

  private async resumeReady(
    lease: QuestionJobLease,
    binding: QuestionBindingSnapshot,
  ): Promise<FinalReplyJobResult> {
    const current = await this.input.evidence.recheckCurrentBinding(binding);
    if (
      current.status !== "current" ||
      !authorityMatchesBinding(current.binding, binding) ||
      lease.answerCandidate === null ||
      lease.groundingPlan === null
    ) {
      return this.publisher.settle(lease, "stale_binding");
    }
    if (
      lease.groundingPlan.mode === "exhaustive_coverage" &&
      (
        lease.groundingPlan.coveragePlanDigest === undefined ||
        lease.groundingPlan.coverageReduction === undefined ||
        this.input.exhaustiveMemory === undefined ||
        !await this.input.exhaustiveMemory.recheck({
          authorizationPrincipalRef: binding.authorizationPrincipalRef,
          coveragePlanDigest: lease.groundingPlan.coveragePlanDigest,
          expectedAuthorityGeneration: binding.memoryGeneration,
          question: lease.questionText,
          requestId: lease.jobId,
          roomId: binding.roomId,
          scopeId: binding.scopeId,
        })
      )
    ) {
      return this.publisher.settle(lease, "stale_binding");
    }
    return this.publisher.publishCandidate(
      lease,
      current.binding,
      lease.groundingPlan,
      lease.answerCandidate,
    );
  }

  private async prepareFocusedGrounding(
    lease: QuestionJobLease,
    binding: QuestionBindingSnapshot,
  ): Promise<GroundingPreparation> {
    const beforeRetrieval = await this.observe(lease, "before_retrieval");
    if (beforeRetrieval.status !== "authorized") {
      return this.settled(await this.publisher.settle(lease, "stale_authorization"));
    }
    const current = await this.input.evidence.recheckCurrentBinding(binding);
    if (
      current.status !== "current" ||
      !authorityMatchesBinding(current.binding, binding)
    ) {
      return this.settled(await this.publisher.settle(lease, "stale_binding"));
    }
    if (!authorizedForJob(beforeRetrieval, current.binding, binding)) {
      return this.settled(await this.publisher.settle(lease, "stale_authorization"));
    }
    if (requiresExhaustiveCoverage(lease.questionText)) {
      return this.prepareExhaustiveGrounding(lease, binding, current.binding);
    }
    const retrieval = await retrieveFocusedMemory(this.input.memory, {
      authorizationPrincipalRef: binding.authorizationPrincipalRef,
      canonicalEvidenceHash: binding.canonicalEvidenceHash,
      expectedAuthorityGeneration: binding.memoryGeneration,
      finalProjectionReceipt: binding.finalProjectionReceipt,
      maximumCandidates: this.input.policy.retrieval.maximumCandidates,
      meetingId: binding.meetingId,
      meetingRevision: binding.meetingRevision,
      neighborTurns: this.input.policy.retrieval.neighborTurns,
      projectionTargetContainerId: binding.projectionTargetContainerId,
      question: lease.questionText,
      roomId: binding.roomId,
      scopeId: binding.scopeId,
      transcriptId: binding.transcriptId,
      transcriptVersion: binding.transcriptVersion,
    });
    if (retrieval.status !== "current") {
      return this.settled(await this.publisher.publishFixed(
        lease,
        current.binding,
        fixedOutcomeForFocusedRetrieval(retrieval),
      ));
    }
    if (
      retrieval.authorityGeneration !== binding.memoryGeneration ||
      retrieval.candidates.length === 0
    ) {
      return this.settled(await this.publisher.publishFixed(
        lease,
        current.binding,
        "processing",
      ));
    }
    const beforeHydration = await this.observe(lease, "before_hydration");
    if (!authorizedForJob(beforeHydration, current.binding, binding)) {
      return this.settled(await this.publisher.settle(lease, "stale_authorization"));
    }
    const hydrationReferences = mergeFocusedHydrationReferences(
      retrieval.candidates,
    );
    const hydrated = await this.input.evidence.rehydrateSelectedEvidence(
      binding,
      hydrationReferences,
    );
    if (hydrated.status !== "current") {
      const result = hydrated.status === "stale"
        ? await this.publisher.settle(lease, "stale_binding")
        : await this.publisher.publishFixed(lease, current.binding, "unavailable");
      return this.settled(result);
    }
    if (!authorityMatchesBinding(hydrated.binding, binding)) {
      return this.settled(await this.publisher.settle(lease, "stale_binding"));
    }
    try {
      const humanActorIds = admittedHumanActors(hydrated);
      return {
        authority: hydrated.binding,
        plan: createPlanFromFocusedHydration(
          retrieval,
          hydrationReferences,
          hydrated.turns,
          humanActorIds,
        ),
        status: "prepared",
      };
    } catch {
      return this.settled(await this.publisher.publishFixed(
        lease,
        current.binding,
        "unavailable",
      ));
    }
  }

  private async generateAndPublish(
    lease: QuestionJobLease,
    binding: QuestionBindingSnapshot,
    preparation: Extract<GroundingPreparation, { readonly status: "prepared" }>,
  ): Promise<FinalReplyJobResult> {
    const request: GroundedAnswerGenerationRequest = {
      attemptId: attemptId(lease),
      binding,
      locale: binding.expectedLocale,
      plan: preparation.plan,
      question: lease.questionText,
    };
    const generated = await this.answers.execute(request, {
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
        const beforeGeneration = await this.observe(lease, "before_generation");
        return authorizedForJob(beforeGeneration, preparation.authority, binding)
          ? "continue"
          : "stale_authorization";
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
        })
          ? "continue"
          : "stale_generation",
    });
    if (generated.status === "stopped") {
      return generated.checkpoint === "stale_generation"
        ? { jobId: lease.jobId, status: "stale_generation" }
        : this.publisher.settle(
            lease,
            generated.checkpoint === "stale_binding"
              ? "stale_binding"
              : "stale_authorization",
          );
    }
    if (generated.status === "unsupported_size") {
      return this.publisher.publishFixed(lease, preparation.authority, "unsupported_size");
    }
    if (generated.status === "failed") {
      return this.handleGenerationFailure(
        lease,
        preparation.authority,
        generated.retryable,
      );
    }
    if (generated.status !== "completed") {
      return this.publisher.publishFixed(lease, preparation.authority, "unavailable");
    }
    const answerCandidate = generated.answer.toSnapshot();
    if (!await this.input.jobs.markReady({
      answerCandidate,
      generation: lease.generation,
      jobId: lease.jobId,
    })) {
      return { jobId: lease.jobId, status: "stale_generation" };
    }
    return this.publisher.publishCandidate(
      lease,
      preparation.authority,
      preparation.plan,
      answerCandidate,
    );
  }

  private async prepareExhaustiveGrounding(
    lease: QuestionJobLease,
    binding: QuestionBindingSnapshot,
    authority: CurrentFinalReplyBinding,
  ): Promise<GroundingPreparation> {
    const prepared = await prepareExhaustiveFinalReply({
      authority,
      binding,
      evidence: this.input.evidence,
      ...(this.input.exhaustiveMemory === undefined
        ? {}
        : { exhaustiveMemory: this.input.exhaustiveMemory }),
      lease,
      observeBeforeHydration: () => this.observe(lease, "before_hydration"),
    });
    if (prepared.status === "prepared") {
      return prepared;
    }
    const result = prepared.publication === "settle"
      ? await this.publisher.settle(lease, prepared.outcome)
      : await this.publisher.publishFixed(lease, authority, prepared.outcome);
    return this.settled(result);
  }

  private observe(
    lease: QuestionJobLease,
    checkpoint: Parameters<QuestionAuthorizationPort["observe"]>[0]["checkpoint"],
  ): Promise<QuestionAuthorizationObservation> {
    return this.input.authorization.observe({
      authorizationPrincipalRef: lease.binding.authorizationPrincipalRef,
      checkpoint,
      expectedContainerId: lease.binding.projectionTargetContainerId,
      expectedScopeId: lease.binding.scopeId,
      questionId: lease.binding.questionId,
    });
  }

  private async handleGenerationFailure(
    lease: QuestionJobLease,
    authority: CurrentFinalReplyBinding,
    retryable: boolean,
  ): Promise<FinalReplyJobResult> {
    if (retryable && lease.attempts < this.input.policy.maximumProviderAttempts) {
      const released = await this.input.jobs.releaseForRetry({
        generation: lease.generation,
        jobId: lease.jobId,
        reason: "provider_failure",
      });
      return released
        ? { jobId: lease.jobId, status: "deferred" }
        : { jobId: lease.jobId, status: "stale_generation" };
    }
    return this.publisher.publishFixed(lease, authority, "unavailable");
  }

  private settled(result: FinalReplyJobResult): GroundingPreparation {
    return { result, status: "settled" };
  }
}
