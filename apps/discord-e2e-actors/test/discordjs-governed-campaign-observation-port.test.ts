import {
  ChannelType,
  Collection,
  PermissionsBitField,
  type Client,
} from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { createDiscordJsGovernedCampaignObservationPort } from
  "../src/discordjs-governed-campaign-observation-port.js";

const guildId = "1533228590643155034";
const parentId = "1533228891827736657";
const activePrivateId = "1533228891827736659";
const publicArchivedId = "1533228891827736660";
const privateArchivedId = "1533228891827736661";

describe("Discord.js governed campaign observation port", () => {
  it("recognizes active private threads and uses fetch-all private archive semantics", async () => {
    const archivedFetch = vi.fn(async (options: { readonly type?: string }) => ({
      hasMore: false,
      members: new Collection(),
      threads: new Collection([[options.type === "private" ? privateArchivedId : publicArchivedId,
        thread(options.type === "private" ? privateArchivedId : publicArchivedId,
          options.type === "private" ? ChannelType.PrivateThread : ChannelType.PublicThread,
          "2026-08-24T00:08:00.000Z")]]),
    }));
    const client = fakeClient({ archivedFetch, manageThreads: true,
      activeThreads: [thread(activePrivateId, ChannelType.PrivateThread, null)] });
    const port = createDiscordJsGovernedCampaignObservationPort(client);

    const active = await port.fetchActiveThreads(guildId);
    const publicPage = await port.fetchArchivedThreads({ before: undefined, limit: 100,
      parentChannelId: parentId, visibility: "public" });
    const privatePage = await port.fetchArchivedThreads({ before: undefined, limit: 100,
      parentChannelId: parentId, visibility: "private" });

    expect(active).toEqual({ complete: true, threads: [expect.objectContaining({
      channelId: activePrivateId, kind: "active-thread", threadVisibility: "private",
    })] });
    expect(publicPage.threads[0]).toEqual(expect.objectContaining({
      channelId: publicArchivedId, threadVisibility: "public",
    }));
    expect(privatePage).toEqual(expect.objectContaining({ completeness: "all",
      visibility: "private" }));
    expect(archivedFetch).toHaveBeenNthCalledWith(1,
      { limit: 100, type: "public" }, false);
    expect(archivedFetch).toHaveBeenNthCalledWith(2,
      { fetchAll: true, limit: 100, type: "private" }, false);
  });

  it("fails closed without ManageThreads before private enumeration can downgrade", async () => {
    const archivedFetch = vi.fn();
    const port = createDiscordJsGovernedCampaignObservationPort(fakeClient({ archivedFetch,
      manageThreads: false }));

    await expect(port.fetchArchivedThreads({ before: undefined, limit: 100,
      parentChannelId: parentId, visibility: "private" }))
      .rejects.toThrow("lacks ManageThreads for complete private archives");
    expect(archivedFetch).not.toHaveBeenCalled();
  });

  it("rejects an archive response that does not attest pagination completeness", async () => {
    const archivedFetch = vi.fn(async () => ({ members: new Collection(),
      threads: new Collection() }));
    const port = createDiscordJsGovernedCampaignObservationPort(fakeClient({ archivedFetch }));

    await expect(port.fetchArchivedThreads({ before: undefined, limit: 100,
      parentChannelId: parentId, visibility: "private" }))
      .rejects.toThrow("private archived-thread response is incomplete");
    expect(archivedFetch).toHaveBeenCalledWith({ fetchAll: true, limit: 100, type: "private" },
      false);
  });

  it("fails with sanitized explicit reasons for unsupported and unavailable surfaces", async () => {
    const unsupported = createDiscordJsGovernedCampaignObservationPort(fakeClient({
      channelType: ChannelType.GuildVoice,
    }));
    await expect(unsupported.fetchParent(parentId))
      .rejects.toThrow("unavailable or has the wrong kind");

    const unavailable = createDiscordJsGovernedCampaignObservationPort({
      channels: { fetch: vi.fn().mockRejectedValue(new Error("token=secret provider detail")) },
    } as unknown as Client);
    await expect(unavailable.fetchParent(parentId))
      .rejects.toThrow("Governed historical surface could not be read completely");
    await expect(unavailable.fetchParent(parentId)).rejects.not.toThrow(/secret/u);
  });
});

function fakeClient(options: {
  readonly activeThreads?: readonly ReturnType<typeof thread>[];
  readonly archivedFetch?: ReturnType<typeof vi.fn>;
  readonly channelType?: ChannelType;
  readonly manageThreads?: boolean;
}): Client {
  const self = {};
  const permissions = new PermissionsBitField([
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.ReadMessageHistory,
    ...(options.manageThreads === false ? [] : [PermissionsBitField.Flags.ManageThreads]),
  ]);
  const guild = {
    channels: {
      fetchActiveThreads: vi.fn(async () => ({ members: new Collection(),
        threads: new Collection((options.activeThreads ?? []).map((item) => [item.id, item])) })),
    },
    id: guildId,
    members: { me: self },
  };
  const parent = {
    guild,
    id: parentId,
    isThread: () => false,
    messages: { fetch: vi.fn(async () => new Collection()) },
    permissionsFor: () => permissions,
    threads: { fetchArchived: options.archivedFetch ?? vi.fn(async () => ({ hasMore: false,
      members: new Collection(), threads: new Collection() })) },
    type: options.channelType ?? ChannelType.GuildText,
  };
  return {
    channels: { fetch: vi.fn(async () => parent) },
    guilds: { fetch: vi.fn(async () => guild) },
  } as unknown as Client;
}

function thread(id: string, type: ChannelType, archivedAt: string | null) {
  const permissions = new PermissionsBitField([
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.ReadMessageHistory,
  ]);
  return {
    archiveTimestamp: archivedAt === null ? null : Date.parse(archivedAt),
    guild: { id: guildId, members: { me: {} } },
    id,
    parentId,
    permissionsFor: () => permissions,
    type,
  };
}
