import {
  MeetingKnowledgeInvariantError,
  requireKnowledgeInteger,
  requireKnowledgeText,
  requireSha256,
} from "../../domain/errors.js";

export const questionAdmissionContractVersion = 2 as const;

export interface QuestionAdmissionCommandV1 {
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

/** Runtime codec for the Discord-to-Meeting-Knowledge boundary. */
export function decodeQuestionAdmissionCommand(
  value: unknown,
): QuestionAdmissionCommandV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MeetingKnowledgeInvariantError(
      "INVALID_BINDING",
      "question admission command must be an object",
    );
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "authorizationPrincipalRef",
    "deliveryContainerId",
    "finalProjectionReceipt",
    "projectionTargetContainerId",
    "questionHash",
    "questionId",
    "questionText",
    "requesterSubject",
    "schemaVersion",
    "scopeId",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new MeetingKnowledgeInvariantError(
      "INVALID_BINDING",
      "question admission command contains an unknown field",
    );
  }
  if (requireKnowledgeInteger(input.schemaVersion as number, "schemaVersion", 1) !== 2) {
    throw new MeetingKnowledgeInvariantError(
      "INVALID_BINDING",
      "question admission command version is unsupported",
    );
  }
  return Object.freeze({
    authorizationPrincipalRef: requireKnowledgeText(
      input.authorizationPrincipalRef as string,
      "authorizationPrincipalRef",
      2_048,
    ),
    deliveryContainerId: requireKnowledgeText(
      input.deliveryContainerId as string,
      "deliveryContainerId",
      256,
    ),
    finalProjectionReceipt: requireKnowledgeText(
      input.finalProjectionReceipt as string,
      "finalProjectionReceipt",
      1_024,
    ),
    projectionTargetContainerId: requireKnowledgeText(
      input.projectionTargetContainerId as string,
      "projectionTargetContainerId",
      256,
    ),
    questionHash: requireSha256(input.questionHash as string, "questionHash"),
    questionId: requireKnowledgeText(input.questionId as string, "questionId", 128),
    questionText: requireKnowledgeText(input.questionText as string, "questionText", 2_000),
    requesterSubject: requireSha256(input.requesterSubject as string, "requesterSubject"),
    schemaVersion: questionAdmissionContractVersion,
    scopeId: requireKnowledgeText(input.scopeId as string, "scopeId", 256),
  });
}
