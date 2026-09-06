import { REST, Routes } from "discord.js";
import { z } from "zod";
import { DiscordJsLiveDiscordProjectionReader } from "./discordjs-live-discord-projection-reader.js";
import type { LiveDiscordProjectionReader } from "./live-discord-observer.js";
import { createObservedMeetingProjectionMarkers } from "./live-discord-projection-marker-contract.js";
import { FileSecretReader } from "./keychain.js";
import { requireEvidence as check, sha256 } from "./oss-campaign-artifacts.js";
import { planSchema, type OssPlan } from "./oss-campaign-profile.js";

export interface OssPublicationReads {
  readonly observer: LiveDiscordProjectionReader;
  readChannel(channelId: string): Promise<unknown>;
  readMessage(channelId: string, messageId: string): Promise<unknown>;
  download(url: string): Promise<Buffer>;
}
const attachmentSchema = z.object({ id: z.string().regex(/^\d+$/u), filename: z.string(),
  size: z.number().int().positive().max(1024 * 1024), url: z.string() });
const messageSchema = z.object({ id: z.string(), channel_id: z.string(),
  author: z.object({ id: z.string(), bot: z.literal(true) }), timestamp: z.iso.datetime({ offset: true }),
  edited_timestamp: z.string().nullable(), attachments: z.array(attachmentSchema).length(2) });

/** Existing readonly projection observer supplies the whole matching-message set;
 * exact REST reads supply immutable message and attachment identities. */
export async function collectOssPublication(input: {
  plan: OssPlan; meetingId: string; messageId: string; startedAtMs: number;
}, reads: OssPublicationReads) {
  const plan = planSchema.parse(input.plan);
  check(/^[A-Za-z0-9_-]{1,128}$/u.test(input.meetingId) && /^\d+$/u.test(input.messageId) &&
    Number.isSafeInteger(input.startedAtMs) && input.startedAtMs >= 0, "Invalid publication capture identity");
  const channelId = plan.target.resultsChannelId;
  const channel = z.object({ id: z.string(), guild_id: z.string(), type: z.literal(0) }).parse(await reads.readChannel(channelId));
  check(channel.id === channelId && channel.guild_id === plan.target.guildId, "Publication private target mismatch");
  const marker = createObservedMeetingProjectionMarkers(input.meetingId, channelId)[1];
  const observations = await reads.observer.poll({ resultChannelId: channelId, createdSinceMilliseconds: input.startedAtMs });
  const matches = observations.flatMap((projection) => projection.messages.filter((message) =>
    message.authorId === plan.target.publicationApplicationId && message.embeds.some((embed) =>
      embed.footerText?.includes(marker) || embed.url === `https://meeting-platform.invalid/projection/${encodeURIComponent(marker)}`
    )).map((message) => ({ projection, message })));
  check(matches.length === 1 && matches[0]!.message.id === input.messageId &&
    matches[0]!.projection.container.kind === "channel-message", "Missing/duplicate final Discord publication");
  const message = messageSchema.parse(await reads.readMessage(channelId, input.messageId));
  check(message.id === input.messageId && message.channel_id === channelId &&
    message.author.id === plan.target.publicationApplicationId && Date.parse(message.timestamp) >= input.startedAtMs &&
    Date.parse(message.timestamp) === matches[0]!.message.createdAtMilliseconds,
    "Discord observer/message identity mismatch");
  check(message.attachments.map((item) => item.filename).sort().join() === "meeting-summary.md,meeting-transcript.md",
    "Missing full Discord evidence attachments");
  const attachments = [];
  for (const attachment of message.attachments) {
    const url = new URL(attachment.url);
    check(url.protocol === "https:" && url.hostname === "cdn.discordapp.com" && !url.username && !url.password &&
      url.pathname.startsWith(`/attachments/${channelId}/${attachment.id}/`), "Unexpected Discord attachment origin");
    const bytes = await reads.download(attachment.url);
    check(bytes.length === attachment.size, "Truncated Discord attachment");
    // Summary attachments contain possession-bearing playback links. Keep the raw
    // digest and full visible text, never retain the URL/capability itself.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      .replace(/\[([^\]\r\n]+)\]\(https?:\/\/[^)\r\n]+\)/gu, "$1")
      .replace(/https?:\/\/[^\s<>]+/gu, "[URL omitted]");
    attachments.push({ id: attachment.id, filename: attachment.filename,
      sizeBytes: bytes.length, sha256: sha256(bytes), text });
  }
  return { kind: "oss-native-publication-v1" as const, meetingId: input.meetingId,
    observedAtMs: Date.now(), messageId: message.id, channelId, authorId: message.author.id,
    createdAtMs: Date.parse(message.timestamp), editedAt: message.edited_timestamp,
    matchingFinalMessageIds: matches.map(({ message: item }) => item.id), attachments };
}

/** Called only by the explicit collector CLI after source/deployment review. */
export async function collectOssPublicationFromDiscord(input: Parameters<typeof collectOssPublication>[0], secretDirectory: string) {
  planSchema.parse(input.plan);
  const token = await new FileSecretReader(secretDirectory).read("sut");
  const reader = new DiscordJsLiveDiscordProjectionReader();
  const rest = new REST({ timeout: 15_000, retries: 0 }).setToken(token);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = async () => {
    await reader.connect(token);
    check(reader.authenticatedUserId() === input.plan.target.publicationApplicationId, "Official publication bot mismatch");
    return collectOssPublication(input, { observer: reader,
      readChannel: (id) => rest.get(Routes.channel(id)),
      readMessage: (channel, message) => rest.get(Routes.channelMessage(channel, message)),
      download: async (url) => {
        const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "error" });
        check(response.ok && response.body, "Discord attachment download failed");
        const chunks: Uint8Array[] = []; let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length; check(size <= 1024 * 1024, "Discord attachment bound exceeded"); chunks.push(chunk);
        }
        return Buffer.concat(chunks);
      },
    });
  };
  try {
    return await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("OSS Discord read deadline exceeded")), 60_000);
    })]);
  } finally { clearTimeout(timer); await reader.close(); }
}
