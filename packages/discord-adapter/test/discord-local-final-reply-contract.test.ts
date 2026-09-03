import { describe, expect, it, vi } from "vitest";

import { DiscordAnswerDeliveryAdapter, DiscordAnswerPayloadCodec, DiscordHistoricalAuthorizationAdapter,
  DiscordLocalFinalReplyHandler, DiscordQuestionAuthorizationAdapter, DiscordQuestionPrincipalCodec,
  createDiscordOneAttemptAnswerRest } from "@discord-meeting/discord-adapter";
import { EventEmitter } from "node:events";
import { ChannelType, PermissionFlagsBits, type Client, type REST } from "discord.js";
import { BoundedDiscordAuthorizationQueue } from "../src/discord-question-authorization.js";
import { authoredAnswerMessage, binding, botId, containerId, deletedMessage,
  directDeliveryChannelMetadata, guildId, ingressMessage, questionId } from "./discord-local-final-reply-contract.fixture.js";

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
      members: { fetch: vi.fn().mockRejectedValue(
        Object.assign(new Error("Unknown Member"), { code: 10_007 }),
      ) },
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

  it("aborts an in-flight historical authorization fetch", async () => {
    const codec = new DiscordQuestionPrincipalCodec(Buffer.alloc(32, 7));
    const principal = codec.issue({
      actorId: "77777777777777777",
      authorizationContainerId: containerId,
      containerId,
      expiresAtMilliseconds: 1_800_000_000_000,
      scopeId: "66666666666666666",
    });
    const fetchGuild = vi.fn(() => new Promise<never>(() => {}));
    const controller = new AbortController();
    const adapter = new DiscordHistoricalAuthorizationAdapter(
      { guilds: { fetch: fetchGuild } } as unknown as Client,
      codec,
      () => 1_799_999_000_000,
    );
    const pending = adapter.authorize({
      authorizationPrincipalRef: principal,
      roomId: "55555555555555555",
      scopeId: "66666666666666666",
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(fetchGuild).toHaveBeenCalledOnce();
    });
    controller.abort("disconnected");

    await expect(pending).rejects.toBe("disconnected");
    expect(fetchGuild).toHaveBeenCalledOnce();

    const queuedController = new AbortController();
    const queued = adapter.authorize({
      authorizationPrincipalRef: principal,
      roomId: "55555555555555555",
      scopeId: "66666666666666666",
      signal: queuedController.signal,
    });
    await Promise.resolve();
    queuedController.abort("superseded");
    await expect(queued).rejects.toBe("superseded");
    expect(fetchGuild).toHaveBeenCalledOnce();
  });

  it("releases the bounded slot when a manager throws synchronously", async () => {
    const operations = new BoundedDiscordAuthorizationQueue();

    await expect(operations.execute(undefined, () => {
      throw new Error("synchronous manager failure");
    })).rejects.toThrow("synchronous manager failure");
    await expect(operations.execute(undefined, async () => "recovered"))
      .resolves.toBe("recovered");
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
      authorityScopeId: guildId,
      deliveryContainerId: containerId,
      effectId: "meeting-knowledge-answer:v1:question-1",
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
    expect(post).toHaveBeenCalledWith(expect.anything(), { body: { ...postedBody, enforce_nonce: true, nonce: expect.stringMatching(/^[0-9a-f]{25}$/u) } });
    get.mockResolvedValueOnce(directDeliveryChannelMetadata()).mockResolvedValueOnce([
      authoredAnswerMessage({ embeds: postedBody.embeds, id: receipt }),
    ]);
    await expect(delivery.inspect({
      authorityScopeId: guildId,
      deliveryContainerId: containerId,
      marker: "meeting-knowledge-answer:v1:question-1",
      payloadBytes: payload.payloadBytes,
      payloadHash: payload.payloadHash,
      projectionTargetContainerId: containerId,
      replyToRemoteMessageId: questionId,
    })).resolves.toEqual({ externalReceipt: receipt, status: "found" });
    get.mockResolvedValueOnce(directDeliveryChannelMetadata()).mockResolvedValueOnce([
      authoredAnswerMessage({ embeds: postedBody.embeds, id: receipt }),
      authoredAnswerMessage({ embeds: postedBody.embeds, id: "99999999999999999" }),
    ]);
    await expect(delivery.inspect({
      authorityScopeId: guildId,
      deliveryContainerId: containerId,
      marker: "meeting-knowledge-answer:v1:question-1",
      payloadBytes: payload.payloadBytes,
      payloadHash: payload.payloadHash,
      projectionTargetContainerId: containerId,
      replyToRemoteMessageId: questionId,
    })).resolves.toEqual({
      externalReceipts: [receipt, "99999999999999999"],
      status: "duplicate",
    });

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
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      authoredAnswerMessage({
        embeds: [], id: (BigInt(questionId) + BigInt(index) + 1n).toString(),
      }));
    const receipt = (BigInt(questionId) + 101n).toString();
    const get = vi.fn().mockImplementation((
      _route: unknown,
      options?: { readonly query: URLSearchParams },
    ) => {
      if (options === undefined) {
        return Promise.resolve(directDeliveryChannelMetadata());
      }
      const after = options.query.get("after");
      if (after === questionId) {
        return Promise.resolve(firstPage);
      }
      if (after === firstPage.at(-1)?.id) {
        return Promise.resolve([
          authoredAnswerMessage({ embeds: postedBody.embeds, id: receipt }),
        ]);
      }
      throw new Error("unexpected reconciliation cursor");
    });
    const delivery = new DiscordAnswerDeliveryAdapter(
      { get, post: vi.fn() },
      botId,
    );

    await expect(delivery.inspect({
      authorityScopeId: guildId,
      deliveryContainerId: containerId,
      marker: "meeting-knowledge-answer:v1:question-1",
      payloadBytes: payload.payloadBytes,
      payloadHash: payload.payloadHash,
      projectionTargetContainerId: containerId,
      replyToRemoteMessageId: questionId,
    })).resolves.toEqual({ externalReceipt: receipt, status: "found" });
    expect(get).toHaveBeenCalledTimes(3);
    expect(get.mock.calls.slice(1).map(([, options]) =>
      (options as { readonly query: URLSearchParams }).query.get("after")
    )).toEqual([questionId, firstPage.at(-1)?.id]);
  });

  it("reports duplicate exact receipts discovered on different history pages", async () => {
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
    const firstReceipt = (BigInt(questionId) + 1n).toString();
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      authoredAnswerMessage({
        embeds: index === 0 ? postedBody.embeds : [],
        id: (BigInt(questionId) + BigInt(index) + 1n).toString(),
      }));
    const secondReceipt = (BigInt(questionId) + 101n).toString();
    const get = vi.fn().mockImplementation((
      _route: unknown,
      options?: { readonly query: URLSearchParams },
    ) => {
      if (options === undefined) {
        return Promise.resolve(directDeliveryChannelMetadata());
      }
      const after = options.query.get("after");
      if (after === questionId) {
        return Promise.resolve(firstPage);
      }
      if (after === firstPage.at(-1)?.id) {
        return Promise.resolve([
          authoredAnswerMessage({ embeds: postedBody.embeds, id: secondReceipt }),
        ]);
      }
      throw new Error("unexpected reconciliation cursor");
    });
    const delivery = new DiscordAnswerDeliveryAdapter(
      { get, post: vi.fn() },
      botId,
    );

    await expect(delivery.inspect({
      authorityScopeId: guildId,
      deliveryContainerId: containerId,
      marker: "meeting-knowledge-answer:v1:question-1",
      payloadBytes: payload.payloadBytes,
      payloadHash: payload.payloadHash,
      projectionTargetContainerId: containerId,
      replyToRemoteMessageId: questionId,
    })).resolves.toEqual({
      externalReceipts: [firstReceipt, secondReceipt],
      status: "duplicate",
    });
    expect(get).toHaveBeenCalledTimes(3);
  });

});

describe("Discord Local Final Reply ingress", () => {
  it("serializes delete/edit tombstones before a late create for the same question",
    async () => {
      const order: string[] = [];
      const client = new EventEmitter();
      const handler = new DiscordLocalFinalReplyHandler({
        admission: { execute: vi.fn(async () => {
          order.push("create");
          return { jobId: questionId, status: "accepted" as const };
        }) },
        admissions: {
          recordQuestionMutation: vi.fn(async ({ kind }: { readonly kind: string }) => {
            order.push(kind);
          }),
          withdrawProjection: vi.fn().mockResolvedValue([]),
        },
        client: client as unknown as Client,
        jobs: {
          cancelQuestion: vi.fn(async () => {order.push("cancel");}),
          hasActiveQuestion: vi.fn().mockResolvedValue(false),
        },
        options: { principalTtlSeconds: 900 },
        principals: new DiscordQuestionPrincipalCodec(Buffer.alloc(32, 7)),
        publication: { cancelBeforeRequest: vi.fn().mockResolvedValue(false) },
        scopes: { resultsContainerForGuild: () => Promise.resolve(containerId) },
      });
      const create = {
        author: { bot: false, id: "77777777777777777" },
        channel: { isThread: () => false }, channelId: containerId,
        content: "What changed?", guildId, id: questionId,
        reference: { channelId: containerId, messageId: "44444444444444444" },
        webhookId: null,
      };
      handler.start();
      client.emit("messageDelete", { ...create, author: undefined });
      client.emit("messageCreate", create);
      client.emit("messageUpdate", create, create);
      client.emit("messageCreate", create);
      await handler.settle();

      expect(order).toEqual([
        "delete", "cancel", "create",
        "edit", "cancel", "create",
      ]);
      handler.close();
    });

  it("reconciles a missed delete for a terminal delivered answer after restart",
    async () => {
      const codec = new DiscordQuestionPrincipalCodec(Buffer.alloc(32, 7));
      const recordQuestionMutation = vi.fn().mockImplementation(() => Promise.resolve());
      const cancelQuestion = vi.fn().mockImplementation(() => Promise.resolve());
      const listActiveQuestionsForReconciliation = vi.fn()
        .mockResolvedValueOnce([{
          authorizationPrincipalRef: null,
          botApplicationIdentity: null,
          deliveryContainerId: containerId,
          finalProjectionReceipt:
            `discord:v2:channel:${containerId}:message:44444444444444444`,
          questionHash: codec.questionHash("What changed?"), questionId,
          requesterSubject: codec.keyedSubject("77777777777777777", guildId),
          scopeId: guildId,
        }]);
      const client = Object.assign(new EventEmitter(), {
        channels: { fetch: vi.fn().mockRejectedValue({ code: 10_008, status: 404 }) },
      });
      const handler = new DiscordLocalFinalReplyHandler({
        admission: { execute: vi.fn() },
        admissions: { recordQuestionMutation,
          withdrawProjection: vi.fn().mockResolvedValue([]) },
        client: client as unknown as Client,
        jobs: { cancelQuestion, hasActiveQuestion: vi.fn().mockResolvedValue(false),
          listActiveQuestionsForReconciliation },
        nowMilliseconds: () => 1_800_000_000_000,
        options: { principalTtlSeconds: 900 }, principals: codec,
        publication: { cancelBeforeRequest: vi.fn().mockResolvedValue(true) },
        scopes: { resultsContainerForGuild: () => Promise.resolve(containerId) },
      });
      handler.start();
      await handler.settle();

      expect(recordQuestionMutation).toHaveBeenCalledWith({ kind: "delete",
        questionId, retentionSeconds: 86_400 });
      expect(cancelQuestion).toHaveBeenCalledWith(questionId);
      handler.close();
    });

  it("drains more than 400 reconciliation rows through bounded cursor pages",
    async () => {
      const codec = new DiscordQuestionPrincipalCodec(Buffer.alloc(32, 7)); const questions = Array.from({ length: 401 }, (_, index) => {
        const id = String(77_000_000_000_000_000n + BigInt(index));
        return {
          authorizationPrincipalRef: null,
          botApplicationIdentity: null,
          deliveryContainerId: containerId,
          finalProjectionReceipt:
            `discord:v2:channel:${containerId}:message:44444444444444444`,
          questionHash: codec.questionHash(`Question ${index}`),
          questionId: id,
          requesterSubject: codec.keyedSubject("77777777777777777", guildId),
          scopeId: guildId,
        };
      });
      const listActiveQuestionsForReconciliation = vi.fn(async ({
        afterQuestionId, maximumRows,
      }: { readonly afterQuestionId: string | null; readonly maximumRows: number }) => {
        const start = afterQuestionId === null
          ? 0 : questions.findIndex(({ questionId: id }) => id === afterQuestionId) + 1;
        return questions.slice(start, start + maximumRows);
      });
      let durableCursor: string | null = null; const loadQuestionReconciliationCursor = vi.fn(async () => durableCursor);
      const saveQuestionReconciliationCursor = vi.fn(async ({
        expectedAfterQuestionId, nextAfterQuestionId,
      }: {
        readonly expectedAfterQuestionId: string | null;
        readonly nextAfterQuestionId: string | null;
      }) => {
        if (durableCursor !== expectedAfterQuestionId) {return false;}
        durableCursor = nextAfterQuestionId;
        return true;
      });
      const cancelQuestion = vi.fn().mockImplementation(() => Promise.resolve()); const client = Object.assign(new EventEmitter(), {
        channels: { fetch: vi.fn().mockRejectedValue({ code: 10_008, status: 404 }) },
      });
      const handler = new DiscordLocalFinalReplyHandler({
        admission: { execute: vi.fn() },
        admissions: { recordQuestionMutation: vi.fn().mockImplementation(
          () => Promise.resolve()),
          withdrawProjection: vi.fn().mockResolvedValue([]) },
        client: client as unknown as Client,
        jobs: { cancelQuestion, hasActiveQuestion: vi.fn().mockResolvedValue(false),
          listActiveQuestionsForReconciliation, loadQuestionReconciliationCursor,
          saveQuestionReconciliationCursor },
        options: { principalTtlSeconds: 900 }, principals: codec,
        publication: { cancelBeforeRequest: vi.fn().mockResolvedValue(true) },
        scopes: { resultsContainerForGuild: () => Promise.resolve(containerId) },
      });

      handler.start(); await handler.settle();
      for (let invocation = 1; invocation < 5; invocation += 1) {
        await handler.reconcilePending();
      }

      expect(listActiveQuestionsForReconciliation).toHaveBeenCalledTimes(5);
      expect(listActiveQuestionsForReconciliation.mock.calls.map(([input]) =>
        input.afterQuestionId)).toEqual([
          null, questions[99]!.questionId, questions[199]!.questionId,
          questions[299]!.questionId, questions[399]!.questionId,
        ]);
      expect(cancelQuestion).toHaveBeenCalledTimes(401);
      expect(loadQuestionReconciliationCursor).toHaveBeenCalledTimes(5);
      expect(saveQuestionReconciliationCursor.mock.calls.map(([input]) =>
        input.nextAfterQuestionId)).toEqual([
          questions[99]!.questionId, questions[199]!.questionId,
          questions[299]!.questionId, questions[399]!.questionId, null,
        ]);
      expect(durableCursor).toBeNull(); handler.close();
    });

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
    client.emit("messageCreate", ingressMessage({
      content: "  When is the release?  ",
    }));
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

    client.emit("messageCreate", ingressMessage({ author: { bot: true, id: botId },
      content: "Bot question?", id: "99999999999999999",
      reference: { messageId: "44444444444444444" } }));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(execute).toHaveBeenCalledTimes(1);
    handler.close();
  });
});

describe("Discord Local Final Reply canonical projection mutations", () => {
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
    client.emit("messageCreate", ingressMessage({ channel: thread, channelId: threadId,
      content: "Where is the decision?",
      reference: { channelId: threadId, messageId: projectionMessageId } }));
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

    client.emit("messageDelete", deletedMessage({ channel: thread, channelId: threadId,
      id: projectionMessageId }));
    await vi.waitFor(() => {
      expect(withdrawProjection).toHaveBeenCalledTimes(1);
    });
    expect(withdrawProjection).toHaveBeenCalledWith({
      finalProjectionReceipt:
        `discord:v2:thread:${threadId}:message:${projectionMessageId}`,
    });

    client.emit("messageCreate", ingressMessage({
      channel: { ...thread, parentId: "99999999999999992" }, channelId: threadId,
      content: "Wrong parent?", id: "33333333333333334",
      reference: { channelId: threadId, messageId: projectionMessageId } }));
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
    client.emit("messageDelete", deletedMessage({
      author: { id: "77777777777777777" }, id: "44444444444444443" }));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(withdrawProjection).not.toHaveBeenCalled();

    // Partial delete events have no author. Keep their race-safe DB tombstone
    // path; the PostgreSQL adapter bounds unmatched observations.
    client.emit("messageDelete", deletedMessage());

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

describe("Discord Local Final Reply synthetic human E2E ingress", () => {
  it("admits only an explicitly allowlisted bot and still rejects webhooks", async () => {
    const syntheticHumanId = "77777777777777777";
    const execute = vi.fn().mockResolvedValue({ jobId: questionId, status: "accepted" });
    const client = new EventEmitter();
    const handler = new DiscordLocalFinalReplyHandler({
      admission: { execute },
      admissions: { withdrawProjection: vi.fn().mockResolvedValue([]) },
      client: client as unknown as Client,
      jobs: {
        cancelQuestion: vi.fn().mockImplementation(() => Promise.resolve()),
        hasActiveQuestion: vi.fn().mockResolvedValue(false),
      },
      options: { e2eSyntheticHumanAuthorIds: [syntheticHumanId], principalTtlSeconds: 900 },
      principals: new DiscordQuestionPrincipalCodec(Buffer.alloc(32, 7)),
      publication: { cancelBeforeRequest: vi.fn().mockResolvedValue(false) },
      scopes: { resultsContainerForGuild: () => Promise.resolve(containerId) },
    });
    handler.start();
    for (const authorId of ["88888888888888888", syntheticHumanId]) {
      client.emit("messageCreate", ingressMessage({
        author: { bot: true, id: authorId }, content: "What was decided?", id: authorId,
        reference: { messageId: "44444444444444444" } }));
    }
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1);
    });
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      questionId: syntheticHumanId,
      questionText: "What was decided?",
    });
    client.emit("messageCreate", ingressMessage({
      author: { bot: true, id: syntheticHumanId }, content: "Webhook question?",
      id: "99999999999999998", reference: { messageId: "44444444444444444" },
      webhookId: "99999999999999997" }));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(execute).toHaveBeenCalledTimes(1);
    handler.close();
  });
});
