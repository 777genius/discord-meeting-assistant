import { isLegacyQuestionBinding, type QuestionBindingSnapshot } from
  "../domain/question-job.js";
import { preparePersistedRetrievalV2Evidence,
  prepareSelectedFocusedEvidence, type SelectFocusedEvidence } from
  "./select-focused-evidence.js";
import type { FinalReplyEvidencePort, FocusedMemoryRetrievalPort,
  LocalFinalReplyPolicy, QuestionJobLease } from "./ports/final-reply.js";

export function isComposedLocalBinding(
  binding: QuestionBindingSnapshot,
  policy: LocalFinalReplyPolicy,
): boolean {
  if (isLegacyQuestionBinding(binding)) {
    return true;
  }
  if (binding.retrievalBinding.retrievalPath === "legacy_downstream_v1") {
    return policy.legacyRetrievalMigration?.enabled !== false &&
      binding.retrievalBinding.profileFingerprint ===
        policy.retrievalAdmission.legacyProfileFingerprint;
  }
  if (binding.retrievalBinding.retrievalPath !== "infinity_locator_v2") {
    return false;
  }
  return binding.retrievalBinding.profileFingerprint ===
      policy.retrievalAdmission.infinityProfileFingerprint &&
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
    maximumCandidates: policy.retrieval.maximumCandidates,
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
  return input.binding.retrievalBinding?.retrievalPath === "infinity_locator_v2"
    ? await preparePersistedRetrievalV2Evidence({
        authorityGeneration: input.authorityGeneration,
        binding: input.binding,
        evidence: input.evidence,
        evidenceByteLimit:
          input.binding.retrievalBinding.request.budgets.evidenceByteLimit,
        references: input.hydrationReferences,
        turns: input.turns,
      })
    : await prepareSelectedFocusedEvidence(input);
}
