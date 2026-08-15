import { describe, expect, it } from "vitest";

import {
  DurableAnswerPublication,
  canTransitionAnswerEffect,
  type AnswerDeliveryPort,
  type AnswerEffectClaim,
  type AnswerEffectRecord,
  type AnswerEffectReservationInput,
  type AnswerEffectStore,
  type AnswerPayloadPort,
  type PreparedAnswerPayload,
} from "@discord-meeting/meeting-core/publishing";

class PayloadFake implements AnswerPayloadPort {
  prepare(input: Parameters<AnswerPayloadPort["prepare"]>[0]): PreparedAnswerPayload {
    return {
      bindingHash: "b".repeat(64),
      payloadBytes: JSON.stringify({ content: input.content, marker: input.marker }),
      payloadHash: "c".repeat(64),
    };
  }
}

class StoreFake implements AnswerEffectStore {
  record?: AnswerEffectRecord;
  generation = 0;

  reserve(input: AnswerEffectReservationInput) {
    if (this.record !== undefined) {
      if (this.record.payloadHash !== input.payloadHash) {
        return Promise.resolve({ status: "conflict" } as const);
      }
      return Promise.resolve({
        ...(this.record.externalReceipt === null
          ? {}
          : { externalReceipt: this.record.externalReceipt }),
        status: this.record.state === "delivered" ? "delivered" : "existing",
      } as const);
    }
    this.record = {
      ...input,
      claimGeneration: 0,
      externalReceipt: null,
      state: "reserved",
    };
    return Promise.resolve({ status: "reserved" } as const);
  }

  findById(effectId: string): Promise<AnswerEffectRecord | null> {
    return Promise.resolve(this.record?.effectId === effectId ? this.record : null);
  }

  claim(effectId: string): Promise<AnswerEffectClaim> {
    if (this.record?.effectId !== effectId || this.record.state !== "reserved") {
      return Promise.resolve({ status: "not_claimable" });
    }
    this.generation += 1;
    this.record = { ...this.record, claimGeneration: this.generation, state: "claimed" };
    return Promise.resolve({ generation: this.generation, status: "claimed" });
  }

  startRequest(input: { readonly effectId: string; readonly generation: number }) {
    if (
      this.record?.effectId !== input.effectId ||
      this.record.state !== "claimed" ||
      this.record.claimGeneration !== input.generation
    ) {
      return Promise.resolve(false);
    }
    this.record = { ...this.record, state: "request_started" };
    return Promise.resolve(true);
  }

  complete(input: { readonly effectId: string; readonly externalReceipt: string }) {
    if (this.record?.effectId !== input.effectId) {
      return Promise.resolve(false);
    }
    this.record = { ...this.record, externalReceipt: input.externalReceipt, state: "delivered" };
    return Promise.resolve(true);
  }

  markOutcomeUnknown(effectId: string) {
    if (this.record?.effectId !== effectId) {
      return Promise.resolve(false);
    }
    this.record = { ...this.record, state: "outcome_unknown" };
    return Promise.resolve(true);
  }

  listOutcomeUnknown() {
    return Promise.resolve(
      this.record?.state === "outcome_unknown" ? [this.record] : [],
    );
  }

  markAbsentUnconfirmed(effectId: string) {
    if (this.record?.effectId !== effectId) {
      return Promise.resolve(false);
    }
    this.record = { ...this.record, state: "absent_unconfirmed" };
    return Promise.resolve(true);
  }

  cancelBeforeRequest(effectId: string) {
    if (
      this.record?.effectId !== effectId ||
      (this.record.state !== "reserved" && this.record.state !== "claimed")
    ) {
      return Promise.resolve(false);
    }
    this.record = { ...this.record, payloadBytes: "{}", state: "cancelled" };
    return Promise.resolve(true);
  }
}

class DeliveryFake implements AnswerDeliveryPort {
  creates = 0;
  throwAfterCreate = false;
  inspection: Awaited<ReturnType<AnswerDeliveryPort["inspect"]>> = {
    status: "unconfirmed",
  };

  create(): Promise<string> {
    this.creates += 1;
    if (this.throwAfterCreate) {
      return Promise.reject(new Error("lost response after committed create"));
    }
    return Promise.resolve("answer-message-1");
  }

  inspect() {
    return Promise.resolve(this.inspection);
  }
}

const binding = {
  authorizationDigest: "a".repeat(64),
  authorizationPolicyVersion: "discord.participant-current-results.v1",
  authorizationPrincipalRef: "principal:v1:opaque",
  botApplicationIdentity: "botik-application-1",
  canonicalEvidenceHash: "b".repeat(64),
  expectedLocale: "en" as const,
  finalProjectionEpoch: "projection-epoch-1",
  finalProjectionReceipt: "projection-receipt-1",
  humanActorIds: ["actor-1"],
  meetingId: "meeting-1",
  meetingRevision: 8,
  memoryGeneration: `focused-memory:v1:${"b".repeat(64)}`,
  policyVersion: "meeting-knowledge.local-final-reply.v1",
  projectionTargetContainerId: "results-1",
  questionHash: "c".repeat(64),
  questionId: "question-1",
  requesterSubject: "d".repeat(64),
  roomId: "room-1",
  scopeId: "scope-1",
  transcriptId: "transcript-1",
  transcriptVersion: 1,
};

function reservationInput() {
  return {
    authorizationDigest: "e".repeat(64),
    binding,
    content: "Grounded answer\n-# S1 · 00:01 · turn-1",
    marker: "meeting-knowledge-answer:v1:question-1",
    projectionTargetContainerId: "results-1",
    replyToRemoteMessageId: "question-1",
  };
}

describe("Publishing answer effects", () => {
  it("exposes only the planned immutable effect transitions", () => {
    expect(canTransitionAnswerEffect("reserved", "claimed")).toBe(true);
    expect(canTransitionAnswerEffect("claimed", "request_started")).toBe(true);
    expect(canTransitionAnswerEffect("request_started", "delivered")).toBe(true);
    expect(canTransitionAnswerEffect("request_started", "outcome_unknown")).toBe(true);
    expect(canTransitionAnswerEffect("outcome_unknown", "delivered")).toBe(true);
    expect(canTransitionAnswerEffect("outcome_unknown", "absent_unconfirmed")).toBe(true);
    expect(canTransitionAnswerEffect("request_started", "claimed")).toBe(false);
    expect(canTransitionAnswerEffect("outcome_unknown", "request_started")).toBe(false);
  });

  it("persists request_started before exactly one create", async () => {
    const store = new StoreFake();
    const delivery = new DeliveryFake();
    const publisher = new DurableAnswerPublication({
      delivery,
      payloads: new PayloadFake(),
      store,
    });
    const reservation = await publisher.reserve(reservationInput());
    expect(reservation).toEqual({
      effectId: "meeting-knowledge-answer:v1:question-1",
      status: "reserved",
    });
    await expect(publisher.send({
      authorizationDigest: "e".repeat(64),
      effectId: reservation.effectId,
      workerId: "worker-1",
    })).resolves.toEqual({
      externalReceipt: "answer-message-1",
      status: "delivered",
    });
    expect(delivery.creates).toBe(1);
    expect(store.record?.state).toBe("delivered");

    await expect(publisher.send({
      authorizationDigest: "e".repeat(64),
      effectId: reservation.effectId,
      workerId: "worker-2",
    })).resolves.toEqual({ status: "rejected_before_request" });
    expect(delivery.creates).toBe(1);
  });

  it("never creates again after an ambiguous committed create", async () => {
    const store = new StoreFake();
    const delivery = new DeliveryFake();
    delivery.throwAfterCreate = true;
    const publisher = new DurableAnswerPublication({
      delivery,
      payloads: new PayloadFake(),
      store,
    });
    const reservation = await publisher.reserve(reservationInput());
    await expect(publisher.send({
      authorizationDigest: "e".repeat(64),
      effectId: reservation.effectId,
      workerId: "worker-1",
    })).resolves.toEqual({ status: "outcome_unknown" });
    await expect(publisher.send({
      authorizationDigest: "e".repeat(64),
      effectId: reservation.effectId,
      workerId: "worker-2",
    })).resolves.toEqual({ status: "outcome_unknown" });
    expect(delivery.creates).toBe(1);
  });

  it("cancels and scrubs a reserved payload before request start", async () => {
    const store = new StoreFake();
    const delivery = new DeliveryFake();
    const publisher = new DurableAnswerPublication({
      delivery,
      payloads: new PayloadFake(),
      store,
    });
    const reservation = await publisher.reserve(reservationInput());

    await expect(publisher.cancelBeforeRequest({
      questionId: "question-1",
      reason: "authorization_drift",
    })).resolves.toBe(true);
    expect(store.record).toMatchObject({ payloadBytes: "{}", state: "cancelled" });
    await expect(publisher.send({
      authorizationDigest: "e".repeat(64),
      effectId: reservation.effectId,
      workerId: "worker-2",
    })).resolves.toEqual({ status: "rejected_before_request" });
    expect(delivery.creates).toBe(0);
  });

  it("reconciles an exact remote match without another create", async () => {
    const store = new StoreFake();
    const delivery = new DeliveryFake();
    delivery.throwAfterCreate = true;
    const publisher = new DurableAnswerPublication({
      delivery,
      payloads: new PayloadFake(),
      store,
    });
    const reservation = await publisher.reserve(reservationInput());
    await publisher.send({
      authorizationDigest: "e".repeat(64),
      effectId: reservation.effectId,
      workerId: "worker-1",
    });
    delivery.inspection = {
      externalReceipt: "answer-message-reconciled",
      status: "found",
    };
    await expect(publisher.reconcileUnknown(10)).resolves.toEqual({
      absentUnconfirmed: 0,
      delivered: 1,
    });
    expect(store.record?.externalReceipt).toBe("answer-message-reconciled");
    expect(delivery.creates).toBe(1);
  });
});
