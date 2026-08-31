import {
  createExhaustiveCoverageGroundingPlan,
  type GroundingPlan,
  type RehydratedEvidenceTurn,
} from "../domain/grounding-plan.js";
import type { QuestionBindingSnapshot } from "../domain/question-job.js";
import { authorizationObservationUnavailable, authorityMatchesBinding,
  authorizedForJob } from "./final-reply-checks.js";
import { admittedHumanActors } from "./admitted-human-evidence.js";
import type {
  CurrentFinalReplyBinding,
  ExhaustiveMemoryRetrievalPort,
  ExhaustiveMemoryRetrievalRequest,
  FinalReplyEvidencePort,
  QuestionAuthorizationObservation,
  QuestionJobLease,
  QuestionJobTerminalOutcome,
} from "./ports/final-reply.js";

export type ExhaustiveFinalReplyPreparation =
  | {
      readonly status: "deferred";
    }
  | {
      readonly authority: CurrentFinalReplyBinding;
      readonly exhaustive: ExhaustiveMemoryRetrievalRequest & {
        readonly coveragePlanDigest: string;
      };
      readonly plan: GroundingPlan;
      readonly status: "prepared";
    }
  | {
      readonly outcome: Extract<
        QuestionJobTerminalOutcome,
        | "insufficient_evidence"
        | "processing"
        | "unavailable"
        | "unsupported_size"
      >;
      readonly publication: "fixed";
      readonly status: "settled";
    }
  | {
      readonly outcome: "stale_authorization" | "stale_binding";
      readonly publication: "settle";
      readonly status: "settled";
    };

/** Prepares one every-block plan without coupling coverage to publication. */
export async function prepareExhaustiveFinalReply(input: {
  readonly authority: CurrentFinalReplyBinding;
  readonly binding: QuestionBindingSnapshot;
  readonly evidence: FinalReplyEvidencePort;
  readonly exhaustiveMemory?: ExhaustiveMemoryRetrievalPort;
  readonly lease: QuestionJobLease;
  readonly observeBeforeHydration: () => Promise<QuestionAuthorizationObservation>;
}): Promise<ExhaustiveFinalReplyPreparation> {
  if (input.exhaustiveMemory === undefined) {
    return fixed("insufficient_evidence");
  }
  const request: ExhaustiveMemoryRetrievalRequest = {
    authorizationPrincipalRef: input.binding.authorizationPrincipalRef,
    expectedAuthorityGeneration: input.binding.memoryGeneration,
    question: input.lease.questionText,
    requestId: input.lease.jobId,
    roomId: input.binding.roomId,
    scopeId: input.binding.scopeId,
  };
  let selected;
  try {
    selected = await input.exhaustiveMemory.retrieve(request);
  } catch {
    return fixed("unavailable");
  }
  if (selected.status !== "current") {
    if (selected.status === "unauthorized") {
      return settle("stale_authorization");
    }
    if (selected.status === "stale") {
      return settle("stale_binding");
    }
    return fixed(selected.status === "incomplete"
      ? "processing"
      : selected.status === "insufficient_evidence"
        ? "insufficient_evidence"
      : selected.status === "unsupported"
        ? "unsupported_size"
        : "unavailable");
  }
  if (
    selected.authorityGeneration !== input.binding.memoryGeneration ||
    (selected.candidates.length === 0 &&
      selected.coverageReduction.selectionStatus !== "no_match")
  ) {
    return settle("stale_binding");
  }
  const beforeHydration = await input.observeBeforeHydration();
  const authorizationFailure = exhaustiveAuthorizationFailure(beforeHydration, input);
  if (authorizationFailure !== null) {return authorizationFailure;}
  let preparedAuthority: CurrentFinalReplyBinding;
  let preparedTurns: readonly RehydratedEvidenceTurn[];
  if (selected.candidates.length === 0) {
    const observed = await recheckAbsenceAuthority(input);
    if (observed.status !== "current" ||
      !authorityMatchesBinding(observed.binding, input.binding)) {
      return settle("stale_binding");
    }
    preparedAuthority = observed.binding;
    preparedTurns = [];
  } else {
    const hydrated = await input.evidence.rehydrateSelectedEvidence(
      input.binding,
      selected.candidates,
    );
    if (hydrated.status !== "current" ||
      !authorityMatchesBinding(hydrated.binding, input.binding)) {
      return settle("stale_binding");
    }
    preparedAuthority = hydrated.binding;
    preparedTurns = hydrated.turns;
  }
  try {
    return {
      authority: preparedAuthority,
      exhaustive: {
        ...request,
        coveragePlanDigest: selected.coveragePlanDigest,
      },
      plan: createExhaustiveCoverageGroundingPlan({
        authorityGeneration: selected.authorityGeneration,
        coverageBitmap: selected.coverageBitmap,
        coveragePlanDigest: selected.coveragePlanDigest,
        coverageReduction: selected.coverageReduction,
        humanActorIds: preparedTurns.length > 0
          ? admittedHumanActors({
              binding: preparedAuthority,
              status: "current",
              turns: preparedTurns,
            })
          : preparedAuthority.humanActorIds,
        turns: preparedTurns,
      }),
      status: "prepared",
    };
  } catch {
    return fixed("unsupported_size");
  }
}

function exhaustiveAuthorizationFailure(
  observation: QuestionAuthorizationObservation,
  input: Pick<Parameters<typeof prepareExhaustiveFinalReply>[0], "authority" | "binding">,
): ExhaustiveFinalReplyPreparation | null {
  if (authorizationObservationUnavailable(observation)) {return { status: "deferred" };}
  return authorizedForJob(observation, input.authority, input.binding)
    ? null : settle("stale_authorization");
}

async function recheckAbsenceAuthority(input: {
  readonly binding: QuestionBindingSnapshot;
  readonly evidence: FinalReplyEvidencePort;
}) {
  return input.evidence.recheckCurrentBinding(input.binding);
}

function fixed(
  outcome:
    | "insufficient_evidence"
    | "processing"
    | "unavailable"
    | "unsupported_size",
): ExhaustiveFinalReplyPreparation {
  return { outcome, publication: "fixed", status: "settled" };
}

function settle(
  outcome: "stale_authorization" | "stale_binding",
): ExhaustiveFinalReplyPreparation {
  return { outcome, publication: "settle", status: "settled" };
}
