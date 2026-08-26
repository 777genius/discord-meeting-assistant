import type { AnswerEffectRecord } from "../../domain/answer-effect.js";

export interface AnswerPublicationBinding {
  readonly authorizationDigest: string;
  readonly authorizationPolicyVersion: string;
  readonly authorizationPrincipalRef: string;
  readonly botApplicationIdentity: string;
  readonly canonicalEvidenceHash: string;
  readonly deliveryContainerId: string;
  readonly expectedLocale: "en" | "mixed" | "ru";
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

export interface PreparedAnswerPayload {
  readonly bindingHash: string;
  /** Exact pre-delivery-container hash accepted only during the schema-17 upgrade. */
  readonly legacyBindingHash?: string;
  readonly payloadBytes: string;
  readonly payloadHash: string;
}

export interface AnswerPayloadPort {
  prepare(input: {
    readonly binding: AnswerPublicationBinding;
    readonly content: string;
    readonly deliveryContainerId: string;
    readonly marker: string;
    readonly projectionTargetContainerId: string;
    readonly replyToRemoteMessageId: string;
  }): PreparedAnswerPayload;
}

export interface AnswerEffectReservationInput extends PreparedAnswerPayload {
  readonly authorityScopeId: string;
  readonly authorizationDigest: string;
  readonly deliveryContainerId: string;
  readonly effectId: string;
  readonly marker: string;
  readonly projectionTargetContainerId: string;
  readonly questionFence: {
    readonly generation: number;
    readonly jobId: string;
  };
  readonly replyToRemoteMessageId: string;
  readonly sourceMeetingIds: readonly string[];
}

export type AnswerEffectStoreReservation =
  | { readonly status: "conflict" }
  | { readonly status: "stale_fence" }
  | { readonly externalReceipt?: string; readonly status: "delivered" | "existing" }
  | { readonly status: "reserved" };

export interface AnswerEffectStore {
  reserve(input: AnswerEffectReservationInput): Promise<AnswerEffectStoreReservation>;
  findById(effectId: string): Promise<AnswerEffectRecord | null>;
  startRequest(input: {
    readonly authorizationDigest: string;
    readonly effectId: string;
    readonly questionGeneration: number;
    readonly workerId: string;
  }): Promise<boolean>;
  complete(input: {
    readonly effectId: string;
    readonly externalReceipt: string;
  }): Promise<boolean>;
  markOutcomeUnknown(effectId: string): Promise<boolean>;
  listOutcomeUnknown(limit: number): Promise<readonly AnswerEffectRecord[]>;
  markAbsentUnconfirmed(effectId: string): Promise<boolean>;
  containDuplicateReceipts(input: {
    readonly effectId: string;
    readonly externalReceipts: readonly string[];
  }): Promise<boolean>;
  cancelBeforeRequest(effectId: string): Promise<boolean>;
  listRetractionPending(limit: number): Promise<readonly AnswerEffectRecord[]>;
  recordRetractionReceipt(input: {
    readonly effectId: string;
    readonly externalReceipt: string;
  }): Promise<boolean>;
  markRetracted(input: {
    readonly effectId: string;
    readonly externalReceipt: string;
  }): Promise<boolean>;
}

export interface AnswerDeliveryPort {
  create(input: {
    readonly authorityScopeId: string;
    readonly deliveryContainerId: string;
    readonly effectId: string;
    readonly marker: string;
    readonly payloadBytes: string;
    readonly projectionTargetContainerId: string;
    readonly replyToRemoteMessageId: string;
  }): Promise<string>;

  inspect(input: {
    readonly authorityScopeId: string;
    readonly deliveryContainerId: string;
    readonly marker: string;
    /** Exact immutable request bytes needed to validate every visible claim surface. */
    readonly payloadBytes: string;
    readonly payloadHash: string;
    readonly projectionTargetContainerId: string;
    readonly replyToRemoteMessageId: string;
  }): Promise<
    | { readonly externalReceipt: string; readonly status: "found" }
    | { readonly externalReceipts: readonly string[]; readonly status: "duplicate" }
    | { readonly status: "unconfirmed" }
  >;

  remove(input: {
    readonly deliveryContainerId: string;
    readonly effectId: string;
    readonly externalReceipt: string;
  }): Promise<void>;
}
