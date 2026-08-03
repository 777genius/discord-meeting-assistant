import {
  ChannelType,
  Client,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import { describe, expect, it, vi } from "vitest";

import {
  DiscordGuildSetupAdapter,
  DiscordGuildSetupCommandHandler,
  craigGatewayInstallPermissions,
  createDiscordGuildInstallUrl,
  discordGuildSetupCommand,
  meetingPlatformInstallPermissions,
  registerDiscordGuildSetupCommand,
} from "../src/index.js";

const ids = {
  actor: "11111111111111111",
  craig: "22222222222222222",
  guild: "33333333333333333",
  platform: "44444444444444444",
  results: "55555555555555555",
  voice: "66666666666666666",
} as const;

describe("Discord guild install URLs", () => {
  it("uses guild install with bot and application command scopes", () => {
    const url = new URL(createDiscordGuildInstallUrl({
      applicationId: ids.platform,
      permissions: meetingPlatformInstallPermissions,
    }));
    expect(url.origin).toBe("https://discord.com");
    expect(url.pathname).toBe("/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe(ids.platform);
    expect(url.searchParams.get("integration_type")).toBe("0");
    expect(url.searchParams.get("scope")).toBe("bot applications.commands");
    expect(BigInt(url.searchParams.get("permissions") ?? "0")).toBe(
      meetingPlatformInstallPermissions,
    );
    expect(craigGatewayInstallPermissions).not.toBe(meetingPlatformInstallPermissions);
  });
});

describe("/setup command contract", () => {
  it("is guild-install only and defaults to Manage Guild", () => {
    const command = discordGuildSetupCommand.toJSON();
    expect(command.name).toBe("setup");
    expect(command.default_member_permissions).toBe(
      PermissionFlagsBits.ManageGuild.toString(),
    );
    expect(command.options?.map((option) => option.name)).toEqual([
      "voice-channel",
      "results-channel",
    ]);
  });

  it("repairs guild-install and context drift without bulk command replacement", async () => {
    const expected = discordGuildSetupCommand.toJSON();
    const edit = vi.fn(async () => ({}));
    const create = vi.fn(async () => ({}));
    const client = {
      application: {
        commands: {
          create,
          edit,
          fetch: () => Promise.resolve([{
            id: "77777777777777777",
            name: expected.name,
            toJSON: () => ({ ...expected, contexts: [1], integration_types: [1] }),
          }]),
        },
      },
      isReady: () => true,
    } as unknown as Client;

    await registerDiscordGuildSetupCommand(client);

    expect(create).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledWith("77777777777777777", expected);
  });
});

describe("DiscordGuildSetupAdapter", () => {
  const request = {
    configuredByUserId: ids.actor,
    guildId: ids.guild,
    resultsChannelId: ids.results,
    voiceChannelId: ids.voice,
  } as const;

  function client(input: { readonly craigInstalled?: boolean; readonly platformCanPublish?: boolean }) {
    const channel = (
      id: string,
      type: ChannelType,
      permissions: readonly bigint[],
    ) => ({
      id,
      permissionsFor: (subjectId: string) => new PermissionsBitField(
        subjectId === ids.platform && input.platformCanPublish === false ? [] : permissions,
      ),
      type,
    });
    const voice = channel(ids.voice, ChannelType.GuildVoice, [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.Connect,
    ]);
    const results = channel(ids.results, ChannelType.GuildText, [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.ReadMessageHistory,
    ]);
    const guild = {
      channels: {
        fetch: (id: string) => Promise.resolve(id === ids.voice ? voice : results),
      },
      members: {
        fetch: (id: string) => {
          if (id === ids.actor) {
            return Promise.resolve({
              permissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
            });
          }
          if (input.craigInstalled === false) {
            return Promise.reject({ code: 10_007 });
          }
          return Promise.resolve({ id: ids.craig });
        },
      },
    };
    return {
      guilds: { fetch: () => Promise.resolve(guild) },
      user: { id: ids.platform },
    } as unknown as Client;
  }

  it("accepts least-privilege access for both official bots", async () => {
    await expect(new DiscordGuildSetupAdapter(client({}), ids.craig).verify(request))
      .resolves.toEqual({ ok: true });
  });

  it("rejects a missing Craig bot and insufficient publication access", async () => {
    await expect(
      new DiscordGuildSetupAdapter(client({ craigInstalled: false }), ids.craig)
        .verify(request),
    ).resolves.toMatchObject({
      failure: { code: "craig-not-installed" },
      ok: false,
    });
    await expect(
      new DiscordGuildSetupAdapter(client({ platformCanPublish: false }), ids.craig)
        .verify(request),
    ).resolves.toMatchObject({
      failure: { code: "platform-results-permission-missing" },
      ok: false,
    });
  });

  it("uses the core idempotency key as a Discord-enforced message nonce", async () => {
    const sent: Array<{
      readonly embeds: readonly { readonly data: { readonly title?: string } }[];
      readonly enforceNonce: boolean;
      readonly nonce: string;
    }> = [];
    const send = vi.fn(async (payload: (typeof sent)[number]) => {
      sent.push(payload);
      return {};
    });
    const setupClient = {
      guilds: {
        fetch: () => Promise.resolve({
          channels: {
            fetch: () => Promise.resolve({
              send,
              type: ChannelType.GuildText,
            }),
          },
        }),
      },
    } as unknown as Client;
    await expect(new DiscordGuildSetupAdapter(setupClient, ids.craig).publish({
      configuredByUserId: ids.actor,
      configurationRevision: 0,
      guildId: ids.guild,
      idempotencyKey: "guild-setup:v1|candidate-a",
      resultsChannelId: ids.results,
      voiceChannelId: ids.voice,
    })).resolves.toEqual({ ok: true });
    expect(send).toHaveBeenCalledOnce();
    expect(sent[0]?.enforceNonce).toBe(true);
    expect(sent[0]?.nonce).toMatch(/^[0-9a-f]{25}$/u);
    expect(sent[0]?.embeds[0]?.data.title).toBe("Проверка канала Meeting Assistant");
  });
});

describe("DiscordGuildSetupCommandHandler", () => {
  it("contains unexpected failures and gives the administrator a retry response", async () => {
    const client = new EventEmitter() as unknown as Client;
    const editReply = vi.fn(async () => ({}));
    const onError = vi.fn();
    const handler = new DiscordGuildSetupCommandHandler(client, {
      execute: () => Promise.reject(new Error("database unavailable")),
    }, "https://discord.com/oauth2/authorize?client_id=22222222222222222", onError);
    handler.start();
    (client as unknown as EventEmitter).emit("interactionCreate", {
      commandName: "setup",
      deferReply: vi.fn(async () => ({})),
      deferred: true,
      editReply,
      guildId: ids.guild,
      isChatInputCommand: () => true,
      memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
      options: {
        getChannel: (name: string) => ({
          id: name === "voice-channel" ? ids.voice : ids.results,
        }),
      },
      replied: false,
      user: { id: ids.actor },
    });
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledOnce();
      expect(editReply).toHaveBeenCalledWith({
        content: "Не удалось завершить настройку. Попробуйте /setup ещё раз.",
      });
    });
    handler.close();
  });
});
import { EventEmitter } from "node:events";
