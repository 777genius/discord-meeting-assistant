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
  decodeDiscordExternalPublicationId,
  encodeDiscordExternalPublicationId,
} from "./discord-projection.js";
import { DiscordQuestionPrincipalCodec } from "./discord-question-principal.js";
import { isExplicitDiscordAbsence, reconciliationPrincipalMatches,
  reconciliationProjectionMatchesChannel } from
  "./discord-question-reconciliation-classification.js";

export interface DiscordQuestionScopePort {
  resultsContainerForGuild(guildId: string): Promise<string | null>;
}

export interface DiscordLocalFinalReplyHandlerOptions {
  readonly e2eSyntheticHumanAuthorIds?: readonly string[];
  readonly principalTtlSeconds: number;
}

export class DiscordLocalFinalReplyHandler {
  private readonly admission: Pick<AdmitCurrentFinalReply, "execute">;
  private readonly admissions: Pick<QuestionAdmissionCommitPort, "withdrawProjection"> &
    Partial<Pick<QuestionAdmissionCommitPort, "recordQuestionMutation">>;
  private readonly client: Client;
  private readonly jobs: Pick<QuestionJobStore, "cancelQuestion" |
    "hasActiveQuestion" | "listActiveQuestionsForReconciliation" |
    "loadQuestionReconciliationCursor" | "saveQuestionReconciliationCursor" |
    "convergeDeliveredQuestion">;
  private readonly nowMilliseconds: () => number;
  private readonly options: DiscordLocalFinalReplyHandlerOptions;
  private readonly e2eSyntheticHumanAuthorIds: ReadonlySet<string>;
  private readonly publication: Pick<AnswerPublicationPort, "cancelBeforeRequest">;
  private readonly principals: DiscordQuestionPrincipalCodec;
  private readonly reportError: (error: unknown) => void;
  private readonly scopes: DiscordQuestionScopePort;
  private readonly pending = new Set<Promise<void>>();
  private readonly questionLanes = new Map<string, Promise<void>>();
  private reconciling: Promise<void> | undefined;
  private started = false;
  private readonly onCreate = (message: Message): void => {
    this.enqueue(message.id, () => this.handleCreate(message));
  };
  private readonly onDelete = (message: Message | PartialMessage): void => {
    this.enqueue(message.id, () => this.handleDelete(message));
  };
  private readonly onUpdate = (
    _previous: Message | PartialMessage,
    message: Message | PartialMessage,
  ): void => {
    this.enqueue(message.id, async () => {
      await this.recordMutation("edit", message.id);
      await this.cancelQuestion(message.id);
    });
  };

  public constructor(input: {
    readonly admission: Pick<AdmitCurrentFinalReply, "execute">;
    readonly admissions: Pick<QuestionAdmissionCommitPort, "withdrawProjection"> &
      Partial<Pick<QuestionAdmissionCommitPort, "recordQuestionMutation">>;
    readonly client: Client;
    readonly jobs: Pick<QuestionJobStore, "cancelQuestion" |
      "hasActiveQuestion" | "listActiveQuestionsForReconciliation" |
      "loadQuestionReconciliationCursor" | "saveQuestionReconciliationCursor" |
      "convergeDeliveredQuestion">;
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
    const e2eSyntheticHumanAuthorIds =
      input.options.e2eSyntheticHumanAuthorIds ?? [];
    if (
      e2eSyntheticHumanAuthorIds.length > 128 ||
      new Set(e2eSyntheticHumanAuthorIds).size !==
        e2eSyntheticHumanAuthorIds.length ||
      e2eSyntheticHumanAuthorIds.some(
        (actorId) => !/^\d{17,20}$/u.test(actorId),
      )
    ) {
      throw new RangeError("Discord E2E synthetic human authors are invalid");
    }
    this.e2eSyntheticHumanAuthorIds = new Set(e2eSyntheticHumanAuthorIds);
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
    this.track(this.reconcilePending());
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

  public async settle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled(this.pending);
    }
  }

  /** One bounded, cursor-backed pass; unavailable Discord reads retry next period. */
  public reconcilePending(): Promise<void> {
    if (!this.started) {return Promise.resolve();}
    this.reconciling ??= this.reconcileActiveQuestions().finally(() => {
      this.reconciling = undefined;
    });
    return this.reconciling;
  }

  private async handleCreate(message: Message): Promise<void> {
    const guildId = message.guildId;
    const referencedMessageId = message.reference?.messageId;
    const questionText = message.content.trim();
    if (
      guildId === null ||
      (message.author.bot &&
        !this.e2eSyntheticHumanAuthorIds.has(message.author.id)) ||
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
    if (resultsContainer === null) {
      return;
    }
    const location = canonicalProjectionLocation(message, resultsContainer);
    if (location === null) {
      return;
    }
    const authorizationPrincipalRef = this.principals.issue({
      actorId: message.author.id,
      authorizationContainerId: message.channelId,
      containerId: resultsContainer,
      expiresAtMilliseconds: this.nowMilliseconds() +
        this.options.principalTtlSeconds * 1_000,
      scopeId: guildId,
    });
    await this.admission.execute({
      authorizationPrincipalRef,
      deliveryContainerId: message.channelId,
      finalProjectionReceipt: encodeDiscordExternalPublicationId({
        ...location.reference,
        messageId: referencedMessageId,
      }),
      projectionTargetContainerId: resultsContainer,
      questionHash: this.principals.questionHash(questionText),
      questionId: message.id,
      questionText,
      requesterSubject: this.principals.keyedSubject(message.author.id, guildId),
      schemaVersion: 2,
      scopeId: guildId,
    });
  }

  private async handleDelete(message: Message | PartialMessage): Promise<void> {
    await this.recordMutation("delete", message.id);
    const wasQuestion = await this.jobs.hasActiveQuestion(message.id);
    await this.cancelQuestion(message.id);
    if (wasQuestion) {
      return;
    }
    const botUserId = this.client.user?.id;
    const deletedAuthorId = message.author?.id;
    if (
      botUserId === undefined ||
      (deletedAuthorId !== undefined && deletedAuthorId !== botUserId)
    ) {
      return;
    }
    if (message.guildId === null) {
      return;
    }
    const resultsContainer = await this.scopes.resultsContainerForGuild(message.guildId);
    if (resultsContainer === null) {
      return;
    }
    const location = canonicalProjectionLocation(message, resultsContainer);
    if (location === null) {
      return;
    }
    const affectedQuestions = await this.admissions.withdrawProjection({
      finalProjectionReceipt: encodeDiscordExternalPublicationId({
        ...location.reference,
        messageId: message.id,
      }),
    });
    for (const questionId of affectedQuestions) {
      await this.jobs.cancelQuestion(questionId);
      await this.publication.cancelBeforeRequest({
        questionId,
        reason: "binding_drift",
      });
    }
  }

  private async cancelQuestion(questionId: string): Promise<void> {
    await this.jobs.cancelQuestion(questionId);
    await this.publication.cancelBeforeRequest({
      questionId,
      reason: "binding_drift",
    });
  }

  private track(operation: Promise<void>): void {
    const tracked = operation.catch(this.reportError).finally(() => {
      this.pending.delete(tracked);
    });
    this.pending.add(tracked);
  }

  private enqueue(questionId: string, operation: () => Promise<void>): void {
    this.track(this.runQuestionLane(questionId, operation));
  }

  private runQuestionLane<T>(
    questionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const predecessor = this.questionLanes.get(questionId) ?? Promise.resolve();
    const queued = predecessor.catch(() => {}).then(operation);
    const laneCompletion = queued.then(() => {return;}, () => {return;});
    this.questionLanes.set(questionId, laneCompletion);
    return queued.finally(() => {
      if (this.questionLanes.get(questionId) === laneCompletion) {
        this.questionLanes.delete(questionId);
      }
    });
  }

  private async reconcileActiveQuestions(): Promise<void> {
    const list = this.jobs.listActiveQuestionsForReconciliation;
    if (list === undefined) {return;}
    const afterQuestionId = await this.jobs.loadQuestionReconciliationCursor?.() ?? null;
    if (!this.started) {return;}
    const questions = await list.call(this.jobs, {
      afterQuestionId,
      maximumRows: 100,
    });
    let processedAfterQuestionId = afterQuestionId;
    let unavailable = false;
    for (const question of questions) {
      if (question.reconciliationDisposition === "quarantined" ||
        question.deliveryContainerId === null) {
        processedAfterQuestionId = question.questionId;
        continue;
      }
      const status = await this.runQuestionLane(question.questionId, async () => {
        const observedStatus = await this.reconciliationStatus({ ...question,
          deliveryContainerId: question.deliveryContainerId! });
        if (observedStatus === "current") {
          await this.jobs.convergeDeliveredQuestion?.(question.questionId);
          return observedStatus;
        }
        if (observedStatus === "unavailable") {return observedStatus;}
        await this.recordMutation(observedStatus, question.questionId);
        await this.cancelQuestion(question.questionId);
        return observedStatus;
      });
      if (status === "unavailable") {
        unavailable = true;
        break;
      }
      processedAfterQuestionId = question.questionId;
    }
    const nextCursor = unavailable ? processedAfterQuestionId :
      questions.length === 100 ? processedAfterQuestionId : null;
    const saveCursor = this.jobs.saveQuestionReconciliationCursor;
    if (saveCursor !== undefined && !await saveCursor.call(this.jobs, {
      expectedAfterQuestionId: afterQuestionId,
      nextAfterQuestionId: nextCursor,
    })) {
      // Another owner won this bounded page. Its durable cursor is the next
      // invocation's authority; this owner must not scan past it.
      return;
    }
  }

  private async reconciliationStatus(question: {
    readonly authorizationPrincipalRef: string | null;
    readonly botApplicationIdentity: string | null;
    readonly deliveryContainerId: string;
    readonly finalProjectionReceipt: string;
    readonly questionHash: string;
    readonly questionId: string;
    readonly requesterSubject: string;
    readonly scopeId: string;
  }): Promise<"current" | "delete" | "edit" | "unavailable"> {
    const principal = question.authorizationPrincipalRef === null
      ? null : this.principals.resolve(question.authorizationPrincipalRef);
    const projection = decodeDiscordExternalPublicationId(
      question.finalProjectionReceipt,
    );
    if (projection === undefined || !reconciliationPrincipalMatches(
      principal, question, this.principals,
    )) {
      return "edit";
    }
    try {
      const channel = await this.client.channels.fetch(question.deliveryContainerId, {
        force: true,
      });
      return await this.inspectReconciliationChannel(
        channel, principal, projection, question,
      );
    } catch (error) {
      return isExplicitDiscordAbsence(error) ? "delete" : "unavailable";
    }
  }

  private async inspectReconciliationChannel(
    channel: Awaited<ReturnType<Client["channels"]["fetch"]>>,
    principal: ReturnType<DiscordQuestionPrincipalCodec["resolve"]>,
    projection: NonNullable<ReturnType<typeof decodeDiscordExternalPublicationId>>,
    question: { readonly botApplicationIdentity: string | null;
      readonly questionHash: string; readonly questionId: string;
      readonly requesterSubject: string; readonly scopeId: string },
  ): Promise<"current" | "edit" | "unavailable"> {
    if (channel === null) {return "unavailable";}
    if (!channel.isTextBased() || !("messages" in channel) ||
      !reconciliationProjectionMatchesChannel(channel, projection)) {
      return "edit";
    }
    const live = await channel.messages.fetch({ cache: false, force: true,
      message: question.questionId });
    if ((principal !== null && live.author.id !== principal.actorId) ||
      this.principals.keyedSubject(live.author.id, question.scopeId) !==
        question.requesterSubject || live.webhookId !== null ||
      this.principals.questionHash(live.content.trim()) !== question.questionHash ||
      live.reference?.messageId !== projection.messageId) {
      return "edit";
    }
    const reference = await channel.messages.fetch({ cache: false, force: true,
      message: projection.messageId });
    return reference.author.id ===
      (question.botApplicationIdentity ?? this.client.user?.id) &&
      reference.webhookId === null ? "current" : "edit";
  }

  private async recordMutation(
    kind: "delete" | "edit",
    questionId: string,
  ): Promise<void> {
    const record = this.admissions.recordQuestionMutation;
    if (record !== undefined) {
      await record.call(this.admissions, { kind, questionId,
        retentionSeconds: 86_400 });
    }
  }
}

function canonicalProjectionLocation(
  message: Message | PartialMessage,
  resultsContainerId: string,
): {
  readonly reference:
    | { readonly kind: "channel-message"; readonly parentChannelId: string }
    | { readonly kind: "thread"; readonly threadId: string };
} | null {
  if (message.channel.isThread()) {
    return message.channel.parentId === resultsContainerId
      ? { reference: { kind: "thread", threadId: message.channelId } }
      : null;
  }
  return message.channelId === resultsContainerId
    ? {
      reference: {
        kind: "channel-message",
        parentChannelId: resultsContainerId,
      },
    }
    : null;
}
