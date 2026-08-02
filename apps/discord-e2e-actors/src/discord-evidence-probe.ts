import {
  ChannelType,
  Client,
  GatewayIntentBits,
  type Message,
  type NewsChannel,
  type TextChannel,
  type TextThreadChannel,
  type AnyThreadChannel,
} from "discord.js";

import type {
  DiscordEvidenceProbe,
  DiscordProjectionObservation,
} from "./e2e-collector.js";

export class DiscordJsEvidenceProbe implements DiscordEvidenceProbe {
  readonly #client = new Client({ intents: [GatewayIntentBits.Guilds] });

  public async connect(token: string): Promise<void> {
    await this.#client.login(token);
  }

  public async inspect(
    parentChannelId: string,
    marker: string,
  ): Promise<DiscordProjectionObservation> {
    const channel = await this.#client.channels.fetch(parentChannelId);
    if (
      channel === null ||
      (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)
    ) {
      throw new Error("Discord evidence parent must be a text or announcement channel");
    }
    const threads = await matchingThreads(channel, marker);
    const matchingMessageIds: string[] = [];
    for (const thread of threads) {
      matchingMessageIds.push(...await matchingMessages(thread, marker));
    }
    return {
      matchingMessageIds: Object.freeze(matchingMessageIds.toSorted()),
      matchingThreadIds: Object.freeze(threads.map(({ id }) => id).toSorted()),
    };
  }

  public async close(): Promise<void> {
    await this.#client.destroy();
  }
}

async function matchingThreads(
  parent: TextChannel | NewsChannel,
  marker: string,
): Promise<readonly TextThreadChannel[]> {
  const suffix = `[${marker.slice(-20)}]`;
  const [active, archived] = await Promise.all([
    parent.threads.fetchActive(false),
    parent.threads.fetchArchived({ fetchAll: true, type: "public" }, false),
  ]);
  const matches = new Map<string, TextThreadChannel>();
  for (const thread of [...active.threads.values(), ...archived.threads.values()]) {
    if (
      isTextThreadChannel(thread) &&
      thread.parentId === parent.id &&
      thread.name.endsWith(suffix)
    ) {
      matches.set(thread.id, thread);
    }
  }
  return [...matches.values()];
}

function isTextThreadChannel(thread: AnyThreadChannel): thread is TextThreadChannel {
  return thread.parent?.type === ChannelType.GuildText ||
    thread.parent?.type === ChannelType.GuildAnnouncement;
}

async function matchingMessages(
  thread: TextThreadChannel,
  marker: string,
): Promise<readonly string[]> {
  const matches: string[] = [];
  let before: string | undefined;
  do {
    const page = await thread.messages.fetch({
      limit: 100,
      ...(before === undefined ? {} : { before }),
    });
    for (const message of page.values()) {
      if (hasMarker(message, marker)) {
        matches.push(message.id);
      }
    }
    before = page.size === 100 ? page.last()?.id : undefined;
  } while (before !== undefined);
  return matches;
}

function hasMarker(message: Message, marker: string): boolean {
  return message.embeds.some((embed) => embed.footer?.text === marker);
}
