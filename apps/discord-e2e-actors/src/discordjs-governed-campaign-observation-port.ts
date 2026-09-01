import {
  ChannelType,
  PermissionsBitField,
  type BaseGuildTextChannel,
  type Client,
  type GuildTextBasedChannel,
  type ThreadChannel,
} from "discord.js";

import type {
  GovernedCampaignObservationPort,
  GovernedCampaignSurface,
  GovernedThreadVisibility,
} from "./governed-private-campaign-observation.js";

type ObservableChannel = GuildTextBasedChannel | ThreadChannel;

function assertObservationPermissions(channel: ObservableChannel): void {
  const self = channel.guild.members.me;
  const observed = self === null ? null : channel.permissionsFor(self);
  if (observed === null || !observed.has(PermissionsBitField.Flags.ViewChannel) ||
    !observed.has(PermissionsBitField.Flags.ReadMessageHistory)) {
    throw new Error("Historical observer lacks governed-surface read permissions");
  }
}

function assertPrivateArchivePermissions(channel: BaseGuildTextChannel): void {
  const self = channel.guild.members.me;
  const observed = self === null ? null : channel.permissionsFor(self);
  if (observed === null || !observed.has(PermissionsBitField.Flags.ManageThreads)) {
    throw new Error("Historical observer lacks ManageThreads for complete private archives");
  }
}

async function sanitizedDiscordRead<T>(reason: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch {
    throw new Error(reason);
  }
}

function threadVisibility(thread: ThreadChannel): GovernedThreadVisibility {
  if (thread.type === ChannelType.PrivateThread) {
    return "private";
  }
  return "public";
}

export function createDiscordJsGovernedCampaignObservationPort(
  client: Client,
): GovernedCampaignObservationPort {
  const channel = async (channelId: string): Promise<GuildTextBasedChannel> => {
    const observed = await sanitizedDiscordRead(
      "Governed historical surface could not be read completely",
      () => client.channels.fetch(channelId),
    );
    if (observed?.type !== ChannelType.GuildText &&
      observed?.type !== ChannelType.GuildAnnouncement &&
      observed?.type !== ChannelType.PublicThread &&
      observed?.type !== ChannelType.AnnouncementThread &&
      observed?.type !== ChannelType.PrivateThread) {
      throw new Error("Governed historical surface is unavailable or has the wrong kind");
    }
    assertObservationPermissions(observed);
    return observed;
  };
  const parent = async (parentChannelId: string): Promise<BaseGuildTextChannel> => {
    const observed = await channel(parentChannelId);
    if (observed.isThread()) {
      throw new Error("Compiled historical private scope must name parent channels explicitly");
    }
    return observed as BaseGuildTextChannel;
  };
  const threadSurface = (
    thread: ThreadChannel,
    kind: "active-thread" | "archived-thread",
    expectedVisibility?: GovernedThreadVisibility,
  ): GovernedCampaignSurface => {
    if (thread.parentId === null) {
      throw new Error("Governed historical thread has no parent");
    }
    assertObservationPermissions(thread);
    const visibility = threadVisibility(thread);
    if (expectedVisibility !== undefined && visibility !== expectedVisibility) {
      throw new Error("Governed archived-thread response mixed visibility classes");
    }
    return {
      archivedAt: thread.archiveTimestamp === null ? null :
        new Date(thread.archiveTimestamp).toISOString(),
      channelId: thread.id,
      guildId: thread.guild.id,
      kind,
      parentChannelId: thread.parentId,
      threadVisibility: visibility,
    };
  };
  return {
    fetchActiveThreads: async (guildId) => {
      const guild = await sanitizedDiscordRead(
        "Governed active-thread guild could not be read completely",
        () => client.guilds.fetch(guildId),
      );
      const active = await sanitizedDiscordRead(
        "Governed active-thread enumeration is unavailable or incomplete",
        () => guild.channels.fetchActiveThreads(false),
      );
      return { complete: true, threads: [...active.threads.values()].map((thread) =>
        threadSurface(thread, "active-thread")) };
    },
    fetchArchivedThreads: async ({ before, limit, parentChannelId, visibility }) => {
      const observed = await parent(parentChannelId);
      if (visibility === "private") {
        assertPrivateArchivePermissions(observed);
      }
      const page = await sanitizedDiscordRead(
        `Governed ${visibility} archived-thread enumeration is unavailable or incomplete`,
        () => observed.threads.fetchArchived({
          ...(before === undefined ? {} : { before: new Date(before) }),
          ...(visibility === "private" ? { fetchAll: true as const } : {}),
          limit,
          type: visibility,
        }, false),
      );
      if (typeof page.hasMore !== "boolean") {
        throw new Error(`Governed ${visibility} archived-thread response is incomplete`);
      }
      const threads = [...page.threads.values()].map((thread) =>
        threadSurface(thread, "archived-thread", visibility));
      const nextBefore = threads.map(({ archivedAt }) => archivedAt).filter(
        (value): value is string => value !== null,
      ).toSorted().at(0);
      return { completeness: "all", hasMore: page.hasMore, nextBefore, threads,
        visibility };
    },
    fetchMessages: async ({ beforeMessageId, channelId, limit }) => {
      const observed = await channel(channelId);
      const messages = await sanitizedDiscordRead(
        "Governed historical messages could not be read completely",
        () => observed.messages.fetch({ before: beforeMessageId, limit }),
      );
      return [...messages.values()].map((message) => ({
        authorApplicationId: message.author.id,
        channelId: message.channelId,
        createdAt: message.createdAt.toISOString(),
        messageId: message.id,
        replyToMessageId: message.reference?.messageId ?? null,
      }));
    },
    fetchParent: async (parentChannelId) => {
      const observed = await parent(parentChannelId);
      return { archivedAt: null, channelId: observed.id, guildId: observed.guild.id,
        kind: "parent", parentChannelId, threadVisibility: null };
    },
  };
}
