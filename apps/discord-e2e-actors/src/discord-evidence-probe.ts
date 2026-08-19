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
const recordingPlaybackPath = "/recordings/playback";
const recordingLinkLabels = new Set([
  "Listen to the recording",
  "Прослушать запись",
  "Прослухати запис",
]);
const markdownLinkPattern = /\[([^\]\r\n]+)\]\(([^)\r\n]*)\)/gu;

export interface ExtractedRecordingPlaybackLink {
  readonly embedDescription: string;
  readonly recordingPlaybackUrl: string;
}

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
      const projection = projectionDescription(message, marker, allowLegacyFooter);
      if (message.author.id === sutUserId && projection !== undefined) {
        matches.push({
          attachments: [...message.attachments.values()]
            .map(({ name, size }) => ({ filename: name, sizeBytes: size }))
            .toSorted((left, right) => left.filename.localeCompare(right.filename)),
          container,
          embedDescription: projection.embedDescription,
          messageId: message.id,
          recordingPlaybackUrl: projection.recordingPlaybackUrl,
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
): ExtractedRecordingPlaybackLink | undefined {
  const description = message.embeds.find((embed) => footerHasMarker(
    embed.footer?.text,
    embed.url,
    marker,
    allowLegacyFooter,
  ))?.description;
  return description === null || description === undefined
    ? undefined
    : extractOptionalRecordingPlaybackLink(description);
}

export function extractOptionalRecordingPlaybackLink(
  description: string,
): ExtractedRecordingPlaybackLink | undefined {
  const links = [...description.matchAll(markdownLinkPattern)];
  const hasRecordingLabel = links.some((match) => recordingLinkLabels.has(match[1] ?? ""));
  const hasPlaybackTarget = links.some((match) => match[2]?.includes(recordingPlaybackPath) ?? false);
  return hasRecordingLabel || hasPlaybackTarget
    ? extractRecordingPlaybackLink(description)
    : undefined;
}

export function extractRecordingPlaybackLink(
  description: string,
): ExtractedRecordingPlaybackLink {
  const links = [...description.matchAll(markdownLinkPattern)];
  const candidates = links.filter((match) => recordingLinkLabels.has(match[1] ?? ""));
  if (candidates.length !== 1) {
    throw new Error("Discord projection must contain exactly one recording playback link");
  }
  const candidate = candidates[0];
  const rawUrl = candidate?.[2];
  if (candidate?.index === undefined || rawUrl === undefined || rawUrl.length === 0) {
    throw new Error("Discord recording playback link is malformed");
  }
  const playbackUrl = parseRecordingPlaybackUrl(rawUrl);
  const otherPlaybackLink = links.some((link) =>
    link !== candidate && (link[2]?.includes(recordingPlaybackPath) ?? false)
  );
  if (otherPlaybackLink) {
    throw new Error("Discord projection must contain exactly one recording playback link");
  }
  const sanitizedUrl = `${playbackUrl.origin}${playbackUrl.pathname}`;
  const sanitizedLink = candidate[0].replace(`(${rawUrl})`, `(${sanitizedUrl})`);
  const embedDescription = description.slice(0, candidate.index) + sanitizedLink +
    description.slice(candidate.index + candidate[0].length);
  const capability = playbackUrl.hash.slice(1);
  if (embedDescription.includes(capability)) {
    throw new Error("Discord recording playback capability occurs outside its link target");
  }
  return { embedDescription, recordingPlaybackUrl: rawUrl };
}

function parseRecordingPlaybackUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Discord recording playback link is malformed");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== recordingPlaybackPath ||
    parsed.search.length > 0 ||
    !isPlausiblePlaybackCapability(parsed.hash.slice(1))
  ) {
    throw new Error("Discord recording playback link is malformed");
  }
  return parsed;
}

function isPlausiblePlaybackCapability(capability: string): boolean {
  const parts = capability.split(".");
  const payload = parts[1];
  const signature = parts[2];
  if (
    parts.length !== 3 ||
    parts[0] !== "v1" ||
    payload === undefined ||
    !/^[A-Za-z0-9_-]+$/u.test(payload) ||
    signature === undefined ||
    !/^[A-Za-z0-9_-]{43}$/u.test(signature)
  ) {
    return false;
  }
  const decodedPayload = Buffer.from(payload, "base64url").toString("utf8");
  return decodedPayload.length > 0 &&
    decodedPayload.length <= 256 &&
    !/\p{Cc}/u.test(decodedPayload) &&
    Buffer.from(decodedPayload, "utf8").toString("base64url") === payload &&
    Buffer.from(signature, "base64url").toString("base64url") === signature;
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
