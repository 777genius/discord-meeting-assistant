export type AnswerEffectState =
  | "absent_unconfirmed"
  | "cancelled"
  | "claimed"
  | "delivered"
  | "outcome_unknown"
  | "rejected_before_request"
  | "request_started"
  | "reserved";

const transitions = Object.freeze({
  absent_unconfirmed: Object.freeze(["absent_unconfirmed"]),
  cancelled: Object.freeze(["cancelled"]),
  claimed: Object.freeze(["cancelled", "claimed", "rejected_before_request", "request_started"]),
  delivered: Object.freeze(["delivered"]),
  outcome_unknown: Object.freeze(["absent_unconfirmed", "delivered", "outcome_unknown"]),
  rejected_before_request: Object.freeze(["rejected_before_request"]),
  request_started: Object.freeze(["delivered", "outcome_unknown", "request_started"]),
  reserved: Object.freeze(["cancelled", "claimed", "rejected_before_request", "reserved"]),
} as const satisfies Readonly<Record<AnswerEffectState, readonly AnswerEffectState[]>>);

export function canTransitionAnswerEffect(
  from: AnswerEffectState,
  to: AnswerEffectState,
): boolean {
  return (transitions[from] as readonly AnswerEffectState[]).includes(to);
}

export interface AnswerEffectRecord {
  readonly authorizationDigest: string;
  readonly bindingHash: string;
  readonly claimGeneration: number;
  readonly deliveryContainerId: string;
  readonly effectId: string;
  readonly externalReceipt: string | null;
  readonly marker: string;
  readonly payloadBytes: string;
  readonly payloadHash: string;
  readonly projectionTargetContainerId: string;
  readonly replyToRemoteMessageId: string;
  readonly state: AnswerEffectState;
}
