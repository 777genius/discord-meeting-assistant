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
  DiscordProjectionMessageObservation,
  DiscordProjectionObservation,
} from "./e2e-collector.js";

const projectionFooter = "Meeting Platform · итог встречи";

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
    const matchingMessages: DiscordProjectionMessageObservation[] = [];
    for (const thread of threads) {
      matchingMessages.push(...await findMatchingMessages(thread, marker));
    }
    return {
      matchingMessages: Object.freeze(
        matchingMessages.toSorted((left, right) => left.messageId.localeCompare(right.messageId)),
      ),
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
  const [active, archived] = await Promise.all([
    parent.threads.fetchActive(false),
    parent.threads.fetchArchived({ fetchAll: true, type: "public" }, false),
  ]);
  const matches = new Map<string, TextThreadChannel>();
  for (const thread of [...active.threads.values(), ...archived.threads.values()]) {
    if (
      isTextThreadChannel(thread) &&
      thread.parentId === parent.id &&
      threadNameHasMarker(thread.name, marker)
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

async function findMatchingMessages(
  thread: TextThreadChannel,
  marker: string,
): Promise<readonly DiscordProjectionMessageObservation[]> {
  const matches: DiscordProjectionMessageObservation[] = [];
  let before: string | undefined;
  do {
    const page = await thread.messages.fetch({
      limit: 100,
      ...(before === undefined ? {} : { before }),
    });
    for (const message of page.values()) {
      const embedDescription = projectionDescription(message, marker);
      if (embedDescription !== undefined) {
        matches.push({ embedDescription, messageId: message.id });
      }
    }
    before = page.size === 100 ? page.last()?.id : undefined;
  } while (before !== undefined);
  return matches;
}

function projectionDescription(message: Message, marker: string): string | undefined {
  return message.embeds.find((embed) => footerHasMarker(embed.footer?.text, marker))
    ?.description ?? undefined;
}

export function threadNameHasMarker(name: string, marker: string): boolean {
  const shortMarker = marker.slice(-20);
  return name.endsWith(`[код ${shortMarker}]`) || name.endsWith(`[${shortMarker}]`);
}

export function footerHasMarker(footer: string | undefined, marker: string): boolean {
  return footer === projectionFooter || footer === marker;
}
