import { resolveAnswerLocale } from "../domain/answer-locale.js";
import {
  requireKnowledgeText,
  requireSha256,
} from "../domain/errors.js";
import { QuestionBinding } from "../domain/question-job.js";
import { selectRetrievalBinding } from
  "../domain/retrieval-admission.js";
import type {
  FinalReplyEvidencePort,
  FocusedLocatorRetrievalV2AdmissionPort,
  LocalFinalReplyPolicy,
  QuestionAdmissionCommitPort,
  QuestionAuthorizationObservation,
  QuestionAuthorizationPort,
} from "./ports/final-reply.js";
import {
  decodeQuestionAdmissionCommand,
  questionAdmissionContractVersion,
} from "./ports/question-admission-contract.js";

export type AdmitCurrentFinalReplyResult =
  | { readonly jobId: string; readonly status: "accepted" | "duplicate" }
  | {
      readonly reason:
        | "authorization_denied"
        | "binding_conflict"
        | "not_current_final"
        | "participant_not_eligible"
        | "rate_limited";
      readonly status: "ignored";
    };

export interface AdmitCurrentFinalReplyInput {
  readonly authorizationPrincipalRef: string;
  readonly deliveryContainerId: string;
  readonly finalProjectionReceipt: string;
  readonly projectionTargetContainerId: string;
  readonly questionHash: string;
  readonly questionId: string;
  readonly questionText: string;
  readonly requesterSubject: string;
  readonly schemaVersion: typeof questionAdmissionContractVersion;
  readonly scopeId: string;
}

function authorizedForBinding(
  observation: QuestionAuthorizationObservation,
  binding: Awaited<ReturnType<FinalReplyEvidencePort["findCurrentBinding"]>>,
  deliveryContainerId: string,
): observation is Extract<
  QuestionAuthorizationObservation,
  { readonly status: "authorized" }
> {
  return observation.status === "authorized" &&
    binding !== null &&
    observation.deliveryContainerId === deliveryContainerId &&
    observation.scopeId === binding.scopeId &&
    observation.containerId === binding.projectionTargetContainerId &&
    binding.humanActorIds.includes(observation.actorId);
}

export class AdmitCurrentFinalReply {
  public constructor(
    private readonly evidence: FinalReplyEvidencePort,
    private readonly authorization: QuestionAuthorizationPort,
    private readonly admissions: QuestionAdmissionCommitPort,
    private readonly policy: LocalFinalReplyPolicy,
    private readonly retrievalV2Admission?: FocusedLocatorRetrievalV2AdmissionPort,
  ) {}

  public async execute(
    input: AdmitCurrentFinalReplyInput,
  ): Promise<AdmitCurrentFinalReplyResult> {
    input = decodeQuestionAdmissionCommand(input);
    const questionId = requireKnowledgeText(input.questionId, "questionId", 128);
    const deliveryContainerId = requireKnowledgeText(
      input.deliveryContainerId,
      "deliveryContainerId",
      256,
    );
    const questionText = requireKnowledgeText(input.questionText, "questionText", 2_000);
    const projectionTargetContainerId = requireKnowledgeText(
      input.projectionTargetContainerId,
      "projectionTargetContainerId",
      256,
    );
    const scopeId = requireKnowledgeText(input.scopeId, "scopeId", 256);
    const authorizationPrincipalRef = requireKnowledgeText(
      input.authorizationPrincipalRef,
      "authorizationPrincipalRef",
      2_048,
    );
    const finalProjectionReceipt = requireKnowledgeText(
      input.finalProjectionReceipt,
      "finalProjectionReceipt",
      1_024,
    );
    const questionHash = requireSha256(input.questionHash, "questionHash");
    const requesterSubject = requireSha256(
      input.requesterSubject,
      "requesterSubject",
    );

    const authorization = await this.authorization.observe({
      authorizationPrincipalRef,
      checkpoint: "admission",
      expectedContainerId: projectionTargetContainerId,
      expectedScopeId: scopeId,
      questionId,
    });
    if (authorization.status !== "authorized") {
      return { reason: "authorization_denied", status: "ignored" };
    }
    if (authorization.policyVersion !== this.policy.authorizationPolicyVersion) {
      return { reason: "authorization_denied", status: "ignored" };
    }
    const current = await this.evidence.findCurrentBinding({
      finalProjectionReceipt,
      projectionTargetContainerId,
    });
    if (current === null) {
      return { reason: "not_current_final", status: "ignored" };
    }
    if (!authorizedForBinding(authorization, current, deliveryContainerId)) {
      return { reason: "participant_not_eligible", status: "ignored" };
    }
    const retrievalV2Request = await this.retrievalV2Admission?.prepare({
      currentMeetingId: current.meetingId,
      question: questionText,
      roomId: current.roomId,
      scopeId: current.scopeId,
    });
    if (retrievalV2Request === undefined || retrievalV2Request === null) {
      return { reason: "binding_conflict", status: "ignored" };
    }
    const binding = QuestionBinding.create({
      authorizationDigest: authorization.digest,
      authorizationPolicyVersion: authorization.policyVersion,
      authorizationPrincipalRef,
      botApplicationIdentity: current.botApplicationIdentity,
      bindingProtocolVersion: 2,
      canonicalEvidenceHash: current.canonicalEvidenceHash,
      deliveryContainerId,
      expectedLocale: resolveAnswerLocale(questionText),
      finalProjectionEpoch: current.finalProjectionEpoch,
      finalProjectionReceipt: current.finalProjectionReceipt,
      humanActorIds: current.humanActorIds,
      meetingId: current.meetingId,
      meetingRevision: current.meetingRevision,
      memoryGeneration: current.memoryGeneration,
      policyVersion: this.policy.policyVersion,
      projectionTargetContainerId: current.projectionTargetContainerId,
      questionHash,
      questionId,
      requesterSubject,
      retrievalBinding: selectRetrievalBinding({
        questionId,
        retrievalV2Request,
        rollout: this.policy.retrievalAdmission,
      }).toSnapshot(),
      roomId: current.roomId,
      scopeId: current.scopeId,
      transcriptId: current.transcriptId,
      transcriptVersion: current.transcriptVersion,
    });
    const committed = await this.admissions.commit({
      authorization,
      binding: binding.toSnapshot(),
      questionText,
      ratePolicy: this.policy.admission,
    });
    if (committed.status === "committed") {
      return { jobId: committed.jobId, status: "accepted" };
    }
    if (committed.status === "duplicate") {
      return { jobId: committed.jobId, status: "duplicate" };
    }
    if (committed.status === "rate_limited") {
      return { reason: "rate_limited", status: "ignored" };
    }
    return { reason: "binding_conflict", status: "ignored" };
  }
}
