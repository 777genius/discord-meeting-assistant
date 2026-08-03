import { createHash } from "node:crypto";

import { z } from "zod";

const snowflakeSchema = z.string().regex(/^\d{17,20}$/u, "Expected a Discord snowflake");
const discordEmbedDescriptionLimit = 4_096;
const discordEmbedDescriptionsLimit = 6_000;
const projectionKeySchema = z.string().trim().min(1).max(128);
const legacyProjectionKeySchema = z.string().trim().min(1).max(4_096);
const meetingProjectionKeyVersion = "meeting-discord-projection:v2";

export const discordPublicationModeSchema = z.enum(["message", "thread"]);

const discordThreadProjectionReferenceSchema = z.object({
  kind: z.literal("thread"),
  threadId: snowflakeSchema,
  messageId: snowflakeSchema,
});

const discordChannelMessageProjectionReferenceSchema = z.object({
  kind: z.literal("channel-message"),
  parentChannelId: snowflakeSchema,
  messageId: snowflakeSchema,
});

/**
 * A durable Discord receipt. `thread` is retained for existing projections;
 * new direct publications use `channel-message` so the parent channel is not
 * ever misrepresented as a thread.
 */
export const discordProjectionReferenceSchema = z.discriminatedUnion("kind", [
  discordThreadProjectionReferenceSchema,
  discordChannelMessageProjectionReferenceSchema,
]);

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
export type DiscordPublicationMode = z.infer<typeof discordPublicationModeSchema>;

export type DiscordProjectionContainer =
  | Pick<Extract<DiscordProjectionReference, { readonly kind: "thread" }>, "kind" | "threadId">
  | Pick<
    Extract<DiscordProjectionReference, { readonly kind: "channel-message" }>,
    "kind" | "parentChannelId"
  >;

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
  if (reference.kind === "thread") {
    return `discord:v2:thread:${reference.threadId}:message:${reference.messageId}`;
  }
  return `discord:v2:channel:${reference.parentChannelId}:message:${reference.messageId}`;
}

export function decodeDiscordExternalPublicationId(
  value: string,
): DiscordProjectionReference | undefined {
  const legacyThread = /^discord:v1:thread:(\d{17,20}):message:(\d{17,20})$/u.exec(value);
  if (legacyThread?.[1] !== undefined && legacyThread[2] !== undefined) {
    return { kind: "thread", threadId: legacyThread[1], messageId: legacyThread[2] };
  }
  const thread = /^discord:v2:thread:(\d{17,20}):message:(\d{17,20})$/u.exec(value);
  if (thread?.[1] !== undefined && thread[2] !== undefined) {
    return { kind: "thread", threadId: thread[1], messageId: thread[2] };
  }
  const channel = /^discord:v2:channel:(\d{17,20}):message:(\d{17,20})$/u.exec(value);
  if (channel?.[1] !== undefined && channel[2] !== undefined) {
    return {
      kind: "channel-message",
      parentChannelId: channel[1],
      messageId: channel[2],
    };
  }
  return undefined;
}

export type LocatedDiscordProjection =
  | {
    readonly kind: "thread";
    readonly threadId: string;
    readonly messageId?: string;
  }
  | {
    readonly kind: "channel-message";
    readonly parentChannelId: string;
    readonly messageId?: string;
  };

export interface DiscordProjectionClient {
  inspect(input: {
    /**
     * Thread history is materially more expensive than the parent-channel
     * path. Enable it only for thread mode or an explicit migration/recovery.
     */
    readonly includeThreads?: boolean;
    readonly parentChannelId: string;
    readonly marker: string;
    readonly referenceHint?: DiscordProjectionReference;
    /**
     * A deterministic internal recovery name used only while a newly-created
     * thread has not yet received its marker-bearing summary message.
     */
    readonly threadRecoveryName?: string;
  }): Promise<LocatedDiscordProjection | undefined>;

  createThread(input: {
    readonly parentChannelId: string;
    readonly name: string;
    readonly marker: string;
  }): Promise<string>;

  /** Reopens an archived thread without changing its stable human-facing title. */
  reopenThread(input: { readonly threadId: string }): Promise<void>;

  /** Completes the one-time transition from a recovery name to the human title. */
  renameThread(input: { readonly threadId: string; readonly name: string }): Promise<void>;

  createMessage(input: {
    readonly container: DiscordProjectionContainer;
    readonly body: DiscordProjectionBody;
    readonly marker: string;
  }): Promise<string>;

  editMessage(input: {
    readonly reference: DiscordProjectionReference;
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
