import type {
  AnswerDeliveryPort,
  AnswerEffectStore,
  AnswerPayloadPort,
  AnswerPublicationBinding,
} from "./ports/answer-publication.js";

function effectIdForQuestion(questionId: string): string {
  return `meeting-knowledge-answer:v1:${questionId}`;
}

export class DurableAnswerPublication {
  private readonly delivery: AnswerDeliveryPort;
  private readonly payloads: AnswerPayloadPort;
  private readonly store: AnswerEffectStore;

  public constructor(input: {
    readonly delivery: AnswerDeliveryPort;
    readonly payloads: AnswerPayloadPort;
    readonly store: AnswerEffectStore;
  }) {
    this.delivery = input.delivery;
    this.payloads = input.payloads;
    this.store = input.store;
  }

  public async reserve(input: {
    readonly authorizationDigest: string;
    readonly binding: AnswerPublicationBinding;
    readonly content: string;
    readonly deliveryContainerId: string;
    readonly marker: string;
    readonly projectionTargetContainerId: string;
    readonly replyToRemoteMessageId: string;
  }): Promise<
    | { readonly effectId: string; readonly status: "already_delivered" }
    | { readonly effectId: string; readonly status: "reserved" }
  > {
    const effectId = effectIdForQuestion(input.binding.questionId);
    const payload = this.payloads.prepare(input);
    const reserved = await this.store.reserve({
      ...payload,
      authorizationDigest: input.authorizationDigest,
      deliveryContainerId: input.deliveryContainerId,
      effectId,
      marker: input.marker,
      projectionTargetContainerId: input.projectionTargetContainerId,
      replyToRemoteMessageId: input.replyToRemoteMessageId,
    });
    if (reserved.status === "conflict") {
      throw new Error("answer effect reservation conflicts with immutable bytes");
    }
    return reserved.status === "delivered"
      ? { effectId, status: "already_delivered" }
      : { effectId, status: "reserved" };
  }

  public async send(input: {
    readonly authorizationDigest: string;
    readonly effectId: string;
    readonly workerId: string;
  }): Promise<
    | { readonly externalReceipt: string; readonly status: "delivered" }
    | { readonly status: "outcome_unknown" | "rejected_before_request" }
  > {
    const claim = await this.store.claim(input.effectId, input.workerId);
    if (claim.status !== "claimed") {
      const record = await this.store.findById(input.effectId);
      const mayHaveStarted = record?.state === "claimed" ||
        record?.state === "request_started" ||
        record?.state === "outcome_unknown" ||
        record?.state === "absent_unconfirmed";
      return { status: mayHaveStarted ? "outcome_unknown" : "rejected_before_request" };
    }
    const started = await this.store.startRequest({
      authorizationDigest: input.authorizationDigest,
      effectId: input.effectId,
      generation: claim.generation,
    });
    if (!started) {
      return { status: "rejected_before_request" };
    }
    try {
      const record = await this.effectAfterRequestStart(input.effectId);
      const externalReceipt = await this.delivery.create({
        effectId: record.effectId,
        deliveryContainerId: record.deliveryContainerId,
        marker: record.marker,
        payloadBytes: record.payloadBytes,
        projectionTargetContainerId: record.projectionTargetContainerId,
        replyToRemoteMessageId: record.replyToRemoteMessageId,
      });
      if (!await this.store.complete({ effectId: input.effectId, externalReceipt })) {
        await this.store.markOutcomeUnknown(input.effectId);
        return { status: "outcome_unknown" };
      }
      return { externalReceipt, status: "delivered" };
    } catch {
      await this.store.markOutcomeUnknown(input.effectId);
      return { status: "outcome_unknown" };
    }
  }

  public cancelBeforeRequest(input: {
    readonly questionId: string;
    readonly reason: "authorization_drift" | "binding_drift";
  }): Promise<boolean> {
    void input.reason;
    return this.store.cancelBeforeRequest(effectIdForQuestion(input.questionId));
  }

  public async reconcileUnknown(limit: number): Promise<{
    readonly absentUnconfirmed: number;
    readonly delivered: number;
  }> {
    const records = await this.store.listOutcomeUnknown(limit);
    let absentUnconfirmed = 0;
    let delivered = 0;
    for (const record of records) {
      const inspected = await this.delivery.inspect({
        deliveryContainerId: record.deliveryContainerId,
        marker: record.marker,
        payloadHash: record.payloadHash,
        projectionTargetContainerId: record.projectionTargetContainerId,
        replyToRemoteMessageId: record.replyToRemoteMessageId,
      });
      if (inspected.status === "found") {
        if (await this.store.complete({
          effectId: record.effectId,
          externalReceipt: inspected.externalReceipt,
        })) {
          delivered += 1;
        }
      } else if (await this.store.markAbsentUnconfirmed(record.effectId)) {
        absentUnconfirmed += 1;
      }
    }
    return { absentUnconfirmed, delivered };
  }

  private async effectAfterRequestStart(effectId: string) {
    const requested = await this.store.findById(effectId);
    if (requested === null || requested.state !== "request_started") {
      throw new Error("request-started answer effect is unavailable");
    }
    return requested;
  }
}
