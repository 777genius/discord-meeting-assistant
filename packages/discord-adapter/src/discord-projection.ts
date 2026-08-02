import { createHash } from "node:crypto";

import { z } from "zod";

const snowflakeSchema = z.string().regex(/^\d{17,20}$/u, "Expected a Discord snowflake");
const discordEmbedDescriptionLimit = 4_096;
const discordEmbedDescriptionsLimit = 6_000;
const projectionKeySchema = z.string().trim().min(1).max(128);
const legacyProjectionKeySchema = z.string().trim().min(1).max(4_096);
const meetingProjectionKeyVersion = "meeting-discord-projection:v2";

export const discordProjectionReferenceSchema = z.object({
  threadId: snowflakeSchema,
  messageId: snowflakeSchema,
});

export const discordProjectionBodySchema = z.object({
  markdown: z.string().trim().min(1).max(discordEmbedDescriptionLimit),
  liveCaptionsMarkdown: z
    .string()
    .trim()
    .min(1)
    .max(discordEmbedDescriptionLimit)
    .optional(),
}).superRefine(validateDiscordEmbedDescriptions);

export const publishDiscordSummarySchema = z.object({
  projectionKey: projectionKeySchema,
  parentChannelId: snowflakeSchema,
  threadTitle: z.string().trim().min(1).max(80),
  markdown: z.string().trim().min(1).max(discordEmbedDescriptionLimit),
  liveCaptionsMarkdown: z
    .string()
    .trim()
    .min(1)
    .max(discordEmbedDescriptionLimit)
    .optional(),
  legacyProjectionKeys: z.array(legacyProjectionKeySchema).max(4).optional(),
  currentReference: discordProjectionReferenceSchema.optional(),
}).superRefine(validateDiscordEmbedDescriptions);

export type DiscordProjectionReference = z.infer<typeof discordProjectionReferenceSchema>;
export type DiscordProjectionBody = z.infer<typeof discordProjectionBodySchema>;
export type PublishDiscordSummary = z.infer<typeof publishDiscordSummarySchema>;

export const DISCORD_EMBED_DESCRIPTION_LIMIT = discordEmbedDescriptionLimit;
export const DISCORD_EMBED_DESCRIPTIONS_LIMIT = discordEmbedDescriptionsLimit;

/**
 * Stable Discord projection identity for both live and final views of one
 * meeting. It deliberately excludes operation idempotency keys: those protect
 * a specific attempt, while this identifies the single visible projection.
 */
export function createMeetingDiscordProjectionKey(
  meetingId: string,
  targetChannelId: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([meetingProjectionKeyVersion, meetingId, targetChannelId]), "utf8")
    .digest("hex");
  return `${meetingProjectionKeyVersion}:${digest}`;
}

export function toDiscordProjectionBody(
  input: Pick<PublishDiscordSummary, "markdown" | "liveCaptionsMarkdown">,
): DiscordProjectionBody {
  return input.liveCaptionsMarkdown === undefined
    ? { markdown: input.markdown }
    : { markdown: input.markdown, liveCaptionsMarkdown: input.liveCaptionsMarkdown };
}

export function encodeDiscordExternalPublicationId(
  reference: DiscordProjectionReference,
): string {
  return `discord:v1:thread:${reference.threadId}:message:${reference.messageId}`;
}

export function decodeDiscordExternalPublicationId(
  value: string,
): DiscordProjectionReference | undefined {
  const match = /^discord:v1:thread:(\d{17,20}):message:(\d{17,20})$/u.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) {
    return undefined;
  }
  return { threadId: match[1], messageId: match[2] };
}

export interface LocatedDiscordProjection {
  readonly threadId: string;
  readonly messageId?: string;
}

export interface DiscordProjectionClient {
  inspect(input: {
    readonly parentChannelId: string;
    readonly marker: string;
    readonly referenceHint?: DiscordProjectionReference;
  }): Promise<LocatedDiscordProjection | undefined>;

  createThread(input: {
    readonly parentChannelId: string;
    readonly name: string;
    readonly marker: string;
  }): Promise<string>;

  renameThread(input: { readonly threadId: string; readonly name: string }): Promise<void>;

  createMessage(input: {
    readonly threadId: string;
    readonly body: DiscordProjectionBody;
    readonly marker: string;
  }): Promise<string>;

  editMessage(input: {
    readonly threadId: string;
    readonly messageId: string;
    readonly body: DiscordProjectionBody;
    readonly marker: string;
  }): Promise<void>;
}

export interface ProjectionLock {
  /**
   * Serializes one projection key. Multi-process deployments must inject a
   * distributed implementation; the in-process implementation is deliberately
   * scoped to one publisher process.
   */
  runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T>;
}

function validateDiscordEmbedDescriptions(
  body: { readonly markdown: string; readonly liveCaptionsMarkdown?: string | undefined },
  context: z.RefinementCtx,
): void {
  const descriptionsLength = body.markdown.length + (body.liveCaptionsMarkdown?.length ?? 0);
  if (descriptionsLength > discordEmbedDescriptionsLimit) {
    context.addIssue({
      code: "custom",
      message: "Discord embed descriptions exceed the aggregate message limit",
      path: ["liveCaptionsMarkdown"],
    });
  }
}
