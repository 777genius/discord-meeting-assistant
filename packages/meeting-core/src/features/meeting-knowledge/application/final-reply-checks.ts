import {
  createExhaustiveCoverageGroundingPlan,
  createFocusedRetrievalGroundingPlan,
  type FocusedMemoryReference,
  type GroundingEvidence,
  type GroundingPlan,
  type RehydratedEvidenceTurn,
} from "../domain/grounding-plan.js";
import type { QuestionBindingSnapshot } from "../domain/question-job.js";
import type {
  CurrentFinalReplyBinding,
  FocusedMemoryRetrievalPort,
  QuestionAuthorizationObservation,
} from "./ports/final-reply.js";

export function authorityMatchesBinding(
  authority: CurrentFinalReplyBinding,
  binding: QuestionBindingSnapshot,
): boolean {
  return sameOpaqueSet(authority.humanActorIds, binding.humanActorIds) &&
    authority.botApplicationIdentity === binding.botApplicationIdentity &&
    authority.canonicalEvidenceHash === binding.canonicalEvidenceHash &&
    authority.finalProjectionEpoch === binding.finalProjectionEpoch &&
    authority.finalProjectionReceipt === binding.finalProjectionReceipt &&
    authority.meetingId === binding.meetingId &&
    authority.meetingRevision === binding.meetingRevision &&
    authority.memoryGeneration === binding.memoryGeneration &&
    authority.projectionTargetContainerId === binding.projectionTargetContainerId &&
    authority.roomId === binding.roomId &&
    authority.scopeId === binding.scopeId &&
    authority.transcriptId === binding.transcriptId &&
    authority.transcriptVersion === binding.transcriptVersion;
}

function sameOpaqueSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

export function authorizedForJob(
  observation: QuestionAuthorizationObservation,
  authority: CurrentFinalReplyBinding,
  binding: QuestionBindingSnapshot,
): observation is Extract<
  QuestionAuthorizationObservation,
  { readonly status: "authorized" }
> {
  return observation.status === "authorized" &&
    observation.digest === binding.authorizationDigest &&
    observation.deliveryContainerId === binding.deliveryContainerId &&
    observation.policyVersion === binding.authorizationPolicyVersion &&
    observation.scopeId === binding.scopeId &&
    observation.containerId === authority.projectionTargetContainerId &&
    authority.humanActorIds.includes(observation.actorId);
}

export function referencesFromPlan(
  binding: QuestionBindingSnapshot,
  plan: GroundingPlan,
): readonly FocusedMemoryReference[] {
  return Object.freeze(plan.evidence.map(({ source, turnHash, turnId }) => Object.freeze({
    meetingId: source?.meetingId ?? binding.meetingId,
    ...(source?.sourceEndCodePoint === undefined
      ? {}
      : {
          sourceEndCodePoint: source.sourceEndCodePoint,
          sourceStartCodePoint: source.sourceStartCodePoint,
        }),
    transcriptId: source?.transcriptId ?? binding.transcriptId,
    transcriptVersion: source?.transcriptVersion ?? binding.transcriptVersion,
    turnHash,
    turnId,
  })));
}

export function sameEvidenceIdentity(
  left: readonly GroundingEvidence[],
  right: readonly GroundingEvidence[],
): boolean {
  return left.length === right.length && left.every((item, index) => {
    const candidate = right[index];
    return candidate !== undefined && sameEvidenceItem(item, candidate);
  });
}

function sameEvidenceItem(left: GroundingEvidence, right: GroundingEvidence): boolean {
  return left.evidenceId === right.evidenceId &&
    left.turnHash === right.turnHash &&
    left.turnId === right.turnId &&
    sameEvidenceSource(left.source, right.source) &&
    left.speakerId === right.speakerId &&
    left.startMs === right.startMs &&
    left.endMs === right.endMs &&
    left.text === right.text;
}

function sameEvidenceSource(
  left: GroundingEvidence["source"],
  right: GroundingEvidence["source"],
): boolean {
  return left?.meetingId === right?.meetingId &&
    left?.sourceStartCodePoint === right?.sourceStartCodePoint &&
    left?.sourceEndCodePoint === right?.sourceEndCodePoint &&
    left?.transcriptId === right?.transcriptId &&
    left?.transcriptVersion === right?.transcriptVersion;
}

export function rebuildGroundingPlan(
  plan: GroundingPlan,
  turns: readonly RehydratedEvidenceTurn[],
  humanActorIds: readonly string[],
): GroundingPlan {
  if (plan.mode === "focused_retrieval") {
    return createFocusedRetrievalGroundingPlan({
      authorityGeneration: plan.authorityGeneration,
      coverage: "sufficient",
      humanActorIds,
      turns,
    });
  }
  return createExhaustiveCoverageGroundingPlan({
    authorityGeneration: plan.authorityGeneration,
    coverageBitmap: plan.coverageBitmap ?? [],
    coveragePlanDigest: plan.coveragePlanDigest ?? "",
    coverageReduction: plan.coverageReduction ?? {
      evidenceBlockCount: 0,
      payload: {},
      schemaVersion: 1,
      selectionStatus: "no_match",
      selectedCanonicalTurnCount: 0,
      selectedEvidenceBlockCount: 0,
    },
    humanActorIds,
    turns,
  });
}

export function sameGroundingPlanEvidenceSections(
  left: GroundingPlan,
  right: GroundingPlan,
): boolean {
  return left.mode === right.mode;
}

function planUsesHistoricalEvidence(
  binding: QuestionBindingSnapshot,
  plan: GroundingPlan,
): boolean {
  return plan.evidence.some(({ source }) =>
    source !== undefined && (
      source.meetingId !== binding.meetingId ||
      source.transcriptId !== binding.transcriptId ||
      source.transcriptVersion !== binding.transcriptVersion
    )
  );
}

/** A missing historical authorization capability is a fail-closed denial. */
export function reauthorizeHistoricalPlan(
  memory: FocusedMemoryRetrievalPort,
  binding: QuestionBindingSnapshot,
  plan: GroundingPlan,
): Promise<boolean> {
  if (!planUsesHistoricalEvidence(binding, plan)) {
    return Promise.resolve(true);
  }
  return memory.reauthorizeHistoricalEvidence?.({
    authorizationPrincipalRef: binding.authorizationPrincipalRef,
    roomId: binding.roomId,
    scopeId: binding.scopeId,
  }) ?? Promise.resolve(false);
}
