import type {
  AdmitCurrentFinalReply,
  AnswerPublicationPort,
  QuestionAdmissionCommitPort,
  QuestionJobStore,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  Client,
  type Message,
  type PartialMessage,
} from "discord.js";

import {
  encodeDiscordExternalPublicationId,
} from "./discord-projection.js";
import { DiscordQuestionPrincipalCodec } from "./discord-question-principal.js";

export interface DiscordQuestionScopePort {
  resultsContainerForGuild(guildId: string): Promise<string | null>;
}

export interface DiscordLocalFinalReplyHandlerOptions {
  readonly principalTtlSeconds: number;
}

export class DiscordLocalFinalReplyHandler {
  private readonly admission: Pick<AdmitCurrentFinalReply, "execute">;
  private readonly admissions: Pick<QuestionAdmissionCommitPort, "withdrawProjection">;
  private readonly client: Client;
  private readonly jobs: Pick<QuestionJobStore, "cancelQuestion" | "hasActiveQuestion">;
  private readonly nowMilliseconds: () => number;
  private readonly options: DiscordLocalFinalReplyHandlerOptions;
  private readonly publication: Pick<AnswerPublicationPort, "cancelBeforeRequest">;
  private readonly principals: DiscordQuestionPrincipalCodec;
  private readonly reportError: (error: unknown) => void;
  private readonly scopes: DiscordQuestionScopePort;
  private started = false;
  private readonly onCreate = (message: Message): void => {
    void this.handleCreate(message).catch(this.reportError);
  };
  private readonly onDelete = (message: Message | PartialMessage): void => {
    void this.handleDelete(message).catch(this.reportError);
  };
  private readonly onUpdate = (
    _previous: Message | PartialMessage,
    message: Message | PartialMessage,
  ): void => {
    void this.cancelQuestion(message.id).catch(this.reportError);
  };

  public constructor(input: {
    readonly admission: Pick<AdmitCurrentFinalReply, "execute">;
    readonly admissions: Pick<QuestionAdmissionCommitPort, "withdrawProjection">;
    readonly client: Client;
    readonly jobs: Pick<QuestionJobStore, "cancelQuestion" | "hasActiveQuestion">;
    readonly nowMilliseconds?: () => number;
    readonly options: DiscordLocalFinalReplyHandlerOptions;
    readonly principals: DiscordQuestionPrincipalCodec;
    readonly publication: Pick<AnswerPublicationPort, "cancelBeforeRequest">;
    readonly reportError?: (error: unknown) => void;
    readonly scopes: DiscordQuestionScopePort;
  }) {
    this.admission = input.admission;
    this.admissions = input.admissions;
    this.client = input.client;
    this.jobs = input.jobs;
    this.nowMilliseconds = input.nowMilliseconds ?? Date.now;
    this.options = input.options;
    this.principals = input.principals;
    this.publication = input.publication;
    this.reportError = input.reportError ?? (() => {});
    this.scopes = input.scopes;
    if (
      !Number.isSafeInteger(input.options.principalTtlSeconds) ||
      input.options.principalTtlSeconds < 60 ||
      input.options.principalTtlSeconds > 3_600
    ) {
      throw new RangeError("Discord question principal TTL is outside the admitted range");
    }
  }

  public start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.client.on("messageCreate", this.onCreate);
    this.client.on("messageDelete", this.onDelete);
    this.client.on("messageUpdate", this.onUpdate);
  }

  public close(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.client.off("messageCreate", this.onCreate);
    this.client.off("messageDelete", this.onDelete);
    this.client.off("messageUpdate", this.onUpdate);
  }

  private async handleCreate(message: Message): Promise<void> {
    const guildId = message.guildId;
    const referencedMessageId = message.reference?.messageId;
    const questionText = message.content.trim();
    if (
      guildId === null ||
      message.author.bot ||
      message.webhookId !== null ||
      referencedMessageId === undefined ||
      questionText.length === 0 ||
      questionText.length > 2_000 ||
      (message.reference?.channelId !== undefined &&
        message.reference.channelId !== message.channelId)
    ) {
      return;
    }
    const resultsContainer = await this.scopes.resultsContainerForGuild(guildId);
    if (resultsContainer === null || resultsContainer !== message.channelId) {
      return;
    }
    const authorizationPrincipalRef = this.principals.issue({
      actorId: message.author.id,
      containerId: message.channelId,
      expiresAtMilliseconds: this.nowMilliseconds() +
        this.options.principalTtlSeconds * 1_000,
      scopeId: guildId,
    });
    await this.admission.execute({
      authorizationPrincipalRef,
      finalProjectionReceipt: encodeDiscordExternalPublicationId({
        kind: "channel-message",
        messageId: referencedMessageId,
        parentChannelId: message.channelId,
      }),
      projectionTargetContainerId: message.channelId,
      questionHash: this.principals.questionHash(questionText),
      questionId: message.id,
      questionText,
      requesterSubject: this.principals.keyedSubject(message.author.id, guildId),
      schemaVersion: 1,
      scopeId: guildId,
    });
  }

  private async handleDelete(message: Message | PartialMessage): Promise<void> {
    const wasQuestion = await this.jobs.hasActiveQuestion(message.id);
    await this.cancelQuestion(message.id);
    if (wasQuestion) {
      return;
    }
    if (message.guildId === null) {
      return;
    }
    const resultsContainer = await this.scopes.resultsContainerForGuild(message.guildId);
    if (resultsContainer !== message.channelId) {
      return;
    }
    const affectedQuestions = await this.admissions.withdrawProjection({
      projectionTargetContainerId: message.channelId,
      remoteMessageId: message.id,
    });
    for (const questionId of affectedQuestions) {
      await this.publication.cancelBeforeRequest({
        questionId,
        reason: "binding_drift",
      });
      await this.jobs.cancelQuestion(questionId);
    }
  }

  private async cancelQuestion(questionId: string): Promise<void> {
    await this.publication.cancelBeforeRequest({
      questionId,
      reason: "binding_drift",
    });
    await this.jobs.cancelQuestion(questionId);
  }
}
