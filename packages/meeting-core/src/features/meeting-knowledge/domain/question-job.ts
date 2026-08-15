import type { AnswerLocale } from "./answer-locale.js";
import {
  MeetingKnowledgeInvariantError,
  requireKnowledgeInteger,
  requireKnowledgeText,
  requireSha256,
} from "./errors.js";

export interface QuestionBindingSnapshot {
  readonly authorizationDigest: string;
  readonly authorizationPolicyVersion: string;
  readonly authorizationPrincipalRef: string;
  readonly botApplicationIdentity: string;
  readonly canonicalEvidenceHash: string;
  readonly expectedLocale: AnswerLocale;
  readonly finalProjectionEpoch: string;
  readonly finalProjectionReceipt: string;
  readonly humanActorIds: readonly string[];
  readonly meetingId: string;
  readonly meetingRevision: number;
  readonly memoryGeneration: string;
  readonly policyVersion: string;
  readonly projectionTargetContainerId: string;
  readonly questionHash: string;
  readonly questionId: string;
  readonly requesterSubject: string;
  readonly roomId: string;
  readonly scopeId: string;
  readonly transcriptId: string;
  readonly transcriptVersion: number;
}

const bindingTextFields = [
  "authorizationPolicyVersion",
  "authorizationPrincipalRef",
  "botApplicationIdentity",
  "finalProjectionEpoch",
  "finalProjectionReceipt",
  "meetingId",
  "memoryGeneration",
  "policyVersion",
  "projectionTargetContainerId",
  "questionId",
  "roomId",
  "scopeId",
  "transcriptId",
] as const;

export class QuestionBinding implements QuestionBindingSnapshot {
  public readonly authorizationDigest: string;
  public readonly authorizationPolicyVersion: string;
  public readonly authorizationPrincipalRef: string;
  public readonly botApplicationIdentity: string;
  public readonly canonicalEvidenceHash: string;
  public readonly expectedLocale: AnswerLocale;
  public readonly finalProjectionEpoch: string;
  public readonly finalProjectionReceipt: string;
  public readonly humanActorIds: readonly string[];
  public readonly meetingId: string;
  public readonly meetingRevision: number;
  public readonly memoryGeneration: string;
  public readonly policyVersion: string;
  public readonly projectionTargetContainerId: string;
  public readonly questionHash: string;
  public readonly questionId: string;
  public readonly requesterSubject: string;
  public readonly roomId: string;
  public readonly scopeId: string;
  public readonly transcriptId: string;
  public readonly transcriptVersion: number;

  private constructor(input: QuestionBindingSnapshot) {
    Object.assign(this, input);
    this.authorizationDigest = input.authorizationDigest;
    this.authorizationPolicyVersion = input.authorizationPolicyVersion;
    this.authorizationPrincipalRef = input.authorizationPrincipalRef;
    this.botApplicationIdentity = input.botApplicationIdentity;
    this.canonicalEvidenceHash = input.canonicalEvidenceHash;
    this.expectedLocale = input.expectedLocale;
    this.finalProjectionEpoch = input.finalProjectionEpoch;
    this.finalProjectionReceipt = input.finalProjectionReceipt;
    this.humanActorIds = Object.freeze([...input.humanActorIds]);
    this.meetingId = input.meetingId;
    this.meetingRevision = input.meetingRevision;
    this.memoryGeneration = input.memoryGeneration;
    this.policyVersion = input.policyVersion;
    this.projectionTargetContainerId = input.projectionTargetContainerId;
    this.questionHash = input.questionHash;
    this.questionId = input.questionId;
    this.requesterSubject = input.requesterSubject;
    this.roomId = input.roomId;
    this.scopeId = input.scopeId;
    this.transcriptId = input.transcriptId;
    this.transcriptVersion = input.transcriptVersion;
    Object.freeze(this);
  }

  public static create(input: QuestionBindingSnapshot): QuestionBinding {
    const normalized = { ...input };
    for (const field of bindingTextFields) {
      normalized[field] = requireKnowledgeText(input[field], `binding.${field}`, 1_024);
    }
    normalized.authorizationDigest = requireSha256(
      input.authorizationDigest,
      "binding.authorizationDigest",
    );
    normalized.canonicalEvidenceHash = requireSha256(
      input.canonicalEvidenceHash,
      "binding.canonicalEvidenceHash",
    );
    if (
      normalized.memoryGeneration !==
        `focused-memory:v1:${normalized.canonicalEvidenceHash}`
    ) {
      throw new MeetingKnowledgeInvariantError(
        "INVALID_BINDING",
        "binding.memoryGeneration must identify the bound canonical evidence",
      );
    }
    normalized.questionHash = requireSha256(input.questionHash, "binding.questionHash");
    normalized.requesterSubject = requireSha256(
      input.requesterSubject,
      "binding.requesterSubject",
    );
    normalized.humanActorIds = Object.freeze(input.humanActorIds.map((actorId) =>
      requireKnowledgeText(actorId, "binding.humanActorIds", 256)
    ).toSorted());
    if (
      normalized.humanActorIds.length === 0 ||
      new Set(normalized.humanActorIds).size !== normalized.humanActorIds.length
    ) {
      throw new MeetingKnowledgeInvariantError(
        "INVALID_BINDING",
        "binding.humanActorIds requires a non-empty unique sealed roster",
      );
    }
    normalized.meetingRevision = requireKnowledgeInteger(
      input.meetingRevision,
      "binding.meetingRevision",
    );
    normalized.transcriptVersion = requireKnowledgeInteger(
      input.transcriptVersion,
      "binding.transcriptVersion",
      1,
    );
    const expectedLocale: unknown = input.expectedLocale;
    if (
      expectedLocale !== "en" &&
      expectedLocale !== "mixed" &&
      expectedLocale !== "ru"
    ) {
      throw new MeetingKnowledgeInvariantError(
        "INVALID_BINDING",
        "binding.expectedLocale is unsupported",
      );
    }
    return new QuestionBinding(normalized);
  }

  public toSnapshot(): QuestionBindingSnapshot {
    return {
      authorizationDigest: this.authorizationDigest,
      authorizationPolicyVersion: this.authorizationPolicyVersion,
      authorizationPrincipalRef: this.authorizationPrincipalRef,
      botApplicationIdentity: this.botApplicationIdentity,
      canonicalEvidenceHash: this.canonicalEvidenceHash,
      expectedLocale: this.expectedLocale,
      finalProjectionEpoch: this.finalProjectionEpoch,
      finalProjectionReceipt: this.finalProjectionReceipt,
      humanActorIds: Object.freeze([...this.humanActorIds]),
      meetingId: this.meetingId,
      meetingRevision: this.meetingRevision,
      memoryGeneration: this.memoryGeneration,
      policyVersion: this.policyVersion,
      projectionTargetContainerId: this.projectionTargetContainerId,
      questionHash: this.questionHash,
      questionId: this.questionId,
      requesterSubject: this.requesterSubject,
      roomId: this.roomId,
      scopeId: this.scopeId,
      transcriptId: this.transcriptId,
      transcriptVersion: this.transcriptVersion,
    };
  }
}

export function questionBindingsEqual(
  left: QuestionBindingSnapshot,
  right: QuestionBindingSnapshot,
): boolean {
  return Object.keys(left).every((key) =>
    key === "humanActorIds"
      ? sameOpaqueRoster(left.humanActorIds, right.humanActorIds)
      : left[key as keyof QuestionBindingSnapshot] ===
        right[key as keyof QuestionBindingSnapshot]
  ) && Object.keys(left).length === Object.keys(right).length;
}

function sameOpaqueRoster(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export type QuestionJobState = "queued" | "ready" | "running" | "terminal";

const allowedTransitions = Object.freeze({
  queued: Object.freeze(["queued", "running"]),
  ready: Object.freeze(["ready", "terminal"]),
  running: Object.freeze(["running", "ready", "terminal"]),
  terminal: Object.freeze(["terminal"]),
} as const satisfies Readonly<
  Record<QuestionJobState, readonly QuestionJobState[]>
>);

export function canTransitionQuestionJob(
  from: QuestionJobState,
  to: QuestionJobState,
): boolean {
  return (allowedTransitions[from] as readonly QuestionJobState[]).includes(to);
}
