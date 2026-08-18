import { describe, expect, it, vi } from "vitest";

import {
  DiscordAnswerDeliveryAdapter,
  DiscordAnswerPayloadCodec,
  DiscordHistoricalAuthorizationAdapter,
  DiscordLocalFinalReplyHandler,
  DiscordQuestionAuthorizationAdapter,
  DiscordQuestionPrincipalCodec,
  createDiscordOneAttemptAnswerRest,
} from "@discord-meeting/discord-adapter";
import { EventEmitter } from "node:events";
import type { AnswerPublicationBinding } from "@discord-meeting/meeting-core/publishing";
import { ChannelType, PermissionFlagsBits, type Client, type REST } from "discord.js";

const botId = "11111111111111111";
const containerId = "22222222222222222";
const questionId = "33333333333333333";

function binding(): AnswerPublicationBinding {
  return {
    authorizationDigest: "a".repeat(64),
    authorizationPolicyVersion: "discord.participant-current-results.v1",
    authorizationPrincipalRef: "opaque",
    botApplicationIdentity: botId,
    canonicalEvidenceHash: "b".repeat(64),
    deliveryContainerId: containerId,
    expectedLocale: "en",
    finalProjectionEpoch: "epoch-1",
    finalProjectionReceipt:
      `discord:v2:channel:${containerId}:message:44444444444444444`,
    humanActorIds: ["77777777777777777"],
    meetingId: "meeting-1",
    meetingRevision: 4,
    memoryGeneration: `focused-memory:v1:${"b".repeat(64)}`,
    policyVersion: "discord.participant-current-results.v1",
    projectionTargetContainerId: containerId,
    questionHash: "c".repeat(64),
    questionId,
    requesterSubject: "d".repeat(64),
    roomId: "55555555555555555",
    scopeId: "66666666666666666",
    transcriptId: "transcript-1",
    transcriptVersion: 1,
  };
}

describe("Discord Local Final Reply contracts", () => {
  it("isolates answer delivery in a REST client with automatic retries disabled", () => {
    const rest = createDiscordOneAttemptAnswerRest("test-token");

    expect(rest.options.retries).toBe(0);
    expect(rest.options.rejectOnRateLimit).toEqual(expect.any(Function));
  });

  it("encrypts resolvable principals separately from keyed dedupe identities", () => {
    const codec = new DiscordQuestionPrincipalCodec(Buffer.alloc(32, 7));
    const principal = codec.issue({
      actorId: "77777777777777777",
      authorizationContainerId: containerId,
      containerId,
      expiresAtMilliseconds: 1_800_000_000_000,
      scopeId: "66666666666666666",
    });

    expect(principal).not.toContain("77777777777777777");
    expect(codec.resolve(principal)).toEqual({
      actorId: "77777777777777777",
      authorizationContainerId: containerId,
      containerId,
      expiresAtMilliseconds: 1_800_000_000_000,
      scopeId: "66666666666666666",
      version: 2,
    });
    expect(codec.resolve(`${principal}tampered`)).toBeNull();
    expect(codec.keyedSubject("77777777777777777", "66666666666666666"))
      .not.toBe(codec.questionHash("77777777777777777"));
  });

  it("authorizes a canonical parent binding through the exact Discord thread", async () => {
    const threadId = "99999999999999991";
    const actorId = "77777777777777777";
    const codec = new DiscordQuestionPrincipalCodec(Buffer.alloc(32, 7));
    const principal = codec.issue({
      actorId,
      authorizationContainerId: threadId,
      containerId,
      expiresAtMilliseconds: 1_800_000_000_000,
      scopeId: "66666666666666666",
    });
    const permissions = {
      bitfield: 3n,
      has: (permission: bigint) => permission !== PermissionFlagsBits.ManageThreads,
    };
    const fetchThreadMember = vi.fn().mockResolvedValue({ id: actorId });
    const thread = {
      id: threadId,
      members: { fetch: fetchThreadMember },
      permissionsFor: () => permissions,
      type: ChannelType.PrivateThread,
    };
    const room = { id: "55555555555555555", permissionsFor: () => permissions };
    const fetchChannel = vi.fn((id: string) => Promise.resolve(
      id === threadId ? thread : id === "55555555555555555" ? room : null,
    ));
    const guild = {
      channels: { fetch: fetchChannel },
      members: { fetch: () => Promise.resolve({ id: actorId }) },
      roles: { fetch: () => Promise.resolve() },
    };
    const client = {
      guilds: { fetch: () => Promise.resolve(guild) },
    } as unknown as Client;

    await expect(new DiscordQuestionAuthorizationAdapter(
      client,
      codec,
      () => 1_799_999_000_000,
    ).observe({
      authorizationPrincipalRef: principal,
      expectedContainerId: containerId,
      expectedScopeId: "66666666666666666",
    })).resolves.toMatchObject({
      actorId,
      containerId,
      status: "authorized",
    });
    await expect(new DiscordHistoricalAuthorizationAdapter(
      client,
      codec,
      () => 1_799_999_000_000,
    ).authorize({
      authorizationPrincipalRef: principal,
      roomId: "55555555555555555",
      scopeId: "66666666666666666",
    })).resolves.toMatchObject({ authorized: true });
    expect(fetchChannel).toHaveBeenCalledWith(threadId, { force: true });
    expect(fetchThreadMember).toHaveBeenCalledWith({
      cache: false,
      force: true,
      member: actorId,
    });
  });
});

describe("Discord private-thread authorization", () => {
  it("revokes current and historical private-thread access after membership removal", async () => {
    const threadId = "99999999999999991";
    const actorId = "77777777777777777";
    const codec = new DiscordQuestionPrincipalCodec(Buffer.alloc(32, 7));
    const principal = codec.issue({
      actorId,
      authorizationContainerId: threadId,
      containerId,
      expiresAtMilliseconds: 1_800_000_000_000,
      scopeId: "66666666666666666",
    });
    const permissions = {
      bitfield: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory,
      has: (permission: bigint) =>
        permission === PermissionFlagsBits.ViewChannel ||
        permission === PermissionFlagsBits.ReadMessageHistory,
    };
    const thread = {
      id: threadId,
      members: { fetch: vi.fn().mockRejectedValue(new Error("Unknown Member")) },
      permissionsFor: () => permissions,
      type: ChannelType.PrivateThread,
    };
    const room = {
      id: "55555555555555555",
      permissionsFor: () => permissions,
      type: ChannelType.GuildVoice,
    };
    const guild = {
      channels: { fetch: (id: string) => Promise.resolve(id === threadId ? thread : room) },
      members: { fetch: () => Promise.resolve({ id: actorId }) },
      roles: { fetch: () => Promise.resolve() },
    };
    const client = { guilds: { fetch: () => Promise.resolve(guild) } } as unknown as Client;

    await expect(new DiscordQuestionAuthorizationAdapter(client, codec, () => 1_799_999_000_000)
      .observe({
        authorizationPrincipalRef: principal,
        expectedContainerId: containerId,
        expectedScopeId: "66666666666666666",
      })).resolves.toEqual({ reason: "denied", status: "denied" });
    await expect(new DiscordHistoricalAuthorizationAdapter(client, codec, () => 1_799_999_000_000)
      .authorize({
        authorizationPrincipalRef: principal,
        roomId: "55555555555555555",
        scopeId: "66666666666666666",
      })).resolves.toMatchObject({ authorized: false });
  });

  it("allows private-thread managers without membership and keeps public threads permission-based", async () => {
    const actorId = "77777777777777777";
    const codec = new DiscordQuestionPrincipalCodec(Buffer.alloc(32, 7));
    const authorize = async (type: ChannelType, managesThreads: boolean) => {
      const threadId = type === ChannelType.PrivateThread
        ? "99999999999999991"
        : "99999999999999992";
      const principal = codec.issue({
        actorId,
        authorizationContainerId: threadId,
        containerId,
        expiresAtMilliseconds: 1_800_000_000_000,
        scopeId: "66666666666666666",
      });
      const permissions = {
        bitfield: 7n,
        has: (permission: bigint) => permission !== PermissionFlagsBits.ManageThreads || managesThreads,
      };
      const fetchMembership = vi.fn().mockRejectedValue(new Error("Unknown Member"));
      const thread = {
        id: threadId,
        members: { fetch: fetchMembership },
        permissionsFor: () => permissions,
        type,
      };
      const room = {
        id: "55555555555555555",
        permissionsFor: () => permissions,
        type: ChannelType.GuildVoice,
      };
      const guild = {
        channels: {
          fetch: (id: string) => Promise.resolve(id === threadId ? thread : room),
        },
        members: { fetch: () => Promise.resolve({ id: actorId }) },
        roles: { fetch: () => Promise.resolve() },
      };
      const observation = await new DiscordQuestionAuthorizationAdapter(
        { guilds: { fetch: () => Promise.resolve(guild) } } as unknown as Client,
        codec,
        () => 1_799_999_000_000,
      ).observe({
        authorizationPrincipalRef: principal,
        expectedContainerId: containerId,
        expectedScopeId: "66666666666666666",
      });
      const historical = await new DiscordHistoricalAuthorizationAdapter(
        { guilds: { fetch: () => Promise.resolve(guild) } } as unknown as Client,
        codec,
        () => 1_799_999_000_000,
      ).authorize({
        authorizationPrincipalRef: principal,
        roomId: room.id,
        scopeId: "66666666666666666",
      });
      return { fetchMembership, historical, observation };
    };

    const manager = await authorize(ChannelType.PrivateThread, true);
    expect(manager.historical).toMatchObject({ authorized: true });
    expect(manager.observation).toMatchObject({ status: "authorized" });
    expect(manager.fetchMembership).not.toHaveBeenCalled();
    const publicThread = await authorize(ChannelType.PublicThread, false);
    expect(publicThread.historical).toMatchObject({ authorized: true });
    expect(publicThread.observation).toMatchObject({ status: "authorized" });
    expect(publicThread.fetchMembership).not.toHaveBeenCalled();
  });
});

describe("Discord answer effect transport", () => {
  it("creates once from strict immutable bytes and reconciles exact remote identity", async () => {
    const post = vi.fn().mockResolvedValue({ id: "88888888888888888" });
    const get = vi.fn();
    const remove = vi.fn().mockImplementation(() => Promise.resolve());
    const rest = { delete: remove, get, post } as unknown as Pick<
      REST,
      "delete" | "get" | "post"
    >;
    const payload = new DiscordAnswerPayloadCodec().prepare({
      binding: binding(),
      content: "The release is Monday.\n-# S2 · 2:00:00 · turn-720",
      deliveryContainerId: containerId,
      marker: "meeting-knowledge-answer:v1:question-1",
      projectionTargetContainerId: containerId,
      replyToRemoteMessageId: questionId,
    });
    const delivery = new DiscordAnswerDeliveryAdapter(rest, botId);

    const receipt = await delivery.create({
      deliveryContainerId: containerId,
      marker: "meeting-knowledge-answer:v1:question-1",
      payloadBytes: payload.payloadBytes,
      projectionTargetContainerId: containerId,
      replyToRemoteMessageId: questionId,
    });
    expect(receipt).toBe("88888888888888888");
    expect(post).toHaveBeenCalledTimes(1);

    const postedBody = JSON.parse(payload.payloadBytes) as {
      readonly embeds: readonly unknown[];
    };
    expect(post).toHaveBeenCalledWith(expect.anything(), { body: postedBody });
    get.mockResolvedValue([{
      application_id: botId,
      author: { id: botId },
      embeds: postedBody.embeds,
      id: receipt,
      message_reference: { message_id: questionId },
    }]);
    await expect(delivery.inspect({
      deliveryContainerId: containerId,
      marker: "meeting-knowledge-answer:v1:question-1",
      payloadHash: payload.payloadHash,
      projectionTargetContainerId: containerId,
      replyToRemoteMessageId: questionId,
    })).resolves.toEqual({ externalReceipt: receipt, status: "found" });
    get.mockResolvedValue([
      {
        application_id: botId,
        author: { id: botId },
        embeds: postedBody.embeds,
        id: receipt,
        message_reference: { message_id: questionId },
      },
      {
        application_id: botId,
        author: { id: botId },
        embeds: postedBody.embeds,
        id: "99999999999999999",
        message_reference: { message_id: questionId },
      },
    ]);
    await expect(delivery.inspect({
      deliveryContainerId: containerId,
      marker: "meeting-knowledge-answer:v1:question-1",
      payloadHash: payload.payloadHash,
      projectionTargetContainerId: containerId,
      replyToRemoteMessageId: questionId,
    })).resolves.toEqual({ status: "unconfirmed" });

    await expect(delivery.remove({
      deliveryContainerId: containerId,
      effectId: "meeting-knowledge-answer:v1:question-1",
      externalReceipt: receipt,
    })).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledTimes(1);
    remove.mockRejectedValueOnce({ code: 10_008, status: 404 });
    await expect(delivery.remove({
      deliveryContainerId: containerId,
      effectId: "meeting-knowledge-answer:v1:question-1",
      externalReceipt: receipt,
    })).resolves.toBeUndefined();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("finds an old answer by paging forward from its immutable reply receipt", async () => {
    const payload = new DiscordAnswerPayloadCodec().prepare({
      binding: binding(),
      content: "The release is Monday.\n-# S2 · 2:00:00 · turn-720",
      deliveryContainerId: containerId,
      marker: "meeting-knowledge-answer:v1:question-1",
      projectionTargetContainerId: containerId,
      replyToRemoteMessageId: questionId,
    });
    const postedBody = JSON.parse(payload.payloadBytes) as {
      readonly embeds: readonly unknown[];
    };
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      application_id: botId,
      author: { id: botId },
      embeds: [],
      id: (BigInt(questionId) + BigInt(index) + 1n).toString(),
      message_reference: { message_id: questionId },
    }));
    const receipt = (BigInt(questionId) + 101n).toString();
    const get = vi.fn().mockImplementation((
      _route: unknown,
      options: { readonly query: URLSearchParams },
    ) => {
      const after = options.query.get("after");
      if (after === questionId) {
        return Promise.resolve(firstPage);
      }
      if (after === firstPage.at(-1)?.id) {
        return Promise.resolve([{
          application_id: botId,
          author: { id: botId },
          embeds: postedBody.embeds,
          id: receipt,
          message_reference: { message_id: questionId },
        }]);
      }
      throw new Error("unexpected reconciliation cursor");
    });
    const delivery = new DiscordAnswerDeliveryAdapter(
      { get, post: vi.fn() } as unknown as Pick<REST, "get" | "post">,
      botId,
    );

    await expect(delivery.inspect({
      deliveryContainerId: containerId,
      marker: "meeting-knowledge-answer:v1:question-1",
      payloadHash: payload.payloadHash,
      projectionTargetContainerId: containerId,
      replyToRemoteMessageId: questionId,
    })).resolves.toEqual({ externalReceipt: receipt, status: "found" });
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls.map(([, options]) =>
      (options as { readonly query: URLSearchParams }).query.get("after")
    )).toEqual([questionId, firstPage.at(-1)?.id]);
  });
});

describe("Discord Local Final Reply ingress", () => {
  it("admits one human create reply only in the installed results container", async () => {
    const execute = vi.fn().mockResolvedValue({
      jobId: questionId,
      status: "accepted",
    });
    const cancelQuestion = vi.fn().mockImplementation(() => Promise.resolve());
    const client = new EventEmitter();
    const handler = new DiscordLocalFinalReplyHandler({
      admission: { execute },
      admissions: {
        withdrawProjection: vi.fn().mockResolvedValue([]),
      },
      client: client as unknown as Client,
      jobs: {
        cancelQuestion,
        hasActiveQuestion: vi.fn().mockResolvedValue(false),
      },
      nowMilliseconds: () => 1_800_000_000_000,
      options: { principalTtlSeconds: 900 },
      principals: new DiscordQuestionPrincipalCodec(Buffer.alloc(32, 7)),
      publication: { cancelBeforeRequest: vi.fn().mockResolvedValue(false) },
      scopes: {
        resultsContainerForGuild: () => Promise.resolve(containerId),
      },
    });
    handler.start();
    client.emit("messageCreate", {
      author: { bot: false, id: "77777777777777777" },
      channel: { isThread: () => false },
      channelId: containerId,
      content: "  When is the release?  ",
      guildId: "66666666666666666",
      id: questionId,
      reference: {
        channelId: containerId,
        messageId: "44444444444444444",
      },
      webhookId: null,
    });
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1);
    });
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      deliveryContainerId: containerId,
      finalProjectionReceipt:
        `discord:v2:channel:${containerId}:message:44444444444444444`,
      projectionTargetContainerId: containerId,
      questionId,
      questionText: "When is the release?",
      schemaVersion: 2,
      scopeId: "66666666666666666",
    });

    client.emit("messageCreate", {
      author: { bot: true, id: botId },
      channel: { isThread: () => false },
      channelId: containerId,
      content: "Bot question?",
      guildId: "66666666666666666",
      id: "99999999999999999",
      reference: { messageId: "44444444444444444" },
      webhookId: null,
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(execute).toHaveBeenCalledTimes(1);
    handler.close();
  });

  it("admits and withdraws an exact canonical thread projection under its results parent", async () => {
    const threadId = "99999999999999991";
    const projectionMessageId = "44444444444444444";
    const execute = vi.fn().mockResolvedValue({ jobId: questionId, status: "accepted" });
    const withdrawProjection = vi.fn().mockResolvedValue([questionId]);
    const cancelQuestion = vi.fn().mockImplementation(() => Promise.resolve());
    const client = Object.assign(new EventEmitter(), {
      user: { id: botId },
    });
    const handler = new DiscordLocalFinalReplyHandler({
      admission: { execute },
      admissions: { withdrawProjection },
      client: client as unknown as Client,
      jobs: {
        cancelQuestion,
        hasActiveQuestion: vi.fn().mockResolvedValue(false),
      },
      nowMilliseconds: () => 1_800_000_000_000,
      options: { principalTtlSeconds: 900 },
      principals: new DiscordQuestionPrincipalCodec(Buffer.alloc(32, 7)),
      publication: { cancelBeforeRequest: vi.fn().mockResolvedValue(true) },
      scopes: { resultsContainerForGuild: () => Promise.resolve(containerId) },
    });
    const thread = { id: threadId, isThread: () => true, parentId: containerId };
    handler.start();
    client.emit("messageCreate", {
      author: { bot: false, id: "77777777777777777" },
      channel: thread,
      channelId: threadId,
      content: "Where is the decision?",
      guildId: "66666666666666666",
      id: questionId,
      reference: { channelId: threadId, messageId: projectionMessageId },
      webhookId: null,
    });
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1);
    });
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      deliveryContainerId: threadId,
      finalProjectionReceipt:
        `discord:v2:thread:${threadId}:message:${projectionMessageId}`,
      projectionTargetContainerId: containerId,
      schemaVersion: 2,
    });

    client.emit("messageDelete", {
      channel: thread,
      channelId: threadId,
      guildId: "66666666666666666",
      id: projectionMessageId,
    });
    await vi.waitFor(() => {
      expect(withdrawProjection).toHaveBeenCalledTimes(1);
    });
    expect(withdrawProjection).toHaveBeenCalledWith({
      finalProjectionReceipt:
        `discord:v2:thread:${threadId}:message:${projectionMessageId}`,
    });

    client.emit("messageCreate", {
      author: { bot: false, id: "77777777777777777" },
      channel: { ...thread, parentId: "99999999999999992" },
      channelId: threadId,
      content: "Wrong parent?",
      guildId: "66666666666666666",
      id: "33333333333333334",
      reference: { channelId: threadId, messageId: projectionMessageId },
      webhookId: null,
    });
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        resolve();
      });
    });
    expect(execute).toHaveBeenCalledTimes(1);
    handler.close();
  });

  it("marks a deleted final unavailable, then cancels its pre-send effects and jobs", async () => {
    const cancelBeforeRequest = vi.fn().mockResolvedValue(true);
    const cancelQuestion = vi.fn().mockImplementation(() => Promise.resolve());
    const withdrawProjection = vi.fn().mockResolvedValue([questionId]);
    const client = Object.assign(new EventEmitter(), {
      user: { id: botId },
    });
    const handler = new DiscordLocalFinalReplyHandler({
      admission: { execute: vi.fn() },
      admissions: { withdrawProjection },
      client: client as unknown as Client,
      jobs: {
        cancelQuestion,
        hasActiveQuestion: vi.fn().mockResolvedValue(false),
      },
      options: { principalTtlSeconds: 900 },
      principals: new DiscordQuestionPrincipalCodec(Buffer.alloc(32, 7)),
      publication: { cancelBeforeRequest },
      scopes: {
        resultsContainerForGuild: () => Promise.resolve(containerId),
      },
    });
    handler.start();
    client.emit("messageDelete", {
      author: { id: "77777777777777777" },
      channel: { isThread: () => false },
      channelId: containerId,
      guildId: "66666666666666666",
      id: "44444444444444443",
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(withdrawProjection).not.toHaveBeenCalled();

    // Partial delete events have no author. Keep their race-safe DB tombstone
    // path; the PostgreSQL adapter bounds unmatched observations.
    client.emit("messageDelete", {
      channel: { isThread: () => false },
      channelId: containerId,
      guildId: "66666666666666666",
      id: "44444444444444444",
    });

    await vi.waitFor(() => {
      expect(cancelQuestion).toHaveBeenCalledWith(questionId);
    });
    expect(withdrawProjection).toHaveBeenCalledWith({
      finalProjectionReceipt:
        `discord:v2:channel:${containerId}:message:44444444444444444`,
    });
    expect(cancelBeforeRequest).toHaveBeenCalledWith({
      questionId,
      reason: "binding_drift",
    });
    handler.close();
  });
});
