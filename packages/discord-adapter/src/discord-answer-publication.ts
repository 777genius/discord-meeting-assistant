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

const discordMessageSchema = z.object({
  application_id: snowflakeSchema.optional(),
  author: z.object({ id: snowflakeSchema }).loose(),
  embeds: z.array(z.object({
    description: z.string().optional(),
    url: z.string().optional(),
  }).loose()),
  id: snowflakeSchema,
  message_reference: z.object({ message_id: snowflakeSchema.optional() })
    .loose()
    .optional(),
}).loose();

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
    readonly deliveryContainerId: string;
    readonly marker: string;
    readonly payloadBytes: string;
    readonly projectionTargetContainerId: string;
    readonly replyToRemoteMessageId: string;
  }): Promise<string> {
    const payload = answerPayloadSchema.parse(JSON.parse(input.payloadBytes) as unknown);
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
        body: payload,
      },
    );
    return z.object({ id: snowflakeSchema }).loose().parse(response).id;
  }

  public async inspect(input: {
    readonly deliveryContainerId: string;
    readonly marker: string;
    readonly payloadHash: string;
    readonly projectionTargetContainerId: string;
    readonly replyToRemoteMessageId: string;
  }): Promise<
    | { readonly externalReceipt: string; readonly status: "found" }
    | { readonly status: "unconfirmed" }
  > {
    try {
      const exactReceipts: string[] = [];
      let cursor = snowflakeSchema.parse(input.replyToRemoteMessageId);
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
        if (messages.some(({ id }) => BigInt(id) <= BigInt(cursor))) {
          return { status: "unconfirmed" };
        }
        const candidates = messages.filter((message) =>
          message.author.id === this.botApplicationIdentity &&
          (message.application_id ?? message.author.id) === this.botApplicationIdentity &&
          message.message_reference?.message_id === input.replyToRemoteMessageId
        );
        for (const message of candidates) {
          const embed = message.embeds.find(({ url }) => url === markerUrl(input.marker));
          if (embed?.description === undefined) {
            continue;
          }
          const reconstructed = canonicalJson(answerPayloadSchema.parse({
            allowed_mentions: { parse: [], replied_user: false },
            embeds: [{
              description: embed.description,
              url: markerUrl(input.marker),
            }],
            message_reference: {
              channel_id: input.deliveryContainerId,
              fail_if_not_exists: true,
              message_id: input.replyToRemoteMessageId,
            },
          }));
          if (sha256(reconstructed) === input.payloadHash) {
            exactReceipts.push(message.id);
          }
        }
        if (exactReceipts.length > 1) {
          return { status: "unconfirmed" };
        }
        if (exactReceipts.length === 1) {
          return { externalReceipt: exactReceipts[0]!, status: "found" };
        }
        if (messages.length < reconciliationPageSize) {
          break;
        }
        cursor = messages.at(-1)!.id;
      }
    } catch {
      // Missing, partial, or forbidden history can never prove non-delivery.
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
