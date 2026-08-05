import {
  ChannelType,
  Client,
  DiscordAPIError,
  type AnyThreadChannel,
  type Message,
  type NewsChannel,
  type TextChannel,
  type TextThreadChannel,
} from "discord.js";

import type {
  DiscordProjectionReference,
  LocatedDiscordProjection,
} from "./discord-projection.js";
import {
  DiscordProjectionConfigurationError,
  DiscordProjectionConflictError,
} from "./discordjs-projection-errors.js";
import {
  legacyProjectionFooter,
  projectionFooter,
} from "./discordjs-projection-message-payload.js";
import { createProjectionMarkerUrl } from "./projection-marker.js";

const unknownChannel = 10_003;
const unknownMessage = 10_008;
const maximumDirectMessageHistoryPages = 5;
const maximumRecentThreadRecoveryCandidates = 10;

export interface InspectDiscordProjectionInput {
  readonly exhaustive?: boolean;
  readonly includeThreads?: boolean;
  readonly parentChannelId: string;
  readonly marker: string;
  readonly referenceHint?: DiscordProjectionReference;
  readonly threadRecoveryName?: string;
}

export async function inspectDiscordProjection(
  client: Client,
  input: InspectDiscordProjectionInput,
): Promise<LocatedDiscordProjection | undefined> {
  const botUserId = requireDiscordProjectionBotUserId(client);
  const hinted = input.referenceHint === undefined
    ? undefined
    : await inspectDiscordProjectionHint(
      client,
      input.parentChannelId,
      input.marker,
      input.referenceHint,
      { botUserId, exhaustive: input.exhaustive === true },
    );
  if (hinted !== undefined) {
    return hinted;
  }

  const parent = await fetchDiscordProjectionParentChannel(client, input.parentChannelId);
  const [channelMessage, thread] = await Promise.all([
    findProjectionChannelMessage(parent, input.marker, botUserId, input.exhaustive === true),
    input.includeThreads === true
      ? findProjectionThread(
        parent,
        input.marker,
        input.threadRecoveryName,
        botUserId,
        input.exhaustive === true,
      )
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
    (await findProjectionMessage(
      thread,
      input.marker,
      botUserId,
      true,
      input.exhaustive === true
        ? Number.POSITIVE_INFINITY
        : maximumDirectMessageHistoryPages,
    ))?.id,
  );
}

export async function fetchDiscordProjectionParentChannel(
  client: Client,
  channelId: string,
): Promise<TextChannel | NewsChannel> {
  const channel = await client.channels.fetch(channelId);
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

export async function fetchDiscordProjectionThread(
  client: Client,
  threadId: string,
): Promise<TextThreadChannel> {
  const channel = await client.channels.fetch(threadId);
  if (channel?.isThread() !== true) {
    throw new Error("Discord projection thread does not exist");
  }
  return channel;
}

function requireDiscordProjectionBotUserId(client: Client): string {
  const botUserId = client.user?.id;
  if (botUserId === undefined) {
    throw new DiscordProjectionConfigurationError(
      "Discord projection client must be authenticated before reconciliation",
    );
  }
  return botUserId;
}

async function inspectDiscordProjectionHint(
  client: Client,
  parentChannelId: string,
  marker: string,
  hint: DiscordProjectionReference,
  recovery: { readonly botUserId: string; readonly exhaustive: boolean },
): Promise<LocatedDiscordProjection | undefined> {
  const { botUserId, exhaustive } = recovery;
  if (hint.kind === "channel-message") {
    if (hint.parentChannelId !== parentChannelId) {
      return undefined;
    }
    let parent: TextChannel | NewsChannel;
    try {
      parent = await fetchDiscordProjectionParentChannel(client, parentChannelId);
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
    const parentForScan = await fetchDiscordProjectionParentChannel(client, parentChannelId);
    const recovered = await findProjectionChannelMessage(
      parentForScan,
      marker,
      botUserId,
      exhaustive,
    );
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
    const channel = await client.channels.fetch(hint.threadId);
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
    (await findProjectionMessage(
      thread,
      marker,
      botUserId,
      true,
      exhaustive ? Number.POSITIVE_INFINITY : maximumDirectMessageHistoryPages,
    ))?.id,
  );
}

async function findProjectionThread(
  parent: TextChannel | NewsChannel,
  marker: string,
  threadRecoveryName: string | undefined,
  botUserId: string,
  exhaustive: boolean,
): Promise<TextThreadChannel | undefined> {
  const [active, archived] = await Promise.all([
    parent.threads.fetchActive(false),
    parent.threads.fetchArchived({
      fetchAll: exhaustive,
      type: "public",
      limit: 100,
    }, false),
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

  // Normal reconciliation inspects a small newest window. Recovery from an
  // existing durable reservation deliberately scans the complete retained
  // history before any replacement create is allowed.
  const orderedThreads = [...available.values()]
    .toSorted((left, right) =>
      (right.createdTimestamp ?? 0) - (left.createdTimestamp ?? 0)
    );
  const recentThreads = exhaustive
    ? orderedThreads
    : orderedThreads.slice(0, maximumRecentThreadRecoveryCandidates);
  const markerMatches = await Promise.all(recentThreads.map(async (thread) =>
    (await findProjectionMessage(
      thread,
      marker,
      botUserId,
      false,
      exhaustive ? Number.POSITIVE_INFINITY : 1,
    )) === undefined
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
  exhaustive: boolean,
): Promise<Message | undefined> {
  return findSingleProjectionMessage(
    parent.messages,
    marker,
    botUserId,
    false,
    exhaustive ? Number.POSITIVE_INFINITY : maximumDirectMessageHistoryPages,
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
    (allowLegacyFooter &&
      (embed.footer?.text === projectionFooter ||
        embed.footer?.text === legacyProjectionFooter))
  );
}

function isBotAuthored(message: Message, botUserId: string): boolean {
  return message.author.id === botUserId;
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
    (error.code === unknownChannel || error.code === unknownMessage);
}
