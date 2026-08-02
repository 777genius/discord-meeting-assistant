import {
  ChannelType,
  Client,
  DiscordAPIError,
  ThreadAutoArchiveDuration,
  type Message,
  type NewsChannel,
  type TextChannel,
  type TextThreadChannel,
  type AnyThreadChannel,
} from "discord.js";

import type {
  DiscordProjectionClient,
  DiscordProjectionReference,
  LocatedDiscordProjection,
} from "./discord-projection.js";

const UNKNOWN_CHANNEL = 10_003;
const UNKNOWN_MESSAGE = 10_008;
const PROJECTION_FOOTER = "Meeting Platform · итог встречи";

export class DiscordProjectionConflictError extends Error {
  constructor(entity: "thread" | "message", marker: string) {
    super(`Multiple Discord projection ${entity}s exist for marker ${marker}`);
    this.name = "DiscordProjectionConflictError";
  }
}

export class DiscordProjectionConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DiscordProjectionConfigurationError";
  }
}

export class DiscordJsProjectionClient implements DiscordProjectionClient {
  constructor(private readonly client: Client) {}

  async inspect(input: {
    readonly parentChannelId: string;
    readonly marker: string;
    readonly referenceHint?: DiscordProjectionReference;
  }): Promise<LocatedDiscordProjection | undefined> {
    const hinted = input.referenceHint === undefined
      ? undefined
      : await this.inspectHint(input.parentChannelId, input.marker, input.referenceHint);
    if (hinted !== undefined) {
      return hinted;
    }

    const parent = await this.fetchParentChannel(input.parentChannelId);
    const thread = await findProjectionThread(parent, input.marker);
    if (thread === undefined) {
      return undefined;
    }

    return locatedProjection(thread.id, (await findProjectionMessage(thread, input.marker))?.id);
  }

  async createThread(input: {
    readonly parentChannelId: string;
    readonly name: string;
    readonly marker: string;
  }): Promise<string> {
    assertThreadNameContainsMarker(input.name, input.marker);
    const parent = await this.fetchParentChannel(input.parentChannelId);
    const common = {
      name: input.name,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: "Create idempotent meeting summary projection",
    } as const;
    const thread = parent.type === ChannelType.GuildText
      ? await parent.threads.create({ ...common, type: ChannelType.PublicThread })
      : await parent.threads.create({ ...common, type: ChannelType.AnnouncementThread });
    return thread.id;
  }

  async renameThread(input: { readonly threadId: string; readonly name: string }): Promise<void> {
    const thread = await this.fetchThread(input.threadId);
    await thread.edit({
      name: input.name,
      archived: false,
      reason: "Reconcile meeting summary projection",
    });
  }

  async createMessage(input: {
    readonly threadId: string;
    readonly markdown: string;
    readonly marker: string;
  }): Promise<string> {
    const thread = await this.fetchThread(input.threadId);
    const message = await thread.send(messageBody(input.markdown));
    return message.id;
  }

  async editMessage(input: {
    readonly threadId: string;
    readonly messageId: string;
    readonly markdown: string;
    readonly marker: string;
  }): Promise<void> {
    const thread = await this.fetchThread(input.threadId);
    const message = await thread.messages.fetch(input.messageId);
    await message.edit(messageBody(input.markdown));
  }

  private async inspectHint(
    parentChannelId: string,
    marker: string,
    hint: DiscordProjectionReference,
  ): Promise<LocatedDiscordProjection | undefined> {
    let thread: TextThreadChannel | undefined;
    try {
      const channel = await this.client.channels.fetch(hint.threadId);
      thread = channel?.isThread() === true && channel.parentId === parentChannelId
        ? channel
        : undefined;
    } catch (error: unknown) {
      if (!isUnknownDiscordEntity(error)) {
        throw error;
      }
    }
    if (thread === undefined || !threadNameHasMarker(thread.name, marker)) {
      return undefined;
    }

    try {
      const message = await thread.messages.fetch(hint.messageId);
      if (hasProjectionMarker(message, marker)) {
        return { threadId: thread.id, messageId: message.id };
      }
    } catch (error: unknown) {
      if (!isUnknownDiscordEntity(error)) {
        throw error;
      }
    }

    return locatedProjection(thread.id, (await findProjectionMessage(thread, marker))?.id);
  }

  private async fetchParentChannel(channelId: string): Promise<TextChannel | NewsChannel> {
    const channel = await this.client.channels.fetch(channelId);
    if (
      channel === null ||
      (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)
    ) {
      throw new DiscordProjectionConfigurationError(
        "Discord projection parent must be a guild text or announcement channel",
      );
    }
    return channel;
  }

  private async fetchThread(threadId: string): Promise<TextThreadChannel> {
    const channel = await this.client.channels.fetch(threadId);
    if (channel?.isThread() !== true) {
      throw new Error("Discord projection thread does not exist");
    }
    return channel;
  }
}

async function findProjectionThread(
  parent: TextChannel | NewsChannel,
  marker: string,
): Promise<TextThreadChannel | undefined> {
  const [active, archived] = await Promise.all([
    parent.threads.fetchActive(false),
    parent.threads.fetchArchived({ type: "public", fetchAll: true }, false),
  ]);
  const candidates = new Map<string, TextThreadChannel>();
  for (const thread of [...active.threads.values(), ...archived.threads.values()]) {
    if (
      isTextThreadChannel(thread) &&
      thread.parentId === parent.id &&
      threadNameHasMarker(thread.name, marker)
    ) {
      candidates.set(thread.id, thread);
    }
  }
  if (candidates.size > 1) {
    throw new DiscordProjectionConflictError("thread", marker);
  }
  return candidates.values().next().value;
}

async function findProjectionMessage(
  thread: TextThreadChannel,
  marker: string,
): Promise<Message | undefined> {
  let before: string | undefined;
  const matches: Message[] = [];
  do {
    const page = await thread.messages.fetch({ limit: 100, ...(before === undefined ? {} : { before }) });
    for (const message of page.values()) {
      if (hasProjectionMarker(message, marker)) {
        matches.push(message);
      }
    }
    before = page.size === 100 ? page.last()?.id : undefined;
  } while (before !== undefined);

  if (matches.length > 1) {
    throw new DiscordProjectionConflictError("message", marker);
  }
  return matches[0];
}

function hasProjectionMarker(message: Message, marker: string): boolean {
  return message.embeds.some((embed) => {
    const footer = embed.footer?.text;
    return footer === marker || footer === PROJECTION_FOOTER;
  });
}

function messageBody(markdown: string) {
  return {
    allowedMentions: { parse: [] as const, repliedUser: false },
    embeds: [{ description: markdown, footer: { text: PROJECTION_FOOTER } }],
  };
}

function locatedProjection(
  threadId: string,
  messageId: string | undefined,
): LocatedDiscordProjection {
  return messageId === undefined ? { threadId } : { threadId, messageId };
}

function isTextThreadChannel(thread: AnyThreadChannel): thread is TextThreadChannel {
  return thread.parent?.type === ChannelType.GuildText ||
    thread.parent?.type === ChannelType.GuildAnnouncement;
}

function assertThreadNameContainsMarker(name: string, marker: string): void {
  if (!threadNameHasMarker(name, marker, false)) {
    throw new DiscordProjectionConfigurationError(
      "Discord projection thread name is missing its idempotency marker",
    );
  }
}

function threadNameHasMarker(
  name: string,
  marker: string,
  allowLegacy = true,
): boolean {
  return name.endsWith(`[код ${marker.slice(-20)}]`) ||
    (allowLegacy && name.endsWith(`[${marker.slice(-20)}]`));
}

function isUnknownDiscordEntity(error: unknown): boolean {
  return error instanceof DiscordAPIError &&
    (error.code === UNKNOWN_CHANNEL || error.code === UNKNOWN_MESSAGE);
}
