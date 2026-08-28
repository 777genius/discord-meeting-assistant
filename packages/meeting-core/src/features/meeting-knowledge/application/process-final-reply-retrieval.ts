import { isLegacyQuestionBinding, type QuestionBindingSnapshot } from
  "../domain/question-job.js";
import { createFocusedRetrievalGroundingPlan, type FocusedMemoryReference,
  type RehydratedEvidenceTurn } from "../domain/grounding-plan.js";
import { admittedHumanActors } from "./admitted-human-evidence.js";
import { authorityMatchesBinding } from "./final-reply-checks.js";
import { alignFocusedHydrationSurvivors, prepareSelectedFocusedEvidence,
  type SelectedFocusedEvidencePreparation, type SelectFocusedEvidence } from
  "./select-focused-evidence.js";
import type { FinalReplyEvidencePort, FocusedMemoryRetrievalPort,
  LocalFinalReplyPolicy, QuestionJobLease } from "./ports/final-reply.js";

const localExactLexicalCandidateLimit = 100;
const localExactLexicalResultLimit = 10;
const localExactLexicalEvidenceByteLimit = 16_000;

export function isComposedLocalBinding(
  binding: QuestionBindingSnapshot,
  policy: LocalFinalReplyPolicy,
): boolean {
  if (isLegacyQuestionBinding(binding)) {
    return false;
  }
  const expectedFingerprint = binding.retrievalBinding.retrievalPath ===
      "infinity_locator_v2"
    ? policy.retrievalAdmission.infinityProfileFingerprint
    : binding.retrievalBinding.retrievalPath ===
        "canonical_local_exact_lexical_v1"
      ? policy.retrievalAdmission.localProfileFingerprint
      : null;
  return expectedFingerprint !== null &&
    binding.retrievalBinding.profileFingerprint === expectedFingerprint &&
    binding.retrievalBinding.cutoverEpoch === policy.retrievalAdmission.cutoverEpoch;
}

export function focusedMemoryRequest(
  binding: QuestionBindingSnapshot,
  lease: QuestionJobLease,
  policy: LocalFinalReplyPolicy,
): Parameters<FocusedMemoryRetrievalPort["retrieve"]>[0] {
  return {
    authorizationPrincipalRef: binding.authorizationPrincipalRef,
    canonicalEvidenceHash: binding.canonicalEvidenceHash,
    expectedAuthorityGeneration: binding.memoryGeneration,
    finalProjectionReceipt: binding.finalProjectionReceipt,
    maximumCandidates: binding.retrievalBinding?.retrievalPath ===
        "canonical_local_exact_lexical_v1"
      ? Math.min(policy.retrieval.maximumCandidates, 100)
      : policy.retrieval.maximumCandidates,
    meetingId: binding.meetingId,
    meetingRevision: binding.meetingRevision,
    neighborTurns: policy.retrieval.neighborTurns,
    projectionTargetContainerId: binding.projectionTargetContainerId,
    question: lease.questionText,
    ...(binding.retrievalBinding === undefined
      ? {} : { retrievalBinding: binding.retrievalBinding }),
    roomId: binding.roomId,
    scopeId: binding.scopeId,
    transcriptId: binding.transcriptId,
    transcriptVersion: binding.transcriptVersion,
  };
}

export async function prepareFocusedEvidence(input: {
  readonly authorityGeneration: string;
  readonly binding: QuestionBindingSnapshot;
  readonly evidence: FinalReplyEvidencePort;
  readonly hydrationReferences: Parameters<
    FinalReplyEvidencePort["rehydrateSelectedEvidence"]
  >[1];
  readonly providerAttemptId: string;
  readonly question: string;
  readonly selector: Pick<SelectFocusedEvidence, "execute">;
  readonly turns: Parameters<typeof prepareSelectedFocusedEvidence>[0]["turns"];
}) {
  const retrievalBinding = input.binding.retrievalBinding;
  return retrievalBinding?.retrievalPath === "infinity_locator_v2"
    ? await preparePersistedRetrievalV2Evidence({
        authorityGeneration: input.authorityGeneration,
        binding: input.binding,
        evidence: input.evidence,
        evidenceByteLimit: retrievalBinding.request.budgets.evidenceByteLimit,
        references: input.hydrationReferences,
        turns: input.turns,
      })
    : retrievalBinding?.retrievalPath === "canonical_local_exact_lexical_v1"
      ? await prepareLocalExactLexicalEvidence({
          authorityGeneration: input.authorityGeneration,
          binding: input.binding,
          evidence: input.evidence,
          references: input.hydrationReferences,
          turns: input.turns,
        })
      : await prepareSelectedFocusedEvidence(input);
}

/** V2 accepts Infinity's persisted provider order and never invokes the legacy selector. */
async function preparePersistedRetrievalV2Evidence(input: {
  readonly authorityGeneration: string;
  readonly binding: QuestionBindingSnapshot;
  readonly evidence: FinalReplyEvidencePort;
  readonly evidenceByteLimit: number;
  readonly references: readonly FocusedMemoryReference[];
  readonly turns: readonly RehydratedEvidenceTurn[];
}): Promise<SelectedFocusedEvidencePreparation> {
  return prepareOrderedExactEvidence({
    ...input,
    candidateLimit: 256,
    resultLimit: 256,
  });
}

/**
 * First-meeting lexical retrieval is ordered by PostgreSQL and is never sent
 * to a semantic selector or reranker.
 */
async function prepareLocalExactLexicalEvidence(input: {
  readonly authorityGeneration: string;
  readonly binding: QuestionBindingSnapshot;
  readonly evidence: FinalReplyEvidencePort;
  readonly references: readonly FocusedMemoryReference[];
  readonly turns: readonly RehydratedEvidenceTurn[];
}): Promise<SelectedFocusedEvidencePreparation> {
  return prepareOrderedExactEvidence({
    ...input,
    candidateLimit: localExactLexicalCandidateLimit,
    evidenceByteLimit: localExactLexicalEvidenceByteLimit,
    resultLimit: localExactLexicalResultLimit,
  });
}

async function prepareOrderedExactEvidence(input: {
  readonly authorityGeneration: string;
  readonly binding: QuestionBindingSnapshot;
  readonly candidateLimit: number;
  readonly evidence: FinalReplyEvidencePort;
  readonly evidenceByteLimit: number;
  readonly references: readonly FocusedMemoryReference[];
  readonly resultLimit: number;
  readonly turns: readonly RehydratedEvidenceTurn[];
}): Promise<SelectedFocusedEvidencePreparation> {
  if (input.references.length < 1 || input.references.length > input.candidateLimit ||
    input.references.length !== input.turns.length) {
    return { status: "unavailable" };
  }
  const references: FocusedMemoryReference[] = [];
  let evidenceBytes = 0;
  for (let index = 0; index < input.turns.length &&
      references.length < input.resultLimit; index += 1) {
    const turn = input.turns[index];
    const reference = input.references[index];
    if (turn === undefined || reference === undefined) {continue;}
    const candidateBytes = utf8Bytes(turn.text);
    const delimiterBytes = references.length === 0 ? 0 : 1;
    if (candidateBytes < 1 || candidateBytes > input.evidenceByteLimit ||
      evidenceBytes + delimiterBytes + candidateBytes > input.evidenceByteLimit) {
      continue;
    }
    references.push(reference);
    evidenceBytes += delimiterBytes + candidateBytes;
  }
  if (references.length < 1) {return { status: "unavailable" };}
  const refreshed = await input.evidence.rehydrateSelectedEvidence(
    input.binding, references,
  );
  if (refreshed.status === "stale") {return { status: "stale_binding" };}
  if (refreshed.status !== "current") {return { status: "unavailable" };}
  if (!authorityMatchesBinding(refreshed.binding, input.binding)) {
    return { status: "stale_binding" };
  }
  const survivors = alignFocusedHydrationSurvivors(
    input.binding, references, refreshed.turns,
  );
  if (survivors === null || survivors.turns.length < 1 ||
    utf8Bytes(survivors.turns.map(({ text }) => text).join("\n")) >
      input.evidenceByteLimit) {
    return { status: "unavailable" };
  }
  return Object.freeze({
    authority: refreshed.binding,
    plan: createFocusedRetrievalGroundingPlan({
      authorityGeneration: input.authorityGeneration,
      coverage: "sufficient",
      humanActorIds: admittedHumanActors(refreshed),
      turns: survivors.turns,
    }),
    status: "prepared",
  });
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
