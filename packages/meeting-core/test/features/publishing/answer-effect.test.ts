import { describe, expect, it, vi } from "vitest";

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
      if (
        this.record.payloadHash !== input.payloadHash ||
        this.record.deliveryContainerId !== input.deliveryContainerId ||
        this.record.projectionTargetContainerId !== input.projectionTargetContainerId ||
        this.record.replyToRemoteMessageId !== input.replyToRemoteMessageId
      ) {
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

  startRequest(input: {
    readonly effectId: string;
    readonly generation: number;
    readonly questionGeneration: number;
  }) {
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
    if (
      this.record?.effectId !== input.effectId ||
      ![
        "absent_unconfirmed",
        "delivered",
        "outcome_unknown",
        "request_started",
      ].includes(this.record.state)
    ) {
      return Promise.resolve(false);
    }
    this.record = { ...this.record, externalReceipt: input.externalReceipt, state: "delivered" };
    return Promise.resolve(true);
  }

  markOutcomeUnknown(effectId: string) {
    if (
      this.record?.effectId !== effectId ||
      (
        this.record.state !== "request_started" &&
        this.record.state !== "outcome_unknown"
      )
    ) {
      return Promise.resolve(false);
    }
    this.record = { ...this.record, state: "outcome_unknown" };
    return Promise.resolve(true);
  }

  listOutcomeUnknown() {
    return Promise.resolve(
      this.record !== undefined &&
        ["absent_unconfirmed", "outcome_unknown"].includes(this.record.state)
        ? [this.record] : [],
    );
  }

  markAbsentUnconfirmed(effectId: string) {
    if (
      this.record?.effectId !== effectId ||
      !["absent_unconfirmed", "outcome_unknown"].includes(this.record.state)
    ) {
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

  listRetractionPending() {
    return Promise.resolve(
      this.record?.state === "retraction_pending" ? [this.record] : [],
    );
  }

  recordRetractionReceipt(input: {
    readonly effectId: string;
    readonly externalReceipt: string;
  }) {
    if (this.record?.effectId !== input.effectId) {
      return Promise.resolve(false);
    }
    this.record = { ...this.record, externalReceipt: input.externalReceipt };
    return Promise.resolve(true);
  }

  markRetracted(input: {
    readonly effectId: string;
    readonly externalReceipt: string;
  }) {
    if (
      this.record?.effectId !== input.effectId ||
      this.record.externalReceipt !== input.externalReceipt
    ) {
      return Promise.resolve(false);
    }
    this.record = { ...this.record, payloadBytes: "{}", state: "retracted" };
    return Promise.resolve(true);
  }
}

class DeliveryFake implements AnswerDeliveryPort {
  creates = 0;
  createInputs: Parameters<AnswerDeliveryPort["create"]>[0][] = [];
  inspectInputs: Parameters<AnswerDeliveryPort["inspect"]>[0][] = [];
  removeInputs: Parameters<AnswerDeliveryPort["remove"]>[0][] = [];
  throwAfterCreate = false;
  createResult?: Promise<string>;
  inspection: Awaited<ReturnType<AnswerDeliveryPort["inspect"]>> = {
    status: "unconfirmed",
  };

  create(input: Parameters<AnswerDeliveryPort["create"]>[0]): Promise<string> {
    this.creates += 1;
    this.createInputs.push(input);
    if (this.throwAfterCreate) {
      return Promise.reject(new Error("lost response after committed create"));
    }
    return this.createResult ?? Promise.resolve("answer-message-1");
  }

  inspect(input: Parameters<AnswerDeliveryPort["inspect"]>[0]) {
    this.inspectInputs.push(input);
    return Promise.resolve(this.inspection);
  }

  remove(input: Parameters<AnswerDeliveryPort["remove"]>[0]) {
    this.removeInputs.push(input);
    return Promise.resolve();
  }
}

const binding = {
  authorizationDigest: "a".repeat(64),
  authorizationPolicyVersion: "discord.participant-current-results.v1",
  authorizationPrincipalRef: "principal:v1:opaque",
  botApplicationIdentity: "botik-application-1",
  canonicalEvidenceHash: "b".repeat(64),
  deliveryContainerId: "thread-1",
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
    deliveryContainerId: "thread-1",
    marker: "meeting-knowledge-answer:v1:question-1",
    projectionTargetContainerId: "results-1",
    questionGeneration: 1,
    replyToRemoteMessageId: "question-1",
    sourceMeetingIds: ["meeting-1"],
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
    expect(canTransitionAnswerEffect("absent_unconfirmed", "delivered")).toBe(true);
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
      questionGeneration: 1,
      workerId: "worker-1",
    })).resolves.toEqual({
      externalReceipt: "answer-message-1",
      status: "delivered",
    });
    expect(delivery.creates).toBe(1);
    expect(delivery.createInputs[0]).toMatchObject({
      deliveryContainerId: "thread-1",
      projectionTargetContainerId: "results-1",
    });
    expect(store.record?.state).toBe("delivered");

    await expect(publisher.send({
      authorizationDigest: "e".repeat(64),
      effectId: reservation.effectId,
      questionGeneration: 1,
      workerId: "worker-2",
    })).resolves.toEqual({ status: "rejected_before_request" });
    expect(delivery.creates).toBe(1);
  });

  it("rejects rebinding an idempotent effect to another delivery container", async () => {
    const publisher = new DurableAnswerPublication({
      delivery: new DeliveryFake(),
      payloads: new PayloadFake(),
      store: new StoreFake(),
    });
    await publisher.reserve(reservationInput());
    await expect(publisher.reserve({
      ...reservationInput(),
      deliveryContainerId: "cross-scope-thread",
    })).rejects.toThrow("conflicts with immutable bytes");
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
      questionGeneration: 1,
      workerId: "worker-1",
    })).resolves.toEqual({ status: "outcome_unknown" });
    await expect(publisher.send({
      authorizationDigest: "e".repeat(64),
      effectId: reservation.effectId,
      questionGeneration: 1,
      workerId: "worker-2",
    })).resolves.toEqual({ status: "outcome_unknown" });
    expect(delivery.creates).toBe(1);
  });

  it("keeps reconciling an unconfirmed absence after restart until its exact receipt appears", async () => {
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
    await expect(publisher.reconcileUnknown(10)).resolves.toEqual({
      absentUnconfirmed: 1,
      delivered: 0,
    });
    expect(store.record?.state).toBe("absent_unconfirmed");

    delivery.inspection = {
      externalReceipt: "answer-message-after-restart",
      status: "found",
    };
    await expect(publisher.reconcileUnknown(10)).resolves.toEqual({
      absentUnconfirmed: 0,
      delivered: 1,
    });
    expect(store.record).toMatchObject({
      externalReceipt: "answer-message-after-restart",
      state: "delivered",
    });
    expect(delivery.creates).toBe(1);
  });

});

describe("Duplicate answer-effect reconciliation", () => {
  it("keeps duplicate exact receipts unresolved for manual containment", async () => {
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
      externalReceipts: ["answer-message-1", "answer-message-2"],
      status: "duplicate",
    };

    await expect(publisher.reconcileUnknown(10)).resolves.toEqual({
      absentUnconfirmed: 0,
      delivered: 0,
    });
    expect(store.record?.state).toBe("outcome_unknown");
  });
});

describe("Publishing answer effect recovery", () => {
  it("accepts a late receipt after reconciliation observed an in-flight create as absent", async () => {
    const store = new StoreFake();
    const delivery = new DeliveryFake();
    let resolveCreate: ((receipt: string) => void) | undefined;
    delivery.createResult = new Promise<string>((resolve) => {
      resolveCreate = resolve;
    });
    const publisher = new DurableAnswerPublication({
      delivery,
      payloads: new PayloadFake(),
      store,
    });
    const reservation = await publisher.reserve(reservationInput());
    const sending = publisher.send({
      authorizationDigest: "e".repeat(64),
      effectId: reservation.effectId,
      workerId: "worker-1",
    });
    await vi.waitFor(() => {
      expect(delivery.creates).toBe(1);
    });

    await store.markOutcomeUnknown(reservation.effectId);
    await expect(publisher.reconcileUnknown(10)).resolves.toEqual({
      absentUnconfirmed: 1,
      delivered: 0,
    });
    expect(store.record?.state).toBe("absent_unconfirmed");

    resolveCreate?.("answer-message-late");
    await expect(sending).resolves.toEqual({
      externalReceipt: "answer-message-late",
      status: "delivered",
    });
    expect(store.record).toMatchObject({
      externalReceipt: "answer-message-late",
      state: "delivered",
    });
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
      questionGeneration: 1,
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
      questionGeneration: 1,
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
    expect(delivery.inspectInputs).toEqual([expect.objectContaining({
      deliveryContainerId: "thread-1",
      projectionTargetContainerId: "results-1",
    })]);
  });

  it("retracts an outcome-unknown answer only by its exact reconciled receipt", async () => {
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
      questionGeneration: 1,
      workerId: "worker-1",
    });
    if (store.record === undefined) {
      throw new Error("answer effect was not retained");
    }
    store.record = { ...store.record, state: "retraction_pending" };
    delivery.inspection = {
      externalReceipt: "answer-message-reconciled",
      status: "found",
    };

    await expect(publisher.reconcileRetractions(10)).resolves.toEqual({
      pending: 0,
      retracted: 1,
    });
    expect(delivery.removeInputs).toEqual([{
      deliveryContainerId: "thread-1",
      effectId: "meeting-knowledge-answer:v1:question-1",
      externalReceipt: "answer-message-reconciled",
    }]);
    expect(store.record).toMatchObject({
      externalReceipt: "answer-message-reconciled",
      state: "retracted",
    });
  });
});
