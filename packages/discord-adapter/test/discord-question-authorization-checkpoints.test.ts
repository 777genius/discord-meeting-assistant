import {
  DiscordQuestionAuthorizationAdapter,
  DiscordQuestionPrincipalCodec,
  discordParticipantQuestionPolicyVersion,
} from "@discord-meeting/discord-adapter";
import { ChannelType, PermissionFlagsBits, type Client } from "discord.js";
import { describe, expect, it } from "vitest";

const actorId = "77777777777777777";
const botId = "11111111111111111";
const containerId = "22222222222222222";
const guildId = "66666666666666666";
const projectionMessageId = "44444444444444444";
const questionId = "33333333333333333";

describe("Discord fresh question authorization checkpoints", () => {
  it("keeps time-varying observations bound to one digest and policy", async () => {
    const codec = new DiscordQuestionPrincipalCodec(Buffer.alloc(32, 7));
    let now = 1_799_999_000_000;
    const principal = codec.issue({
      actorId,
      authorizationContainerId: containerId,
      containerId,
      expiresAtMilliseconds: now + 90_000,
      scopeId: guildId,
    });
    const permissions = {
      bitfield: PermissionFlagsBits.ViewChannel |
        PermissionFlagsBits.ReadMessageHistory,
      has: (permission: bigint) => permission === PermissionFlagsBits.ViewChannel ||
        permission === PermissionFlagsBits.ReadMessageHistory,
    };
    const messages = new Map([
      [questionId, {
        author: { id: actorId }, channelId: containerId,
        content: "What changed?", reference: {
          channelId: containerId, messageId: projectionMessageId,
        }, webhookId: null,
      }],
      [projectionMessageId, {
        author: { id: botId }, channelId: containerId,
        content: "Canonical projection", reference: undefined, webhookId: null,
      }],
    ]);
    const channel = {
      id: containerId, isTextBased: () => true, isThread: () => false,
      messages: { fetch: ({ message }: { readonly message: string }) =>
        Promise.resolve(messages.get(message)) },
      permissionsFor: () => permissions, type: ChannelType.GuildText,
    };
    const guild = {
      channels: { fetch: () => Promise.resolve(channel) },
      members: { fetch: () => Promise.resolve({ id: actorId }) },
      roles: { fetch: () => Promise.resolve() },
    };
    const adapter = new DiscordQuestionAuthorizationAdapter(
      { guilds: { fetch: () => Promise.resolve(guild) } } as unknown as Client,
      codec,
      () => now,
    );
    const request = {
      authorizationPrincipalRef: principal,
      checkpoint: "before_generation" as const,
      expectedContainerId: containerId,
      expectedQuestion: {
        botApplicationIdentity: botId,
        deliveryContainerId: containerId,
        finalProjectionReceipt:
          `discord:v2:channel:${containerId}:message:${projectionMessageId}`,
        questionHash: codec.questionHash("What changed?"),
        requesterSubject: codec.keyedSubject(actorId, guildId),
      },
      expectedScopeId: guildId,
      questionId,
    };

    const admitted = await adapter.observe({
      authorizationPrincipalRef: principal,
      checkpoint: "admission",
      expectedContainerId: containerId,
      expectedScopeId: guildId,
      questionId,
    });
    now += 20_000;
    const beforeGeneration = await adapter.observe(request);
    now += 20_000;
    const beforeReservation = await adapter.observe({
      ...request,
      checkpoint: "before_effect_reservation",
    });
    now += 20_000;
    const beforeSend = await adapter.observe({
      ...request,
      checkpoint: "before_send_cas",
    });
    expect(admitted).toMatchObject({
      policyVersion: discordParticipantQuestionPolicyVersion,
      source: "authoritative_remote",
      status: "authorized",
    });
    expect(beforeGeneration).toMatchObject({
      digest: admitted.status === "authorized" ? admitted.digest : "",
      policyVersion: discordParticipantQuestionPolicyVersion,
      source: "authoritative_remote",
      status: "authorized",
    });
    expect(beforeGeneration).not.toMatchObject({
      expiresAt: admitted.status === "authorized" ? admitted.expiresAt : "",
    });
    for (const observation of [beforeReservation, beforeSend]) {
      expect(observation).toMatchObject({
        digest: admitted.status === "authorized" ? admitted.digest : "",
        policyVersion: discordParticipantQuestionPolicyVersion,
        source: "authoritative_remote",
        status: "authorized",
      });
    }
    now += 30_000;
    await expect(adapter.observe(request)).resolves.toEqual({
      reason: "expired", status: "denied",
    });
  });

  it.each([
    ["rate limit", { code: 20_028, status: 429 }, "unavailable"],
    ["timeout", Object.assign(new Error("timed out"), { name: "AbortError" }),
      "unavailable"],
    ["server failure", { status: 503 }, "unavailable"],
    ["permission transport", { code: 50_013, status: 403 }, "unavailable"],
    ["unclassified HTTP absence", { status: 404 }, "unavailable"],
    ["exact missing message", { code: 10_008, status: 404 }, "absent"],
  ] as const)("classifies an exact checkpoint fetch: %s",
    async (_label, fetchError, expectedReason) => {
      const codec = new DiscordQuestionPrincipalCodec(Buffer.alloc(32, 7));
      const now = 1_799_999_000_000;
      const principal = codec.issue({ actorId, authorizationContainerId: containerId,
        containerId, expiresAtMilliseconds: now + 90_000, scopeId: guildId });
      const permissions = {
        bitfield: PermissionFlagsBits.ViewChannel |
          PermissionFlagsBits.ReadMessageHistory,
        has: (permission: bigint) => permission === PermissionFlagsBits.ViewChannel ||
          permission === PermissionFlagsBits.ReadMessageHistory,
      };
      const channel = {
        id: containerId, isTextBased: () => true, isThread: () => false,
        messages: { fetch: () => Promise.reject(fetchError) },
        permissionsFor: () => permissions, type: ChannelType.GuildText,
      };
      const guild = {
        channels: { fetch: () => Promise.resolve(channel) },
        members: { fetch: () => Promise.resolve({ id: actorId }) },
        roles: { fetch: () => Promise.resolve() },
      };
      const adapter = new DiscordQuestionAuthorizationAdapter(
        { guilds: { fetch: () => Promise.resolve(guild) } } as unknown as Client,
        codec, () => now,
      );

      await expect(adapter.observe({
        authorizationPrincipalRef: principal, checkpoint: "before_send_cas",
        expectedContainerId: containerId,
        expectedQuestion: { botApplicationIdentity: botId,
          deliveryContainerId: containerId,
          finalProjectionReceipt:
            `discord:v2:channel:${containerId}:message:${projectionMessageId}`,
          questionHash: codec.questionHash("What changed?"),
          requesterSubject: codec.keyedSubject(actorId, guildId) },
        expectedScopeId: guildId, questionId,
      })).resolves.toEqual({ reason: expectedReason, status: "denied" });
    });
});
