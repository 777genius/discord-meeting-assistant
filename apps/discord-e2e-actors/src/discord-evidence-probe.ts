import {
  ChannelType,
  Client,
  GatewayIntentBits,
  type AnyThreadChannel,
  type Message,
  type NewsChannel,
  type TextChannel,
  type TextThreadChannel,
} from "discord.js";

import type {
  DiscordEvidenceProbe,
  DiscordProjectionContainerObservation,
  DiscordProjectionMessageObservation,
  DiscordProjectionObservation,
} from "./e2e-collector.js";

const projectionFooter = "Meeting Platform · meeting summary";
const legacyProjectionFooter = "Meeting Platform · итог встречи";
const projectionMarkerUrlBase = "https://meeting-platform.invalid/projection/";

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
    const sutUserId = this.#client.user?.id;
    if (sutUserId === undefined) {
      throw new Error("Discord evidence probe is not authenticated as the SUT bot");
    }
    const [channelMessages, threads] = await Promise.all([
      findMatchingMessages(
        channel,
        marker,
        sutUserId,
        { kind: "channel-message", parentChannelId: channel.id },
        false,
      ),
      allTextThreads(channel),
    ]);
    const matchesByThread = await Promise.all(threads.map(async (thread) => ({
      thread,
      messages: await findMatchingMessages(
        thread,
        marker,
        sutUserId,
        { kind: "thread", parentChannelId: channel.id, threadId: thread.id },
        threadNameHasLegacyMarker(thread.name, marker),
      ),
    })));
    const threadMessages = matchesByThread.flatMap(({ messages }) => messages);
    return {
      matchingMessages: Object.freeze(
        [...channelMessages, ...threadMessages]
          .toSorted((left, right) => left.messageId.localeCompare(right.messageId)),
      ),
      matchingThreadIds: Object.freeze(
        matchesByThread
          .filter(({ messages }) => messages.length > 0)
          .map(({ thread }) => thread.id)
          .toSorted(),
      ),
    };
  }

  public async close(): Promise<void> {
    await this.#client.destroy();
  }
}

async function allTextThreads(
  parent: TextChannel | NewsChannel,
): Promise<readonly TextThreadChannel[]> {
  const [active, archived] = await Promise.all([
    parent.threads.fetchActive(false),
    parent.threads.fetchArchived({ fetchAll: true, type: "public" }, false),
  ]);
  const threads = new Map<string, TextThreadChannel>();
  for (const thread of [...active.threads.values(), ...archived.threads.values()]) {
    if (isTextThreadChannel(thread) && thread.parentId === parent.id) {
      threads.set(thread.id, thread);
    }
  }
  return [...threads.values()];
}

async function findMatchingMessages(
  channel: TextChannel | NewsChannel | TextThreadChannel,
  marker: string,
  sutUserId: string,
  container: DiscordProjectionContainerObservation,
  allowLegacyFooter: boolean,
): Promise<readonly DiscordProjectionMessageObservation[]> {
  const matches: DiscordProjectionMessageObservation[] = [];
  let before: string | undefined;
  do {
    const page = await channel.messages.fetch({
      limit: 100,
      ...(before === undefined ? {} : { before }),
    });
    let oldestMessageId: string | undefined;
    for (const message of page.values()) {
      oldestMessageId = message.id;
      const embedDescription = projectionDescription(message, marker, allowLegacyFooter);
      if (message.author.id === sutUserId && embedDescription !== undefined) {
        matches.push({
          attachments: [...message.attachments.values()]
            .map(({ name, size }) => ({ filename: name, sizeBytes: size }))
            .toSorted((left, right) => left.filename.localeCompare(right.filename)),
          container,
          embedDescription,
          messageId: message.id,
        });
      }
    }
    before = page.size === 100 ? oldestMessageId : undefined;
  } while (before !== undefined);
  return matches;
}

function projectionDescription(
  message: Message,
  marker: string,
  allowLegacyFooter: boolean,
): string | undefined {
  return message.embeds.find((embed) => footerHasMarker(
    embed.footer?.text,
    embed.url,
    marker,
    allowLegacyFooter,
  ))?.description ?? undefined;
}

export function threadNameHasLegacyMarker(name: string, marker: string): boolean {
  const shortMarker = marker.slice(-20);
  return name.endsWith(`[код ${shortMarker}]`) || name.endsWith(`[${shortMarker}]`);
}

export function footerHasMarker(
  footer: string | undefined,
  url: string | null | undefined,
  marker: string,
  allowLegacyFooter = false,
): boolean {
  return url === `${projectionMarkerUrlBase}${encodeURIComponent(marker)}` ||
    footer === marker ||
    (allowLegacyFooter &&
      (footer === projectionFooter || footer === legacyProjectionFooter));
}

function isTextThreadChannel(thread: AnyThreadChannel): thread is TextThreadChannel {
  return thread.parent?.type === ChannelType.GuildText ||
    thread.parent?.type === ChannelType.GuildAnnouncement;
}
