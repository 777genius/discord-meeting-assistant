import { expect, it, vi } from "vitest";

import {
  DiscordAnswerDeliveryAdapter,
  DiscordAnswerPayloadCodec,
} from "@discord-meeting/discord-adapter";
import type { AnswerPublicationBinding } from "@discord-meeting/meeting-core/publishing";

const botId = "11111111111111111";
const containerId = "22222222222222222";
const questionId = "33333333333333333";
const marker = "meeting-knowledge-answer:v1:question-1";
const guildId = "66666666666666666";

function deliveryChannel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    guild_id: guildId,
    id: containerId,
    name: "meeting-results",
    nsfw: false,
    parent_id: "77777777777777770",
    permission_overwrites: [],
    position: 4,
    rate_limit_per_user: 0,
    topic: null,
    type: 0,
    ...overrides,
  };
}

function binding(): AnswerPublicationBinding {
  return {
    authorizationDigest: "a".repeat(64), authorizationPolicyVersion: "policy-v1",
    authorizationPrincipalRef: "opaque", botApplicationIdentity: botId,
    canonicalEvidenceHash: "b".repeat(64), deliveryContainerId: containerId,
    expectedLocale: "en", finalProjectionEpoch: "epoch-1",
    finalProjectionReceipt: `discord:v2:channel:${containerId}:message:44444444444444444`,
    humanActorIds: ["77777777777777777"], meetingId: "meeting-1", meetingRevision: 4,
    memoryGeneration: `focused-memory:v1:${"b".repeat(64)}`, policyVersion: "policy-v1",
    projectionTargetContainerId: containerId, questionHash: "c".repeat(64), questionId,
    requesterSubject: "d".repeat(64), roomId: "55555555555555555",
    scopeId: guildId, transcriptId: "transcript-1", transcriptVersion: 1,
  };
}

function expectedFixture() {
  const payload = new DiscordAnswerPayloadCodec().prepare({
    binding: binding(), content: "The release is Monday.", deliveryContainerId: containerId,
    marker, projectionTargetContainerId: containerId, replyToRemoteMessageId: questionId,
  });
  const body = JSON.parse(payload.payloadBytes) as { readonly embeds: readonly unknown[] };
  return { body, payload };
}

function authoredMessage(embeds: readonly unknown[], overrides: Record<string, unknown> = {}) {
  return {
    application_id: botId, attachments: [], author: { id: botId }, components: [], content: "",
    channel_id: containerId, embeds, guild_id: guildId, id: "88888888888888888", mention_roles: [], mentions: [],
    mention_everyone: false, message_reference: {
      channel_id: containerId, message_id: questionId, type: 0,
    }, pinned: false,
    sticker_items: [], tts: false, type: 19, ...overrides,
  };
}

async function inspectPages(get: ReturnType<typeof vi.fn>) {
  const { payload } = expectedFixture();
  const delivery = new DiscordAnswerDeliveryAdapter({
    get: vi.fn().mockResolvedValueOnce(deliveryChannel()).mockImplementation(
      get as (...args: unknown[]) => unknown,
    ),
    post: vi.fn(),
  }, botId);
  return delivery.inspect({
    authorityScopeId: guildId, deliveryContainerId: containerId, marker, payloadBytes: payload.payloadBytes,
    payloadHash: payload.payloadHash, projectionTargetContainerId: containerId,
    replyToRemoteMessageId: questionId,
  });
}

async function inspect(message: Record<string, unknown>) {
  const { payload } = expectedFixture();
  const delivery = new DiscordAnswerDeliveryAdapter({
    get: vi.fn().mockResolvedValueOnce(deliveryChannel()).mockResolvedValueOnce([message]),
    post: vi.fn(),
  }, botId);
  return delivery.inspect({
    authorityScopeId: guildId, deliveryContainerId: containerId, marker, payloadBytes: payload.payloadBytes,
    payloadHash: payload.payloadHash, projectionTargetContainerId: containerId,
    replyToRemoteMessageId: questionId,
  });
}

async function inspectTopology(input: {
  readonly channel: Record<string, unknown>;
  readonly deliveryContainerId: string;
  readonly projectionTargetContainerId: string;
}) {
  const effectBinding = {
    ...binding(),
    deliveryContainerId: input.deliveryContainerId,
    projectionTargetContainerId: input.projectionTargetContainerId,
  };
  const payload = new DiscordAnswerPayloadCodec().prepare({
    binding: effectBinding,
    content: "The release is Monday.",
    deliveryContainerId: input.deliveryContainerId,
    marker,
    projectionTargetContainerId: input.projectionTargetContainerId,
    replyToRemoteMessageId: questionId,
  });
  const get = vi.fn().mockResolvedValueOnce(input.channel).mockResolvedValueOnce([]);
  const delivery = new DiscordAnswerDeliveryAdapter(
    { get, post: vi.fn() },
    botId,
  );
  const result = await delivery.inspect({
    authorityScopeId: guildId,
    deliveryContainerId: input.deliveryContainerId,
    marker,
    payloadBytes: payload.payloadBytes,
    payloadHash: payload.payloadHash,
    projectionTargetContainerId: input.projectionTargetContainerId,
    replyToRemoteMessageId: questionId,
  });
  return { get, result };
}

it.each([
  ["extra content", { content: "I also claim Tuesday." }],
  ["component", { components: [{ type: 1 }] }],
  ["attachment", { attachments: [{ filename: "claim.txt", id: "1" }] }],
  ["sticker", { sticker_items: [{ id: "44444444444444444", name: "claim" }] }],
  ["poll", { poll: { question: { text: "Is this also true?" } } }],
  ["forwarded snapshot", { message_snapshots: [{ message: { content: "extra" } }] }],
  ["application activity", { activity: { type: 1 } }],
  ["role subscription claim", { role_subscription_data: { tier_name: "extra" } }],
  ["call claim", { call: { participants: [botId] } }],
  ["mention", { mentions: [{ id: "77777777777777777" }] }],
  ["message flag", { flags: 4 }],
  ["tts", { tts: true }],
  ["everyone mention", { mention_everyone: true }],
  ["non-reply type", { type: 0 }],
  ["pinned", { pinned: true }],
  ["edited timestamp", { edited_timestamp: "2026-08-25T00:00:00.000Z" }],
  ["reaction", { reactions: [{ count: 1, emoji: { name: "✅" } }] }],
  ["wrong referenced message", { referenced_message: { id: "99999999999999999" } }],
  ["thread", { thread: { id: "99999999999999999" } }],
  ["resolved", { resolved: { user_id: botId } }],
  ["shared client theme", { shared_client_theme: { colors: [1] } }],
  ["unknown future field", { future_claim_surface: { text: "extra" } }],
  ["webhook authorship", { webhook_id: "55555555555555555" }],
  ["wrong author", { author: { id: "99999999999999999" } }],
  ["foreign application marker", { application_id: "99999999999999999" }],
] as const)("fails closed when an otherwise matching answer has %s", async (
  _label, overrides,
) => {
  const { body } = expectedFixture();
  await expect(inspect(authoredMessage(body.embeds, overrides)))
    .resolves.toEqual({ status: "unconfirmed" });
});

it.each(["missing-content", "missing-embed", "extra-embed", "changed-marker",
  "embed-field"] as const)("fails closed for adversarial payload shape %s", async (variant) => {
  const { body } = expectedFixture();
  const message = authoredMessage(body.embeds) as Record<string, unknown>;
  if (variant === "missing-content") { delete message.content; }
  if (variant === "missing-embed") { message.embeds = []; }
  if (variant === "extra-embed") {
    message.embeds = [...body.embeds, { description: "extra" }];
  }
  if (variant === "changed-marker") {
    message.embeds = [{ ...(body.embeds[0] as object), url: "https://example.invalid/claim" }];
  }
  if (variant === "embed-field") {
    message.embeds = [{ ...(body.embeds[0] as object), title: "Extra claim" }];
  }
  await expect(inspect(message)).resolves.toEqual({ status: "unconfirmed" });
});

it("normalizes realistically omitted optional components and sticker arrays", async () => {
  const { body } = expectedFixture();
  const message = authoredMessage(body.embeds);
  delete (message as Partial<typeof message>).components;
  delete (message as Partial<typeof message>).sticker_items;
  await expect(inspect(message)).resolves.toEqual({
    externalReceipt: "88888888888888888", status: "found",
  });
});

it.each([
  ["top-level guild", { guild_id: "44444444444444444" }],
  ["top-level channel", { channel_id: "99999999999999999" }],
  ["reference channel", { message_reference: {
    channel_id: "99999999999999999", message_id: questionId, type: 0,
  } }],
  ["reference type", { message_reference: {
    channel_id: containerId, message_id: questionId, type: 1,
  } }],
  ["reference guild", { message_reference: {
    channel_id: containerId, guild_id: "55555555555555555", message_id: questionId, type: 0,
  } }],
  ["referenced channel", { referenced_message: {
    channel_id: "99999999999999999", guild_id: guildId, id: questionId,
  } }],
  ["referenced guild", { referenced_message: {
    channel_id: containerId, guild_id: "99999999999999999", id: questionId,
  } }],
  ["referenced type", { referenced_message: {
    channel_id: containerId, guild_id: guildId, id: questionId, type: 19,
  } }],
] as const)("fails closed on conflicting %s identity", async (_label, override) => {
  const { body } = expectedFixture();
  await expect(inspect(authoredMessage(body.embeds, override)))
    .resolves.toEqual({ status: "unconfirmed" });
});

it("fails closed when the authoritative top-level guild is absent", async () => {
  const { body } = expectedFixture();
  const message = authoredMessage(body.embeds);
  delete (message as Partial<typeof message>).guild_id;
  await expect(inspect(message)).resolves.toEqual({ status: "unconfirmed" });
});

it.each([
  ["projection target mismatch", deliveryChannel(), "99999999999999999"],
  ["wrong delivery channel identity", deliveryChannel({ id: "99999999999999999" }), containerId],
  ["wrong guild", deliveryChannel({ guild_id: "99999999999999999" }), containerId],
  ["missing guild", (() => { const value = deliveryChannel(); delete value.guild_id; return value; })(), containerId],
  ["malformed channel type", deliveryChannel({ type: "0" }), containerId],
] as const)("fails closed on %s in delivery-channel metadata", async (
  _label,
  channel,
  projectionTargetContainerId,
) => {
  const { get, result } = await inspectTopology({
    channel,
    deliveryContainerId: containerId,
    projectionTargetContainerId,
  });
  expect(result).toEqual({ status: "unconfirmed" });
  expect(get).toHaveBeenCalledTimes(1);
});

it("accepts a realistic direct-channel response only when delivery is the projection target", async () => {
  const { get, result } = await inspectTopology({
    channel: deliveryChannel(),
    deliveryContainerId: containerId,
    projectionTargetContainerId: containerId,
  });
  expect(result).toEqual({ status: "unconfirmed" });
  expect(get).toHaveBeenCalledTimes(2);
  expect(get.mock.calls[0]?.[0]).toBe(`/channels/${containerId}`);
});

it.each([10, 11, 12])("accepts Discord thread type %s only under the exact projection target", async (type) => {
  const threadId = "99999999999999991";
  const { get, result } = await inspectTopology({
    channel: deliveryChannel({ id: threadId, parent_id: containerId, type }),
    deliveryContainerId: threadId,
    projectionTargetContainerId: containerId,
  });
  expect(result).toEqual({ status: "unconfirmed" });
  expect(get).toHaveBeenCalledTimes(2);
});

it.each([
  ["wrong parent", "99999999999999992"],
  ["missing parent", undefined],
  ["null parent", null],
] as const)("fails closed for a thread with %s", async (_label, parentId) => {
  const threadId = "99999999999999991";
  const channel = deliveryChannel({ id: threadId, parent_id: parentId, type: 11 });
  if (parentId === undefined) {
    delete channel.parent_id;
  }
  const { get, result } = await inspectTopology({
    channel,
    deliveryContainerId: threadId,
    projectionTargetContainerId: containerId,
  });
  expect(result).toEqual({ status: "unconfirmed" });
  expect(get).toHaveBeenCalledTimes(1);
});

it.each([2, 4, 13, 15])("rejects unsupported non-thread delivery channel type %s", async (type) => {
  const { get, result } = await inspectTopology({
    channel: deliveryChannel({ type }),
    deliveryContainerId: containerId,
    projectionTargetContainerId: containerId,
  });
  expect(result).toEqual({ status: "unconfirmed" });
  expect(get).toHaveBeenCalledTimes(1);
});

it("does not retry or inspect history after channel-metadata transport failure", async () => {
  const { payload } = expectedFixture();
  const get = vi.fn().mockRejectedValueOnce(new Error("Discord 429 after REST retries"));
  const delivery = new DiscordAnswerDeliveryAdapter(
    { get, post: vi.fn() },
    botId,
  );
  await expect(delivery.inspect({
    authorityScopeId: guildId,
    deliveryContainerId: containerId,
    marker,
    payloadBytes: payload.payloadBytes,
    payloadHash: payload.payloadHash,
    projectionTargetContainerId: containerId,
    replyToRemoteMessageId: questionId,
  })).resolves.toEqual({ status: "unconfirmed" });
  expect(get).toHaveBeenCalledTimes(1);
});

it("rejects duplicate message IDs within one Discord history page", async () => {
  const duplicate = authoredMessage([], { author: { id: "99999999999999999" } });
  const get = vi.fn().mockResolvedValue([duplicate, { ...duplicate }]);
  await expect(inspectPages(get)).resolves.toEqual({ status: "unconfirmed" });
});

function fullPage(page: number): Record<string, unknown>[] {
  const first = BigInt(questionId) + 1n + BigInt(page * 100);
  return Array.from({ length: 100 }, (_, index) => authoredMessage([], {
    author: { id: "99999999999999999" },
    id: (first + BigInt(index)).toString(),
  }));
}

it("returns unconfirmed after ten full pages without proving history exhaustion", async () => {
  const get = vi.fn();
  for (let page = 0; page < 10; page += 1) {
    get.mockResolvedValueOnce(fullPage(page));
  }
  await expect(inspectPages(get)).resolves.toEqual({ status: "unconfirmed" });
  expect(get).toHaveBeenCalledTimes(10);
});

it("returns unconfirmed when a match precedes a later transport failure", async () => {
  const { body } = expectedFixture();
  const first = fullPage(0);
  first[0] = authoredMessage(body.embeds, { id: (BigInt(questionId) + 1n).toString() });
  const get = vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(new Error("later page"));
  await expect(inspectPages(get)).resolves.toEqual({ status: "unconfirmed" });
});

it("does not claim a unique match when a duplicate may exist beyond the page bound", async () => {
  const { body } = expectedFixture();
  const get = vi.fn();
  for (let page = 0; page < 10; page += 1) {
    const messages = fullPage(page);
    if (page === 0) {
      messages[0] = authoredMessage(body.embeds, {
        id: (BigInt(questionId) + 1n).toString(),
      });
    }
    get.mockResolvedValueOnce(messages);
  }
  await expect(inspectPages(get)).resolves.toEqual({ status: "unconfirmed" });
});
