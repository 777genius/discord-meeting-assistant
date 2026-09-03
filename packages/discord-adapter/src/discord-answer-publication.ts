import { createHash } from "node:crypto";

import type {
  AnswerDeliveryPort,
  AnswerPayloadPort,
  AnswerPublicationBinding,
  PreparedAnswerPayload,
} from "@discord-meeting/meeting-core/publishing";
import { REST, Routes } from "discord.js";
import { z } from "zod";

const snowflakeSchema = z.string().regex(/^\d{17,20}$/u);
const markerSchema = z.string().trim().min(1).max(256);
const effectIdSchema = z.string().trim().min(1).max(512);
const reconciliationPageSize = 100;
const reconciliationPageLimit = 10;
const answerPayloadSchema = z.object({
  allowed_mentions: z.object({
    parse: z.array(z.never()).max(0),
    replied_user: z.literal(false),
  }).strict(),
  embeds: z.array(z.object({
    description: z.string().trim().min(1).max(2_000),
    url: z.url(),
  }).strict()).length(1),
  message_reference: z.object({
    channel_id: snowflakeSchema,
    fail_if_not_exists: z.literal(true),
    message_id: snowflakeSchema,
  }).strict(),
}).strict();

const discordAuthoredEmbedSchema = z.object({
  description: z.string(),
  type: z.literal("rich").optional(),
  url: z.string(),
}).strict();

const discordDeliveryChannelSchema = z.object({
  guild_id: snowflakeSchema, id: snowflakeSchema,
  parent_id: snowflakeSchema.nullable().optional(), type: z.number().int().nonnegative(),
}).loose();

const discordThreadChannelTypes = new Set([10, 11, 12]);
const discordDirectDeliveryChannelTypes = new Set([0, 5]);

const discordMessageSchema = z.object({
  application_id: snowflakeSchema.optional(),
  activity: z.unknown().optional(),
  application: z.unknown().optional(),
  author: z.object({ id: snowflakeSchema }).loose(),
  attachments: z.array(z.unknown()).default([]),
  channel_id: snowflakeSchema,
  components: z.array(z.unknown()).default([]),
  content: z.string(),
  call: z.unknown().optional(),
  embeds: z.array(z.unknown()),
  edited_timestamp: z.string().nullable().optional(),
  flags: z.number().int().nonnegative().optional(),
  guild_id: snowflakeSchema,
  id: snowflakeSchema,
  member: z.unknown().optional(),
  mention_channels: z.array(z.unknown()).optional(),
  mention_everyone: z.boolean(),
  mention_roles: z.array(z.unknown()),
  mentions: z.array(z.unknown()),
  message_reference: z.object({
    channel_id: snowflakeSchema,
    fail_if_not_exists: z.boolean().optional(),
    guild_id: snowflakeSchema.optional(),
    message_id: snowflakeSchema,
    type: z.number().int().nonnegative().default(0),
  }).strict()
    .optional(),
  nonce: z.union([z.string(), z.number()]).optional(),
  pinned: z.boolean(),
  poll: z.unknown().optional(),
  position: z.number().int().nonnegative().optional(),
  reactions: z.array(z.unknown()).optional(),
  referenced_message: z.object({
    channel_id: snowflakeSchema.optional(),
    guild_id: snowflakeSchema.optional(),
    id: snowflakeSchema,
    type: z.number().int().nonnegative().optional(),
  }).loose().nullable().optional(),
  resolved: z.unknown().optional(),
  shared_client_theme: z.unknown().optional(),
  soundboard_sounds: z.array(z.unknown()).optional(),
  thread: z.unknown().optional(),
  timestamp: z.string().optional(),
  tts: z.boolean(),
  type: z.number().int().nonnegative(),
  interaction: z.unknown().optional(),
  interaction_metadata: z.unknown().optional(),
  message_snapshots: z.array(z.unknown()).optional(),
  role_subscription_data: z.unknown().optional(),
  sticker_items: z.array(z.unknown()).default([]),
  stickers: z.array(z.unknown()).optional(),
  webhook_id: snowflakeSchema.optional(),
}).strict();

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalValue(item)]));
}

function markerUrl(marker: string): string {
  return `https://discord-meeting.invalid/knowledge-answer/${sha256(marker)}`;
}

function nonceForEffect(effectId: string): string {
  return sha256(effectIdSchema.parse(effectId)).slice(0, 25);
}

function withoutDeliveryContainer(
  binding: AnswerPublicationBinding,
): Omit<AnswerPublicationBinding, "deliveryContainerId"> {
  const { deliveryContainerId: _deliveryContainerId, ...legacyBinding } = binding;
  return legacyBinding;
}

/**
 * A dedicated REST client keeps the answer effect's one-attempt policy local
 * to this publication path. Other Discord features retain their own retry
 * policy, while rate limits and transient server failures are surfaced as an
 * ambiguous answer outcome for reconciliation.
 */
export function createDiscordOneAttemptAnswerRest(token: string): REST {
  if (token.trim().length === 0) {
    throw new RangeError("Discord answer REST token must not be empty");
  }
  return new REST({
    rejectOnRateLimit: () => true,
    retries: 0,
  }).setToken(token);
}

export class DiscordAnswerPayloadCodec implements AnswerPayloadPort {
  public prepare(input: {
    readonly binding: AnswerPublicationBinding;
    readonly content: string;
    readonly deliveryContainerId: string;
    readonly marker: string;
    readonly projectionTargetContainerId: string;
    readonly replyToRemoteMessageId: string;
  }): PreparedAnswerPayload {
    markerSchema.parse(input.marker);
    const payloadBytes = canonicalJson(answerPayloadSchema.parse({
      allowed_mentions: { parse: [], replied_user: false },
      embeds: [{
        description: input.content,
        url: markerUrl(input.marker),
      }],
      message_reference: {
        channel_id: input.deliveryContainerId,
        fail_if_not_exists: true,
        message_id: input.replyToRemoteMessageId,
      },
    }));
    return {
      bindingHash: sha256(canonicalJson(input.binding)),
      legacyBindingHash: sha256(canonicalJson(withoutDeliveryContainer(input.binding))),
      payloadBytes,
      payloadHash: sha256(payloadBytes),
    };
  }
}

export class DiscordAnswerDeliveryAdapter implements AnswerDeliveryPort {
  public constructor(
    private readonly rest: Pick<REST, "get" | "post"> & Partial<Pick<REST, "delete">>,
    private readonly botApplicationIdentity: string,
  ) {}

  public async create(input: {
    readonly authorityScopeId: string;
    readonly deliveryContainerId: string;
    readonly effectId: string;
    readonly marker: string;
    readonly payloadBytes: string;
    readonly projectionTargetContainerId: string;
    readonly replyToRemoteMessageId: string;
  }): Promise<string> {
    snowflakeSchema.parse(input.authorityScopeId);
    snowflakeSchema.parse(input.projectionTargetContainerId);
    const payload = answerPayloadSchema.parse(JSON.parse(input.payloadBytes) as unknown);
    const nonce = nonceForEffect(input.effectId);
    if (
      payload.embeds[0]?.url !== markerUrl(markerSchema.parse(input.marker)) ||
      payload.message_reference.channel_id !== input.deliveryContainerId ||
      payload.message_reference.message_id !== input.replyToRemoteMessageId
    ) {
      throw new Error("Discord answer payload conflicts with its immutable effect");
    }
    const response = await this.rest.post(
      Routes.channelMessages(input.deliveryContainerId),
      {
        body: { ...payload, enforce_nonce: true, nonce },
      },
    );
    return z.object({ id: snowflakeSchema }).loose().parse(response).id;
  }

  public async inspect(input: {
    readonly authorityScopeId: string;
    readonly deliveryContainerId: string;
    readonly marker: string;
    readonly payloadBytes: string;
    readonly payloadHash: string;
    readonly projectionTargetContainerId: string;
    readonly replyToRemoteMessageId: string;
  }): Promise<
    | { readonly externalReceipt: string; readonly status: "found" }
    | { readonly externalReceipts: readonly string[]; readonly status: "duplicate" }
    | { readonly status: "unconfirmed" }
  > {
    const exactReceipts: string[] = [];
    try {
      const expected = answerPayloadSchema.parse(JSON.parse(input.payloadBytes) as unknown);
      const expectedGuildId = snowflakeSchema.parse(input.authorityScopeId);
      const expectedProjectionTargetContainerId = snowflakeSchema.parse(
        input.projectionTargetContainerId,
      );
      const expectedDeliveryContainerId = snowflakeSchema.parse(input.deliveryContainerId);
      if (sha256(canonicalJson(expected)) !== input.payloadHash ||
        expected.embeds[0]?.url !== markerUrl(markerSchema.parse(input.marker)) ||
        expected.message_reference.channel_id !== input.deliveryContainerId ||
        expected.message_reference.message_id !== input.replyToRemoteMessageId) {
        throw new Error("Discord reconciliation input conflicts with immutable effect bytes");
      }
      const deliveryChannel = discordDeliveryChannelSchema.parse(await this.rest.get(
        Routes.channel(expectedDeliveryContainerId),
      ));
      if (!hasExactDeliveryTopology(
        deliveryChannel,
        expectedDeliveryContainerId,
        expectedGuildId,
        expectedProjectionTargetContainerId,
      )) {
        throw new Error("Discord delivery topology conflicts with immutable effect authority");
      }
      let cursor = snowflakeSchema.parse(input.replyToRemoteMessageId);
      let historyExhausted = false;
      for (let page = 0; page < reconciliationPageLimit; page += 1) {
        const query = new URLSearchParams({
          after: cursor,
          limit: reconciliationPageSize.toString(),
        });
        const response = await this.rest.get(
          Routes.channelMessages(input.deliveryContainerId),
          { query },
        );
        const messages = z.array(discordMessageSchema)
          .max(reconciliationPageSize)
          .parse(response)
          .toSorted((left, right) => {
            const leftId = BigInt(left.id);
            const rightId = BigInt(right.id);
            return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
          });
        if (new Set(messages.map(({ id }) => id)).size !== messages.length) {
          throw new Error("Discord reconciliation page contains duplicate message IDs");
        }
        if (messages.some(({ id }) => BigInt(id) <= BigInt(cursor))) {
          throw new Error("Discord reconciliation history overlaps its cursor");
        }
        const candidates = messages.filter((message) =>
          message.author.id === this.botApplicationIdentity &&
          (message.application_id === undefined ||
            message.application_id === this.botApplicationIdentity) &&
          message.message_reference?.message_id === input.replyToRemoteMessageId
        );
        for (const message of candidates) {
          if (!hasExactAuthoredAnswerPayload(message, expected, expectedGuildId)) {
            continue;
          }
          exactReceipts.push(message.id);
        }
        if (messages.length < reconciliationPageSize) {
          historyExhausted = true;
          break;
        }
        cursor = messages.at(-1)!.id;
      }
      if (!historyExhausted) {
        return { status: "unconfirmed" };
      }
    } catch {
      // Missing, partial, malformed, or forbidden history can never prove a
      // conclusive found/absent/duplicate set, even after seeing matches.
      return { status: "unconfirmed" };
    }
    if (exactReceipts.length > 1) {
      return {
        externalReceipts: Object.freeze(exactReceipts),
        status: "duplicate",
      };
    }
    if (exactReceipts.length === 1) {
      return { externalReceipt: exactReceipts[0]!, status: "found" };
    }
    return { status: "unconfirmed" };
  }

  public async remove(input: {
    readonly deliveryContainerId: string;
    readonly effectId: string;
    readonly externalReceipt: string;
  }): Promise<void> {
    if (this.rest.delete === undefined) {
      throw new Error("Discord answer deletion transport is unavailable");
    }
    try {
      await this.rest.delete(
        Routes.channelMessage(input.deliveryContainerId, input.externalReceipt),
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        (Reflect.get(error, "status") === 404 || Reflect.get(error, "code") === 10_008)
      ) {
        return;
      }
      throw error;
    }
  }
}

function hasExactDeliveryTopology(
  channel: z.infer<typeof discordDeliveryChannelSchema>,
  expectedDeliveryContainerId: string,
  expectedGuildId: string,
  expectedProjectionTargetContainerId: string,
): boolean {
  if (channel.id !== expectedDeliveryContainerId || channel.guild_id !== expectedGuildId) {
    return false;
  }
  if (discordThreadChannelTypes.has(channel.type)) {
    return channel.parent_id === expectedProjectionTargetContainerId;
  }
  return discordDirectDeliveryChannelTypes.has(channel.type) &&
    expectedDeliveryContainerId === expectedProjectionTargetContainerId;
}

function hasExactAuthoredAnswerPayload(
  message: z.infer<typeof discordMessageSchema>,
  expected: z.infer<typeof answerPayloadSchema>,
  expectedGuildId: string,
): boolean {
  if (!hasNoAdditionalDiscordClaimSurfaces(message, expected, expectedGuildId) ||
    message.embeds.length !== 1) {
    return false;
  }
  const embed = discordAuthoredEmbedSchema.safeParse(message.embeds[0]);
  return embed.success &&
    embed.data.description === expected.embeds[0]!.description &&
    embed.data.url === expected.embeds[0]!.url;
}

function hasNoAdditionalDiscordClaimSurfaces(
  message: z.infer<typeof discordMessageSchema>,
  expected: z.infer<typeof answerPayloadSchema>,
  expectedGuildId: string,
): boolean {
  return message.guild_id === expectedGuildId &&
    message.channel_id === expected.message_reference.channel_id &&
    hasExpectedDiscordReplyEnvelope(message) &&
    hasNoDiscordVisibleAdditions(message) &&
    hasExpectedDiscordReference(message, expected, expectedGuildId);
}

function hasExpectedDiscordReplyEnvelope(
  message: z.infer<typeof discordMessageSchema>,
): boolean {
  const emptyArrays = [message.attachments, message.components, message.sticker_items,
    message.stickers ?? [], message.mentions, message.mention_roles,
    message.mention_channels ?? []];
  return message.content === "" && message.type === 19 && !message.tts &&
    !message.mention_everyone && !message.pinned &&
    (message.edited_timestamp === undefined || message.edited_timestamp === null) &&
    emptyArrays.every((items) => items.length === 0) &&
    (message.reactions?.length ?? 0) === 0 && (message.flags ?? 0) === 0;
}

function hasNoDiscordVisibleAdditions(
  message: z.infer<typeof discordMessageSchema>,
): boolean {
  return (message.poll === undefined || message.poll === null) &&
    message.activity === undefined && message.application === undefined &&
    message.call === undefined && message.interaction === undefined &&
    message.interaction_metadata === undefined &&
    (message.message_snapshots?.length ?? 0) === 0 &&
    message.role_subscription_data === undefined &&
    message.resolved === undefined && message.shared_client_theme === undefined &&
    message.thread === undefined && (message.soundboard_sounds?.length ?? 0) === 0 &&
    message.webhook_id === undefined;
}

function hasExpectedDiscordReference(
  message: z.infer<typeof discordMessageSchema>,
  expected: z.infer<typeof answerPayloadSchema>,
  expectedGuildId: string,
): boolean {
  const reference = message.message_reference;
  const guildIdentityIsExact = reference?.guild_id === undefined ||
    reference.guild_id === expectedGuildId;
  const referenced = message.referenced_message;
  const nestedIdentityIsExact = referenced === undefined || referenced === null || (
    referenced.id === expected.message_reference.message_id &&
    (referenced.channel_id === undefined ||
      referenced.channel_id === expected.message_reference.channel_id) &&
    (referenced.guild_id === undefined || referenced.guild_id === expectedGuildId) &&
    (referenced.type === undefined || referenced.type === 0)
  );
  return reference !== undefined &&
    reference.message_id === expected.message_reference.message_id &&
    reference.channel_id === expected.message_reference.channel_id &&
    reference.type === 0 && guildIdentityIsExact &&
    (reference.fail_if_not_exists === undefined ||
      reference.fail_if_not_exists === expected.message_reference.fail_if_not_exists) &&
    nestedIdentityIsExact;
}
