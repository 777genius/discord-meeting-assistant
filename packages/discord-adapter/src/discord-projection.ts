import { z } from "zod";

const snowflakeSchema = z.string().regex(/^\d{17,20}$/u, "Expected a Discord snowflake");

export const discordProjectionReferenceSchema = z.object({
  threadId: snowflakeSchema,
  messageId: snowflakeSchema,
});

export const publishDiscordSummarySchema = z.object({
  projectionKey: z.string().min(1).max(128),
  parentChannelId: snowflakeSchema,
  threadTitle: z.string().trim().min(1).max(80),
  markdown: z.string().trim().min(1).max(4_000),
  currentReference: discordProjectionReferenceSchema.optional(),
});

export type DiscordProjectionReference = z.infer<typeof discordProjectionReferenceSchema>;
export type PublishDiscordSummary = z.infer<typeof publishDiscordSummarySchema>;

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
    readonly markdown: string;
    readonly marker: string;
  }): Promise<string>;

  editMessage(input: {
    readonly threadId: string;
    readonly messageId: string;
    readonly markdown: string;
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
