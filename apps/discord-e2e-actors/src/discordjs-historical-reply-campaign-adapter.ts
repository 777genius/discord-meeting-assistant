import { createHash } from "node:crypto";

import {
  ChannelType,
  Client,
  GatewayIntentBits,
  type Message,
  type GuildTextBasedChannel,
} from "discord.js";
import { z } from "zod";

import type {
  HistoricalReplyDurableQuestionOutcomeV1,
  HistoricalReplyDurableQuestionAdmissionV1,
  HistoricalReplyDurableSettlementV1,
  HistoricalReplyCrashReceiptV1,
} from "./historical-reply-campaign-contract.js";
import { createObservedMeetingProjectionMarkers } from
  "./live-discord-projection-marker-contract.js";
import type {
  HistoricalReplyAnswerObservation,
  HistoricalReplyAnswerReceipt,
  HistoricalReplyCampaignPort,
  HistoricalReplyQuestionReceipt,
  HistoricalReplyTargetObservation,
} from "./historical-reply-campaign.js";
import {
  observeGovernedPrivateCampaign,
  type GovernedCampaignObservationInput,
} from "./governed-private-campaign-observation.js";
import { createDiscordJsGovernedCampaignObservationPort } from
  "./discordjs-governed-campaign-observation-port.js";

type ReplyChannel = GuildTextBasedChannel;

function projectionMarkerUrl(marker: string): string {
  return `https://meeting-platform.invalid/projection/${encodeURIComponent(marker)}`;
}

export interface HistoricalDiscordAnswerPayload {
  readonly attachmentCount: number;
  readonly componentCount: number;
  readonly content: string;
  readonly embeds: readonly unknown[];
  readonly expectedMarkerUrl: string;
  readonly hasActivity: boolean;
  readonly hasCall: boolean;
  readonly hasInteraction: boolean;
  readonly hasPoll: boolean;
  readonly hasRoleSubscriptionData: boolean;
  readonly hasThread: boolean;
  readonly messageSnapshotCount: number;
  readonly stickerCount: number;
}

const historicalAnswerEmbedSchema = z.object({
  description: z.string().trim().min(1).max(2_000),
  type: z.literal("rich").optional(),
  url: z.url(),
}).strict();

/** Fail closed unless the payload has one parsed description and its contract marker URL. */
export function descriptionFromHistoricalDiscordAnswerPayload(
  payload: HistoricalDiscordAnswerPayload,
): string {
  const unsupportedMessageSurface = [
    payload.content.length !== 0,
    payload.embeds.length !== 1,
    payload.componentCount !== 0,
    payload.attachmentCount !== 0,
    payload.stickerCount !== 0,
    payload.messageSnapshotCount !== 0,
    payload.hasActivity,
    payload.hasCall,
    payload.hasInteraction,
    payload.hasPoll,
    payload.hasRoleSubscriptionData,
    payload.hasThread,
  ].some(Boolean);
  const parsedEmbed = historicalAnswerEmbedSchema.safeParse(payload.embeds[0]);
  if (unsupportedMessageSurface || !parsedEmbed.success ||
    parsedEmbed.data.url !== payload.expectedMarkerUrl) {
    throw new Error("Historical reply answer contains an unsupported Discord payload surface");
  }
  return parsedEmbed.data.description;
}

export interface HistoricalAnswerPollingInput {
  readonly afterMessageId: string;
  readonly answerTimeoutMilliseconds: number;
  readonly fetchMatchingAnswers: (
    afterMessageId: string,
  ) => Promise<readonly HistoricalReplyAnswerObservation[]>;
  readonly now: () => number;
  readonly pollIntervalMilliseconds: number;
  readonly quietWindowMilliseconds: number;
  readonly wait: (milliseconds: number) => Promise<void>;
}

export async function awaitHistoricalAnswerSnapshot(
  input: HistoricalAnswerPollingInput,
): Promise<HistoricalReplyAnswerReceipt> {
  const deadline = input.now() + input.answerTimeoutMilliseconds;
  let firstAnswer: HistoricalReplyAnswerObservation | undefined;
  let quietStartedAt: number | undefined;
  for (;;) {
    const snapshotStartedAt = input.now();
    const matches = await input.fetchMatchingAnswers(
      firstAnswer?.messageId ?? input.afterMessageId,
    );
    if ((firstAnswer === undefined && matches.length > 1) ||
      (firstAnswer !== undefined && matches.length > 0)) {
      throw new Error("Historical reply campaign observed duplicate SUT answers");
    }
    const answer = matches[0];
    if (answer !== undefined && firstAnswer === undefined) {
      firstAnswer = answer;
      quietStartedAt = input.now();
    }
    if (firstAnswer !== undefined && quietStartedAt !== undefined &&
      snapshotStartedAt >= quietStartedAt + input.quietWindowMilliseconds) {
      return {
        answer: firstAnswer,
        quietWindow: {
          endedAt: new Date(snapshotStartedAt).toISOString(),
          matchingAnswerMessageIds: [firstAnswer.messageId],
          startedAt: new Date(quietStartedAt).toISOString(),
        },
      };
    }
    if (firstAnswer === undefined && input.now() >= deadline) {
      throw new Error("Timed out waiting for historical reply answer");
    }
    await input.wait(input.pollIntervalMilliseconds);
  }
}

export interface DiscordJsHistoricalReplyCampaignAdapterOptions {
  readonly answerTimeoutMilliseconds: number;
  readonly observeQuestionAdmission: (
    questionId: string,
  ) => Promise<HistoricalReplyDurableQuestionAdmissionV1>;
  readonly observeQuestionOutcome: (
    questionId: string,
  ) => Promise<HistoricalReplyDurableQuestionOutcomeV1>;
  readonly observeQuestionSettlement: (
    questionId: string,
  ) => Promise<HistoricalReplyDurableSettlementV1>;
  readonly observeCrashReceipts: () => Promise<readonly HistoricalReplyCrashReceiptV1[]>;
  readonly pollIntervalMilliseconds: number;
  readonly quietWindowMilliseconds: number;
  readonly revalidateRuntime: () => Promise<void>;
}

export class DiscordJsHistoricalReplyCampaignAdapter implements HistoricalReplyCampaignPort {
  readonly #client = new Client({ intents: [GatewayIntentBits.Guilds] });

  public constructor(
    private readonly options: DiscordJsHistoricalReplyCampaignAdapterOptions,
  ) {
    const { answerTimeoutMilliseconds, pollIntervalMilliseconds,
      quietWindowMilliseconds } = options;
    if (!Number.isSafeInteger(answerTimeoutMilliseconds) || answerTimeoutMilliseconds < 1_000 ||
      answerTimeoutMilliseconds > 300_000 || !Number.isSafeInteger(pollIntervalMilliseconds) ||
      pollIntervalMilliseconds < 100 || pollIntervalMilliseconds > 10_000 ||
      pollIntervalMilliseconds > answerTimeoutMilliseconds ||
      !Number.isSafeInteger(quietWindowMilliseconds) || quietWindowMilliseconds < 1_000 ||
      quietWindowMilliseconds > 30_000) {
      throw new RangeError("Historical reply polling bounds are invalid");
    }
  }

  public async connect(token: string): Promise<void> {
    await this.#client.login(token);
  }

  public assertRuntimeReady(): Promise<void> {
    return this.options.revalidateRuntime();
  }

  public authenticatedApplicationId(): string {
    const id = this.#client.user?.id;
    if (id === undefined) {
      throw new Error("Historical reply observer is not authenticated");
    }
    return id;
  }

  public async inspectTarget(input: {
    readonly channelId: string;
    readonly kind: "final-summary" | "live-transcript";
    readonly meetingId: string;
    readonly messageId: string;
    readonly parentChannelId: string;
  }): Promise<HistoricalReplyTargetObservation> {
    const channel = await this.#replyChannel(input.channelId);
    if ((channel.isThread() ? channel.parentId : channel.id) !== input.parentChannelId) {
      throw new Error("Historical reply target is bound to another publication parent");
    }
    const message = await channel.messages.fetch(input.messageId);
    const [liveMarker, finalMarker] = createObservedMeetingProjectionMarkers(
      input.meetingId,
      input.parentChannelId,
    );
    const expectedMarker = input.kind === "live-transcript" ? liveMarker : finalMarker;
    const otherMarker = input.kind === "live-transcript" ? finalMarker : liveMarker;
    const markerUrls = new Set(message.embeds.flatMap(({ url }) => url === null ? [] : [url]));
    if (!markerUrls.has(projectionMarkerUrl(expectedMarker)) ||
      markerUrls.has(projectionMarkerUrl(otherMarker))) {
      throw new Error("Historical reply target does not carry the expected canonical marker");
    }
    return {
      authorApplicationId: message.author.id,
      channelId: channel.id,
      guildId: channel.guild.id,
      messageId: message.id,
      observedAt: new Date().toISOString(),
      projectionMarker: expectedMarker,
      projectionKind: input.kind,
    };
  }

  public async sendQuestion(input: {
    readonly channelId: string;
    readonly replyToMessageId: string;
    readonly text: string;
  }): Promise<HistoricalReplyQuestionReceipt> {
    const channel = await this.#replyChannel(input.channelId);
    const target = await channel.messages.fetch(input.replyToMessageId);
    const question = await target.reply({
      allowedMentions: { parse: [], repliedUser: false },
      content: input.text,
      failIfNotExists: true,
    });
    return questionReceipt(question, input.replyToMessageId);
  }

  public async awaitAnswer(input: {
    readonly afterMessageId: string;
    readonly channelId: string;
    readonly replyToQuestionMessageId: string;
    readonly sutApplicationId: string;
  }): Promise<HistoricalReplyAnswerReceipt> {
    const channel = await this.#replyChannel(input.channelId);
    return awaitHistoricalAnswerSnapshot({
      afterMessageId: input.afterMessageId,
      answerTimeoutMilliseconds: this.options.answerTimeoutMilliseconds,
      fetchMatchingAnswers: async (afterMessageId) => {
        const messages = await channel.messages.fetch({ after: afterMessageId, limit: 100 });
        const matches = messages.filter((message) =>
          message.author.id === input.sutApplicationId &&
          message.reference?.messageId === input.replyToQuestionMessageId
        );
        return matches.map((answer) => {
          const description = descriptionFromHistoricalDiscordAnswerPayload({
            attachmentCount: answer.attachments.size,
            componentCount: answer.components.length,
            content: answer.content,
            embeds: answer.embeds.map((embed) => embed.toJSON()),
            expectedMarkerUrl: historicalAnswerMarkerUrl(input.replyToQuestionMessageId),
            hasActivity: answer.activity !== null,
            hasCall: answer.call !== null,
            hasInteraction: answer.interactionMetadata !== null,
            hasPoll: answer.poll !== null,
            hasRoleSubscriptionData: answer.roleSubscriptionData !== null,
            hasThread: answer.thread !== null,
            messageSnapshotCount: answer.messageSnapshots.size,
            stickerCount: answer.stickers.size,
          });
          return {
            authorApplicationId: answer.author.id,
            channelId: channel.id,
            createdAt: answer.createdAt.toISOString(),
            description,
            messageId: answer.id,
            replyToMessageId: answer.reference?.messageId ?? "",
          };
        });
      },
      now: Date.now,
      pollIntervalMilliseconds: this.options.pollIntervalMilliseconds,
      quietWindowMilliseconds: this.options.quietWindowMilliseconds,
      wait: (milliseconds) => new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      }),
    });
  }

  public async close(): Promise<void> {
    await this.#client.destroy();
  }

  public observeDurableOutcome(
    questionId: string,
  ): Promise<HistoricalReplyDurableQuestionOutcomeV1> {
    return this.options.observeQuestionOutcome(questionId);
  }

  public observeDurableAdmission(
    questionId: string,
  ): Promise<HistoricalReplyDurableQuestionAdmissionV1> {
    return this.options.observeQuestionAdmission(questionId);
  }

  public observeDurableSettlement(
    questionId: string,
  ): Promise<HistoricalReplyDurableSettlementV1> {
    return this.options.observeQuestionSettlement(questionId);
  }

  public observeCrashReceipts(): Promise<readonly HistoricalReplyCrashReceiptV1[]> {
    return this.options.observeCrashReceipts();
  }

  public async observePrivateScopeAnswers(input: GovernedCampaignObservationInput) {
    return observeGovernedPrivateCampaign(
      input, createDiscordJsGovernedCampaignObservationPort(this.#client),
    );
  }

  async #replyChannel(channelId: string): Promise<ReplyChannel> {
    const channel = await this.#client.channels.fetch(channelId);
    if (channel?.type !== ChannelType.GuildText &&
      channel?.type !== ChannelType.GuildAnnouncement &&
      channel?.type !== ChannelType.PublicThread &&
      channel?.type !== ChannelType.AnnouncementThread &&
      channel?.type !== ChannelType.PrivateThread) {
      throw new Error("Historical reply target must be a private-guild text container");
    }
    if (channel.isThread() && channel.parentId === null) {
      throw new Error("Historical reply thread has no authoritative parent channel");
    }
    return channel;
  }
}

function historicalAnswerMarkerUrl(questionId: string): string {
  const marker = `meeting-knowledge-answer:v1:${questionId}`;
  const digest = createHash("sha256").update(marker, "utf8").digest("hex");
  return `https://discord-meeting.invalid/knowledge-answer/${digest}`;
}

function questionReceipt(
  question: Message,
  replyToMessageId: string,
): HistoricalReplyQuestionReceipt {
  return {
    authorApplicationId: question.author.id,
    channelId: question.channelId,
    createdAt: question.createdAt.toISOString(),
    messageId: question.id,
    replyToMessageId,
  };
}
