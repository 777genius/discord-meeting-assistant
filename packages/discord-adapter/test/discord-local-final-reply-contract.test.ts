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
import type { Client, REST } from "discord.js";

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
    const permissions = { bitfield: 3n, has: () => true };
    const thread = { permissionsFor: () => permissions };
    const room = { permissionsFor: () => permissions };
    const fetchChannel = vi.fn((id: string) => Promise.resolve(
      id === threadId ? thread : id === "55555555555555555" ? room : null,
    ));
    const guild = {
      channels: { fetch: fetchChannel },
      members: { fetch: () => Promise.resolve({}) },
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
  });

  it("creates once from strict immutable bytes and reconciles exact remote identity", async () => {
    const post = vi.fn().mockResolvedValue({ id: "88888888888888888" });
    const get = vi.fn();
    const rest = { get, post } as unknown as Pick<REST, "get" | "post">;
    const payload = new DiscordAnswerPayloadCodec().prepare({
      binding: binding(),
      content: "The release is Monday.\n-# S2 · 2:00:00 · turn-720",
      marker: "meeting-knowledge-answer:v1:question-1",
      projectionTargetContainerId: containerId,
      replyToRemoteMessageId: questionId,
    });
    const delivery = new DiscordAnswerDeliveryAdapter(rest, botId);

    const receipt = await delivery.create({
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
      marker: "meeting-knowledge-answer:v1:question-1",
      payloadHash: payload.payloadHash,
      projectionTargetContainerId: containerId,
      replyToRemoteMessageId: questionId,
    })).resolves.toEqual({ status: "unconfirmed" });
    expect(post).toHaveBeenCalledTimes(1);
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
      finalProjectionReceipt:
        `discord:v2:channel:${containerId}:message:44444444444444444`,
      projectionTargetContainerId: containerId,
      questionId,
      questionText: "When is the release?",
      schemaVersion: 1,
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
    const client = new EventEmitter();
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
      finalProjectionReceipt:
        `discord:v2:thread:${threadId}:message:${projectionMessageId}`,
      projectionTargetContainerId: containerId,
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
    const client = new EventEmitter();
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
