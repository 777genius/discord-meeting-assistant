import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AnswerDeliveryPort } from "@discord-meeting/meeting-core/publishing";

import {
  publicReplyCrashInjectionReceiptV1Schema,
  TestOnlyAnswerDeliveryCrashInjection,
} from "../src/adapters/outbound/test-only-answer-delivery-crash-injection.js";

class FakeDelivery implements AnswerDeliveryPort {
  public creates = 0;
  public create() { this.creates += 1; return Promise.resolve("1535000000000000001"); }
  public inspect() { return Promise.resolve({ externalReceipt: "1535000000000000001", status: "found" as const }); }
  public remove() { return Promise.resolve(); }
}

const input = {
  authorityScopeId: "scope-1",
  deliveryContainerId: "channel-1",
  effectId: "meeting-knowledge-answer:v1:question-1",
  marker: "effect-marker",
  payloadBytes: "{}",
  projectionTargetContainerId: "channel-1",
  replyToRemoteMessageId: "question-1",
};

describe("test-only public reply effect crash injection", () => {
  it("creates the real effect, retains a create-only crash receipt, then exits the supervised worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "answer-effect-crash-"));
    await writeFile(join(root, "public-reply-effect.arm.json"), JSON.stringify({
      campaignId: "campaign-1", injectionId: "inject-1", schemaVersion: 1,
    }), { mode: 0o600 });
    const delegate = new FakeDelivery();
    const delivery = new TestOnlyAnswerDeliveryCrashInjection(
      delegate, root, "worker-before-crash", () => Date.parse("2026-08-25T00:00:00.000Z"),
      async () => Promise.reject(new Error("SUPERVISOR_OBSERVED_WORKER_EXIT")),
    );
    await expect(delivery.create(input)).rejects.toThrow("SUPERVISOR_OBSERVED_WORKER_EXIT");
    expect(delegate.creates).toBe(1);
    expect(publicReplyCrashInjectionReceiptV1Schema.parse(JSON.parse(await readFile(
      join(root, "public-reply-effect.triggered.json"), "utf8",
    )))).toMatchObject({
      crashAfterPublicReplyEffect: true,
      effectId: input.effectId,
      externalReceipt: "1535000000000000001",
    });
  });

  it("cannot inject twice because the triggered receipt is create-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "answer-effect-crash-once-"));
    await writeFile(join(root, "public-reply-effect.arm.json"), JSON.stringify({
      campaignId: "campaign-1", injectionId: "inject-1", schemaVersion: 1,
    }), { mode: 0o600 });
    const delivery = new TestOnlyAnswerDeliveryCrashInjection(
      new FakeDelivery(), root, "worker-1", Date.now,
      async () => Promise.reject(new Error("SUPERVISOR_OBSERVED_WORKER_EXIT")),
    );
    await expect(delivery.create(input)).rejects.toThrow("SUPERVISOR_OBSERVED_WORKER_EXIT");
    await expect(delivery.create(input)).rejects.toThrow("ALREADY_TRIGGERED");
  });

  it("allows a different effect after the single injected crash", async () => {
    const root = await mkdtemp(join(tmpdir(), "answer-effect-crash-next-effect-"));
    await writeFile(join(root, "public-reply-effect.arm.json"), JSON.stringify({
      campaignId: "campaign-1", injectionId: "inject-1", schemaVersion: 1,
    }), { mode: 0o600 });
    const delegate = new FakeDelivery();
    const delivery = new TestOnlyAnswerDeliveryCrashInjection(
      delegate, root, "worker-1", Date.now,
      async () => Promise.reject(new Error("SUPERVISOR_OBSERVED_WORKER_EXIT")),
    );
    await expect(delivery.create(input)).rejects.toThrow("SUPERVISOR_OBSERVED_WORKER_EXIT");
    await expect(delivery.create({ ...input, effectId: `${input.effectId}-unsupported` }))
      .resolves.toBe("1535000000000000001");
    expect(delegate.creates).toBe(2);
  });
});
