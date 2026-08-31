import { resolveAnswerLocale } from "../domain/answer-locale.js";
import {
  requireKnowledgeText,
  requireSha256,
} from "../domain/errors.js";
import { QuestionBinding } from "../domain/question-job.js";
import { selectRetrievalBinding } from
  "../domain/retrieval-admission.js";
import { classifyRelativeTimeFilter } from "./focused-locator-retrieval-v2-query.js";
import { classifyRequestedSpeakerFilter, type IdentitySkeletonPortV1,
  type SpeakerAliasMapV1 } from "./speaker-alias-resolution.js";
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
        | "authorization_unavailable"
        | "binding_conflict"
        | "not_current_final"
        | "participant_not_eligible"
        | "rate_limited"
        | "retrieval_filter_denied"
        | "retrieval_unavailable";
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

export interface CurrentFinalReplyRetrievalOptions {
  readonly canonicalSpeakerFilters?: {
    readonly aliases: SpeakerAliasMapV1;
    readonly identitySkeletons?: IdentitySkeletonPortV1;
  };
  readonly retrievalV2Admission?: FocusedLocatorRetrievalV2AdmissionPort;
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
  private readonly canonicalSpeakerFilters?: CurrentFinalReplyRetrievalOptions[
    "canonicalSpeakerFilters"
  ];
  private readonly retrievalV2Admission: FocusedLocatorRetrievalV2AdmissionPort |
    undefined;

  public constructor(
    private readonly evidence: FinalReplyEvidencePort,
    private readonly authorization: QuestionAuthorizationPort,
    private readonly admissions: QuestionAdmissionCommitPort,
    private readonly policy: LocalFinalReplyPolicy,
    options: CurrentFinalReplyRetrievalOptions = {},
  ) {
    this.canonicalSpeakerFilters = options.canonicalSpeakerFilters;
    this.retrievalV2Admission = options.retrievalV2Admission;
  }

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
      return { reason: authorization.reason === "partial" ||
        authorization.reason === "unavailable"
        ? "authorization_unavailable" : "authorization_denied", status: "ignored" };
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
    const timeFilter = classifyRelativeTimeFilter(questionText);
    const speakerFilter = classifyRequestedSpeakerFilter(
      questionText,
      this.canonicalSpeakerFilters?.aliases,
      this.canonicalSpeakerFilters?.identitySkeletons,
    );
    const directActorIds = Object.freeze([
      ...questionText.matchAll(/<@!?(\d{17,20})>|(?<!\d)(\d{17,20})(?!\d)/gu),
    ].map((match) => match[1] ?? match[2]!).filter((value, index, values) =>
      values.indexOf(value) === index
    ));
    if (retrievalFiltersDenied(
      timeFilter.status, speakerFilter.status, directActorIds, current.humanActorIds,
    )) {
      return { reason: "retrieval_filter_denied", status: "ignored" };
    }
    const requestedSpeakerIds = Object.freeze(current.humanActorIds.filter((actorId) =>
      (speakerFilter.status === "valid" && speakerFilter.speakerIds.includes(actorId)) ||
      directActorIds.includes(actorId)
    ).toSorted());
    const requiresSpeakerMatch = speakerFilter.status === "valid" ||
      directActorIds.length > 0;
    const retrievalV2Preparation = await this.retrievalV2Admission?.prepare({
      currentMeetingId: current.meetingId, question: questionText,
      roomId: current.roomId, scopeId: current.scopeId,
    });
    const retrievalRejection = retrievalPreparationRejection(
      retrievalV2Preparation, requestedSpeakerIds);
    if (retrievalRejection !== null) {return retrievalRejection;}
    const retrievalV2Request = retrievalV2Preparation?.status === "prepared"
      ? retrievalRequest(retrievalV2Preparation) : null;
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
        canonicalEvidenceFilters: Object.freeze({
          relativeTimeInterval: timeFilter.status === "valid"
            ? timeFilter.interval : null,
          requiresSpeakerMatch,
          speakerIds: Object.freeze(requestedSpeakerIds),
        }),
        originalQuestion: questionText,
        questionId,
        retrievalV2Request: retrievalV2Request ?? null,
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
    return admissionCommitResult(committed);
  }
}

function retrievalRequest(
  preparation: Extract<Awaited<ReturnType<
    NonNullable<FocusedLocatorRetrievalV2AdmissionPort>["prepare"]
  >>, { readonly status: "prepared" }>,
) {
  const { status: _status, ...request } = preparation;
  return request;
}

function retrievalFiltersDenied(
  timeStatus: "absent" | "denied" | "valid",
  speakerStatus: "absent" | "denied" | "valid",
  directActorIds: readonly string[],
  humanActorIds: readonly string[],
): boolean {
  return timeStatus === "denied" || speakerStatus === "denied" ||
    directActorIds.some((actorId) => !humanActorIds.includes(actorId));
}

function retrievalPreparationRejection(
  preparation: Awaited<ReturnType<
    NonNullable<FocusedLocatorRetrievalV2AdmissionPort>["prepare"]
  >> | undefined,
  requestedSpeakerIds: readonly string[],
): AdmitCurrentFinalReplyResult | null {
  if (preparation?.status === "unavailable") {
    return { reason: preparation.reason === "retrieval_filter_denied"
        ? "retrieval_filter_denied" : "retrieval_unavailable",
      status: "ignored" };
  }
  return preparation?.status === "prepared" &&
    preparation.filters.actorKeys.length > 0 && requestedSpeakerIds.length === 0
    ? { reason: "retrieval_filter_denied", status: "ignored" }
    : null;
}

function admissionCommitResult(
  committed: Awaited<ReturnType<QuestionAdmissionCommitPort["commit"]>>,
): AdmitCurrentFinalReplyResult {
  if (committed.status === "committed") {
    return { jobId: committed.jobId, status: "accepted" };
  }
  if (committed.status === "duplicate") {
    return { jobId: committed.jobId, status: "duplicate" };
  }
  return committed.status === "rate_limited"
    ? { reason: "rate_limited", status: "ignored" }
    : { reason: "binding_conflict", status: "ignored" };
}
