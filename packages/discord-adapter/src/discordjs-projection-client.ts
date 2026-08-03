import {
  ChannelType,
  Client,
  DiscordAPIError,
  ThreadAutoArchiveDuration,
  type AnyThreadChannel,
  type Message,
  type NewsChannel,
  type TextChannel,
  type TextThreadChannel,
} from "discord.js";

import type {
  DiscordProjectionBody,
  DiscordProjectionClient,
  DiscordProjectionReference,
  LocatedDiscordProjection,
} from "./discord-projection.js";
import { discordProjectionBodySchema } from "./discord-projection.js";
import { createProjectionMarkerUrl } from "./projection-marker.js";

const UNKNOWN_CHANNEL = 10_003;
const UNKNOWN_MESSAGE = 10_008;
const PROJECTION_FOOTER = "Meeting Platform · итог встречи";
const maximumDirectMessageHistoryPages = 5;
const maximumRecentThreadRecoveryCandidates = 10;

export class DiscordProjectionConflictError extends Error {
  constructor(entity: "projection" | "thread" | "message", marker: string) {
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
    readonly includeThreads?: boolean;
    readonly parentChannelId: string;
    readonly marker: string;
    readonly referenceHint?: DiscordProjectionReference;
    readonly threadRecoveryName?: string;
  }): Promise<LocatedDiscordProjection | undefined> {
    const botUserId = this.requireBotUserId();
    const hinted = input.referenceHint === undefined
      ? undefined
      : await this.inspectHint(input.parentChannelId, input.marker, input.referenceHint, botUserId);
    if (hinted !== undefined) {
      return hinted;
    }

    const parent = await this.fetchParentChannel(input.parentChannelId);
    const [channelMessage, thread] = await Promise.all([
      findProjectionChannelMessage(parent, input.marker, botUserId),
      input.includeThreads === true
        ? findProjectionThread(parent, input.marker, input.threadRecoveryName, botUserId)
          .then((candidate) => candidate ?? null)
        : Promise.resolve(null),
    ]);
    if (channelMessage !== undefined && thread !== null) {
      throw new DiscordProjectionConflictError("projection", input.marker);
    }
    if (channelMessage !== undefined) {
      return {
        kind: "channel-message",
        parentChannelId: parent.id,
        messageId: channelMessage.id,
      };
    }
    if (thread === null) {
      return undefined;
    }

    return locatedThreadProjection(
      thread.id,
      (await findProjectionMessage(thread, input.marker, botUserId, true))?.id,
    );
  }

  async createThread(input: {
    readonly parentChannelId: string;
    readonly name: string;
    readonly marker: string;
  }): Promise<string> {
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

  async reopenThread(input: { readonly threadId: string }): Promise<void> {
    const thread = await this.fetchThread(input.threadId);
    await thread.edit({
      archived: false,
      reason: "Reconcile meeting summary projection",
    });
  }

  async renameThread(input: { readonly threadId: string; readonly name: string }): Promise<void> {
    const thread = await this.fetchThread(input.threadId);
    await thread.edit({
      name: input.name,
      archived: false,
      reason: "Finalize meeting summary projection thread title",
    });
  }

  async createMessage(input: {
    readonly container:
      | { readonly kind: "thread"; readonly threadId: string }
      | { readonly kind: "channel-message"; readonly parentChannelId: string };
    readonly body: DiscordProjectionBody;
    readonly marker: string;
  }): Promise<string> {
    const destination = input.container.kind === "thread"
      ? await this.fetchThread(input.container.threadId)
      : await this.fetchParentChannel(input.container.parentChannelId);
    const message = await destination.send(toDiscordMessagePayload(input.body, input.marker));
    return message.id;
  }

  async editMessage(input: {
    readonly reference: DiscordProjectionReference;
    readonly body: DiscordProjectionBody;
    readonly marker: string;
  }): Promise<void> {
    const destination = input.reference.kind === "thread"
      ? await this.fetchThread(input.reference.threadId)
      : await this.fetchParentChannel(input.reference.parentChannelId);
    const message = await destination.messages.fetch(input.reference.messageId);
    await message.edit(toDiscordMessagePayload(input.body, input.marker));
  }

  private async inspectHint(
    parentChannelId: string,
    marker: string,
    hint: DiscordProjectionReference,
    botUserId: string,
  ): Promise<LocatedDiscordProjection | undefined> {
    if (hint.kind === "channel-message") {
      if (hint.parentChannelId !== parentChannelId) {
        return undefined;
      }
      let parent: TextChannel | NewsChannel;
      try {
        parent = await this.fetchParentChannel(parentChannelId);
        const message = await parent.messages.fetch(hint.messageId);
        if (isBotAuthored(message, botUserId)) {
          // A durable receipt stays authoritative if a moderator has changed
          // the non-visible marker metadata. That preserves one projection.
          return {
            kind: "channel-message",
            parentChannelId: parent.id,
            messageId: message.id,
          };
        }
      } catch (error: unknown) {
        if (!isUnknownDiscordEntity(error)) {
          throw error;
        }
      }
      const parentForScan = await this.fetchParentChannel(parentChannelId);
      const recovered = await findProjectionChannelMessage(parentForScan, marker, botUserId);
      return recovered === undefined
        ? undefined
        : {
          kind: "channel-message",
          parentChannelId: parentForScan.id,
          messageId: recovered.id,
        };
    }

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
    if (thread === undefined) {
      return undefined;
    }

    try {
      const message = await thread.messages.fetch(hint.messageId);
      if (isBotAuthored(message, botUserId)) {
        // The persisted Discord reference is the durable identity. A moderator
        // may rename the human-facing thread or alter metadata, but that must
        // not make recovery create a duplicate projection.
        return { kind: "thread", threadId: thread.id, messageId: message.id };
      }
    } catch (error: unknown) {
      if (!isUnknownDiscordEntity(error)) {
        throw error;
      }
    }

    return locatedThreadProjection(
      thread.id,
      (await findProjectionMessage(thread, marker, botUserId, true))?.id,
    );
  }

  private requireBotUserId(): string {
    const botUserId = this.client.user?.id;
    if (botUserId === undefined) {
      throw new DiscordProjectionConfigurationError(
        "Discord projection client must be authenticated before reconciliation",
      );
    }
    return botUserId;
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
  threadRecoveryName: string | undefined,
  botUserId: string,
): Promise<TextThreadChannel | undefined> {
  const [active, archived] = await Promise.all([
    parent.threads.fetchActive(false),
    parent.threads.fetchArchived({ type: "public", limit: 100 }, false),
  ]);
  const available = new Map<string, TextThreadChannel>();
  for (const thread of [...active.threads.values(), ...archived.threads.values()]) {
    if (!isTextThreadChannel(thread) || thread.parentId !== parent.id) {
      continue;
    }
    available.set(thread.id, thread);
  }
  const namedCandidates = [...available.values()].filter((thread) =>
    thread.name === threadRecoveryName || threadNameHasLegacyMarker(thread.name, marker)
  );
  if (namedCandidates.length > 1) {
    throw new DiscordProjectionConflictError("thread", marker);
  }
  if (namedCandidates[0] !== undefined) {
    return namedCandidates[0];
  }

  // A crash after the marker message and human rename but before durable
  // receipt persistence has no visible-name marker. It can only concern a
  // newly-created thread, so inspect a small newest window and one message
  // page per thread instead of walking the server's complete history.
  const recentThreads = [...available.values()]
    .toSorted((left, right) =>
      (right.createdTimestamp ?? 0) - (left.createdTimestamp ?? 0)
    )
    .slice(0, maximumRecentThreadRecoveryCandidates);
  const markerMatches = await Promise.all(recentThreads.map(async (thread) =>
    (await findProjectionMessage(thread, marker, botUserId, false, 1)) === undefined
      ? undefined
      : thread
  ));
  const candidates = markerMatches.filter((thread) => thread !== undefined);
  if (candidates.length > 1) {
    throw new DiscordProjectionConflictError("thread", marker);
  }
  return candidates[0];
}

async function findProjectionChannelMessage(
  parent: TextChannel | NewsChannel,
  marker: string,
  botUserId: string,
): Promise<Message | undefined> {
  return findSingleProjectionMessage(
    parent.messages,
    marker,
    botUserId,
    false,
    maximumDirectMessageHistoryPages,
  );
}

async function findProjectionMessage(
  thread: TextThreadChannel,
  marker: string,
  botUserId: string,
  allowLegacyFooter: boolean,
  maximumPages = maximumDirectMessageHistoryPages,
): Promise<Message | undefined> {
  return findSingleProjectionMessage(
    thread.messages,
    marker,
    botUserId,
    allowLegacyFooter,
    maximumPages,
  );
}

async function findSingleProjectionMessage(
  messages: {
    fetch(input: { readonly before?: string; readonly limit: number }): Promise<
      ReadonlyMap<string, Message>
    >;
  },
  marker: string,
  botUserId: string,
  allowLegacyFooter: boolean,
  maximumPages: number,
): Promise<Message | undefined> {
  let before: string | undefined;
  let fetchedPages = 0;
  const matches: Message[] = [];
  do {
    fetchedPages += 1;
    const page = await messages.fetch({
      limit: 100,
      ...(before === undefined ? {} : { before }),
    });
    let oldestMessageId: string | undefined;
    for (const message of page.values()) {
      // discord.js collections are ordered newest-to-oldest for message
      // history. Advancing with the final (oldest) ID avoids rescanning the
      // first page forever when it is full.
      oldestMessageId = message.id;
      if (isBotAuthored(message, botUserId) && hasProjectionMarker(message, marker, allowLegacyFooter)) {
        matches.push(message);
      }
    }
    before = page.size === 100 && fetchedPages < maximumPages ? oldestMessageId : undefined;
  } while (before !== undefined);

  if (matches.length > 1) {
    throw new DiscordProjectionConflictError("message", marker);
  }
  return matches[0];
}

function hasProjectionMarker(
  message: Message,
  marker: string,
  allowLegacyFooter: boolean,
): boolean {
  return message.embeds.some((embed) =>
    embed.url === createProjectionMarkerUrl(marker) ||
    embed.footer?.text === marker ||
    (allowLegacyFooter && embed.footer?.text === PROJECTION_FOOTER)
  );
}

function isBotAuthored(message: Message, botUserId: string): boolean {
  return message.author.id === botUserId;
}

export function toDiscordMessagePayload(rawBody: DiscordProjectionBody, marker?: string) {
  const body = discordProjectionBodySchema.parse(rawBody);
  return {
    allowedMentions: { parse: [] as const, repliedUser: false },
    embeds: [
      {
        description: body.markdown,
        footer: { text: PROJECTION_FOOTER },
        ...(marker === undefined ? {} : { url: createProjectionMarkerUrl(marker) }),
      },
      ...(body.liveCaptionsMarkdown === undefined
        ? []
        : [{ description: body.liveCaptionsMarkdown }]),
    ],
  };
}

function locatedThreadProjection(
  threadId: string,
  messageId: string | undefined,
): LocatedDiscordProjection {
  return messageId === undefined
    ? { kind: "thread", threadId }
    : { kind: "thread", threadId, messageId };
}

function isTextThreadChannel(thread: AnyThreadChannel): thread is TextThreadChannel {
  return thread.parent?.type === ChannelType.GuildText ||
    thread.parent?.type === ChannelType.GuildAnnouncement;
}

function threadNameHasLegacyMarker(name: string, marker: string): boolean {
  return name.endsWith(`[код ${marker.slice(-20)}]`) ||
    name.endsWith(`[${marker.slice(-20)}]`);
}

function isUnknownDiscordEntity(error: unknown): boolean {
  return error instanceof DiscordAPIError &&
    (error.code === UNKNOWN_CHANNEL || error.code === UNKNOWN_MESSAGE);
}
