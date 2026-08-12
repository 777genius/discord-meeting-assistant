import {
  ChannelType,
  Client,
  GatewayIntentBits,
  type AnyThreadChannel,
  type Channel,
  type Message,
  type NewsChannel,
  type TextChannel,
  type TextThreadChannel,
} from "discord.js";

import type {
  LiveDiscordMessageInput,
  LiveDiscordProjectionMessages,
  LiveDiscordProjectionReader,
  LiveDiscordThreadInput,
} from "./live-discord-observer.js";

export class DiscordJsLiveDiscordProjectionReader implements LiveDiscordProjectionReader {
  readonly #client = new Client({ intents: [GatewayIntentBits.Guilds] });

  public async connect(token: string): Promise<void> {
    await this.#client.login(token);
  }

  public authenticatedUserId(): string {
    const userId = this.#client.user?.id;
    if (userId === undefined) {
      throw new Error("Discord live observer did not receive an authenticated bot user");
    }
    return userId;
  }

  public async poll(input: {
    readonly createdSinceMilliseconds: number;
    readonly resultChannelId: string;
  }): Promise<readonly LiveDiscordProjectionMessages[]> {
    const parent = await this.#client.channels.fetch(input.resultChannelId);
    if (!isResultsTextChannel(parent)) {
      throw new Error("Discord live observer results channel must be a guild text or announcement channel");
    }
    const threads = await publicThreadsFor(parent, input.createdSinceMilliseconds);
    const threadProjections = await Promise.all(threads.map(async (thread) => ({
      messages: await recentMessagesSince(thread, input.createdSinceMilliseconds),
      container: { kind: "thread" as const, ...toThreadInput(thread) },
    })));
    return [{
      messages: await recentMessagesSince(parent, input.createdSinceMilliseconds),
      container: { kind: "channel-message", parentChannelId: parent.id },
    }, ...threadProjections];
  }

  public async close(): Promise<void> {
    await this.#client.destroy();
  }
}

function isResultsTextChannel(channel: Channel | null): channel is TextChannel | NewsChannel {
  return channel?.type === ChannelType.GuildText || channel?.type === ChannelType.GuildAnnouncement;
}

async function publicThreadsFor(
  parent: TextChannel | NewsChannel,
  createdSinceMilliseconds: number,
): Promise<readonly TextThreadChannel[]> {
  const [active, archived] = await Promise.all([
    parent.threads.fetchActive(false),
    parent.threads.fetchArchived({ fetchAll: true, type: "public" }, false),
  ]);
  const threads = new Map<string, TextThreadChannel>();
  for (const thread of [...active.threads.values(), ...archived.threads.values()]) {
    if (isPublicTextThread(thread) && thread.parentId === parent.id) {
      threads.set(thread.id, thread);
    }
  }
  return [...threads.values()]
    .filter((thread) =>
      thread.createdTimestamp !== null && thread.createdTimestamp >= createdSinceMilliseconds
    )
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

function isPublicTextThread(thread: AnyThreadChannel): thread is TextThreadChannel {
  return thread.parent?.type === ChannelType.GuildText ||
    thread.parent?.type === ChannelType.GuildAnnouncement;
}

async function recentMessagesSince(
  channel: TextChannel | NewsChannel | TextThreadChannel,
  createdSinceMilliseconds: number,
): Promise<readonly LiveDiscordMessageInput[]> {
  const messages = new Map<string, LiveDiscordMessageInput>();
  let before: string | undefined;
  do {
    const page = await channel.messages.fetch({
      limit: 100,
      ...(before === undefined ? {} : { before }),
    });
    let oldestMessageId: string | undefined;
    for (const message of page.values()) {
      messages.set(message.id, toMessageInput(message));
      oldestMessageId = message.id;
    }
    const timestamps = [...page.values()].map(({ createdTimestamp }) => createdTimestamp);
    const oldestTimestamp = timestamps.length === 0 ? 0 : Math.min(...timestamps);
    before = page.size === 100 && oldestTimestamp >= createdSinceMilliseconds
      ? oldestMessageId
      : undefined;
  } while (before !== undefined);
  return [...messages.values()];
}

function toThreadInput(thread: TextThreadChannel): LiveDiscordThreadInput {
  if (thread.parentId === null) {
    throw new Error("Discord live observer found a thread without its parent channel");
  }
  return { id: thread.id, name: thread.name, parentId: thread.parentId };
}

function toMessageInput(message: Message): LiveDiscordMessageInput {
  return {
    authorId: message.author.id,
    content: message.content,
    createdAtMilliseconds: message.createdTimestamp,
    editedAtMilliseconds: message.editedTimestamp,
    embeds: message.embeds.map((embed) => ({
      description: embed.description,
      fields: embed.fields.map((field) => ({
        inline: field.inline,
        name: field.name,
        value: field.value,
      })),
      footerText: embed.footer?.text,
      title: embed.title,
      url: embed.url,
    })),
    id: message.id,
  };
}
