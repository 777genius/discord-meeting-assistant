import type {
  QuestionAuthorizationObservation,
  QuestionAuthorizationPort,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  ChannelType,
  Client,
  type GuildBasedChannel,
  type GuildMember,
  PermissionFlagsBits,
  type PermissionsBitField,
} from "discord.js";

import { DiscordQuestionPrincipalCodec } from "./discord-question-principal.js";
import { decodeDiscordExternalPublicationId } from "./discord-projection.js";
import { isExplicitDiscordAbsence, isExplicitDiscordMemberAbsence } from
  "./discord-question-reconciliation-classification.js";

export const discordParticipantQuestionPolicyVersion =
  "discord.participant-current-results.v2" as const;

const observationTtlMilliseconds = 30_000;

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

async function abortableDiscordOperation<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  if (signal === undefined) {
    return operation();
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => {
      reject(signal.reason);
    };
    signal.addEventListener("abort", aborted, { once: true });
    void operation().then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", aborted);
    });
  });
}

/**
 * Keeps manager-backed Discord REST work bounded when discord.js does not expose
 * the REST AbortSignal on a manager fetch. Aborted queued work never starts;
 * one already-started operation retains the sole slot until it actually settles.
 */
export class BoundedDiscordAuthorizationQueue {
  private tail: Promise<void> = Promise.resolve();

  public async execute<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted();
    const predecessor = this.tail;
    let release!: () => void;
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = completion;
    try {
      await abortableDiscordOperation(signal, () => predecessor);
    } catch (error) {
      void predecessor.finally(release);
      throw error;
    }
    signal?.throwIfAborted();
    let inFlight: Promise<T>;
    try {
      inFlight = operation();
    } catch (error) {
      release();
      throw error;
    }
    void inFlight.then(release, release);
    return abortableDiscordOperation(signal, () => inFlight);
  }
}

/**
 * discord.js computes a private thread's base permissions from its parent but
 * does not prove that a non-manager is still a member of that thread. Fetching
 * the exact ThreadMember with cache disabled supplies the missing fresh fence.
 */
export async function freshDiscordContainerPermissions(
  channel: GuildBasedChannel,
  member: GuildMember,
  signal?: AbortSignal,
  operations = new BoundedDiscordAuthorizationQueue(),
): Promise<Readonly<PermissionsBitField> | null> {
  signal?.throwIfAborted();
  const permissions = channel.permissionsFor(member);
  if (
    !permissions.has(PermissionFlagsBits.ViewChannel) ||
    !permissions.has(PermissionFlagsBits.ReadMessageHistory)
  ) {
    return null;
  }
  if (
    channel.type === ChannelType.PrivateThread &&
    !permissions.has(PermissionFlagsBits.ManageThreads)
  ) {
    try {
      await operations.execute(signal, () => channel.members.fetch({
        cache: false,
        force: true,
        member: member.id,
      }));
      signal?.throwIfAborted();
    } catch {
      signal?.throwIfAborted();
      return null;
    }
  }
  return permissions;
}

async function observeFreshDiscordContainerPermissions(
  channel: GuildBasedChannel,
  member: GuildMember,
  operations: BoundedDiscordAuthorizationQueue,
): Promise<{ readonly permissions: Readonly<PermissionsBitField>;
    readonly status: "authorized" } | { readonly status: "denied" }> {
  const permissions = channel.permissionsFor(member);
  if (!permissions.has(PermissionFlagsBits.ViewChannel) ||
    !permissions.has(PermissionFlagsBits.ReadMessageHistory)) {
    return { status: "denied" };
  }
  if (channel.type === ChannelType.PrivateThread &&
    !permissions.has(PermissionFlagsBits.ManageThreads)) {
    try {
      await operations.execute(undefined, () => channel.members.fetch({
        cache: false, force: true, member: member.id,
      }));
    } catch (error) {
      if (isExplicitDiscordMemberAbsence(error)) {return { status: "denied" };}
      throw error;
    }
  }
  return { permissions, status: "authorized" };
}

export class DiscordQuestionAuthorizationAdapter
  implements QuestionAuthorizationPort
{
  public constructor(
    private readonly client: Client,
    private readonly principals: DiscordQuestionPrincipalCodec,
    private readonly nowMilliseconds: () => number = Date.now,
    private readonly operations = new BoundedDiscordAuthorizationQueue(),
  ) {}

  public async observe(input: {
    readonly authorizationPrincipalRef: string;
    readonly checkpoint?: Parameters<QuestionAuthorizationPort["observe"]>[0]["checkpoint"];
    readonly expectedContainerId: string;
    readonly expectedQuestion?: Parameters<QuestionAuthorizationPort["observe"]>[0][
      "expectedQuestion"
    ];
    readonly expectedScopeId: string;
    readonly questionId?: string;
  }): Promise<QuestionAuthorizationObservation> {
    const principal = this.principals.resolve(input.authorizationPrincipalRef);
    const now = this.nowMilliseconds();
    if (
      principal === null ||
      principal.scopeId !== input.expectedScopeId ||
      principal.containerId !== input.expectedContainerId ||
      principal.expiresAtMilliseconds <= now
    ) {
      return { reason: "expired", status: "denied" };
    }
    try {
      const guild = await this.operations.execute(undefined, () =>
        this.client.guilds.fetch(principal.scopeId)
      );
      await this.operations.execute(undefined, () => guild.roles.fetch());
      const [member, channel] = await Promise.all([
        this.operations.execute(undefined, () =>
          guild.members.fetch({ force: true, user: principal.actorId })
        ),
        this.operations.execute(undefined, () =>
          guild.channels.fetch(principal.authorizationContainerId, { force: true })
        ),
      ]);
      if (!isPresent(channel)) {
        return { reason: "unavailable", status: "denied" };
      }
      const permissionObservation = await observeFreshDiscordContainerPermissions(
        channel, member, this.operations,
      );
      if (permissionObservation.status === "denied") {
        return { reason: "denied", status: "denied" };
      }
      if (input.expectedQuestion !== undefined) {
        if (input.questionId === undefined) {
          return { reason: "denied", status: "denied" };
        }
        const exactQuestion = await this.exactQuestionIsCurrent(
          channel, principal, input.questionId, input.expectedQuestion,
        );
        if (exactQuestion !== "current") {
          return { reason: exactQuestion, status: "denied" };
        }
      }
      const permissions = permissionObservation.permissions;
      const observedAt = new Date(now).toISOString();
      const expiresAt = new Date(Math.min(
        principal.expiresAtMilliseconds,
        now + observationTtlMilliseconds,
      )).toISOString();
      return {
        actorId: principal.actorId,
        containerId: principal.containerId,
        deliveryContainerId: principal.authorizationContainerId,
        digest: this.principals.observationDigest(
          discordParticipantQuestionPolicyVersion,
          principal.actorId,
          principal.scopeId,
          principal.containerId,
          principal.authorizationContainerId,
          permissions.bitfield.toString(),
        ),
        expiresAt,
        observedAt,
        policyVersion: discordParticipantQuestionPolicyVersion,
        scopeId: principal.scopeId,
        source: "authoritative_remote",
        status: "authorized",
      };
    } catch (error) {
      return { reason: isExplicitDiscordMemberAbsence(error) ? "denied" :
        isExplicitDiscordAbsence(error) ? "absent" : "unavailable", status: "denied" };
    }
  }

  private async exactQuestionIsCurrent(
    channel: GuildBasedChannel,
    principal: NonNullable<ReturnType<DiscordQuestionPrincipalCodec["resolve"]>>,
    questionId: string,
    expected: NonNullable<Parameters<QuestionAuthorizationPort["observe"]>[0][
      "expectedQuestion"
    ]>,
  ): Promise<"absent" | "current" | "denied" | "unavailable"> {
    if (!channel.isTextBased() || !("messages" in channel) || !questionChannelMatches(
      channel, principal, expected, this.principals,
    )) {
      return "denied";
    }
    const projection = decodeDiscordExternalPublicationId(
      expected.finalProjectionReceipt,
    );
    if (!projectionTargetsChannel(projection, channel)) {
      return "denied";
    }
    try {
      const question = await this.operations.execute(undefined, () =>
        channel.messages.fetch({ cache: false, force: true, message: questionId })
      );
      if (question.author.id !== principal.actorId || question.webhookId !== null ||
        question.channelId !== expected.deliveryContainerId ||
        this.principals.questionHash(question.content.trim()) !== expected.questionHash ||
        question.reference?.messageId !== projection.messageId ||
        question.reference.channelId !== channel.id) {
        return "denied";
      }
      const referenced = await this.operations.execute(undefined, () =>
        channel.messages.fetch({ cache: false, force: true,
          message: projection.messageId })
      );
      return referenced.author.id === expected.botApplicationIdentity &&
        referenced.webhookId === null && referenced.channelId === channel.id
        ? "current" : "denied";
    } catch (error) {
      return isExplicitDiscordAbsence(error) ? "absent" : "unavailable";
    }
  }
}

function questionChannelMatches(
  channel: GuildBasedChannel,
  principal: NonNullable<ReturnType<DiscordQuestionPrincipalCodec["resolve"]>>,
  expected: NonNullable<Parameters<QuestionAuthorizationPort["observe"]>[0][
    "expectedQuestion"
  ]>,
  principals: DiscordQuestionPrincipalCodec,
): boolean {
  return channel.id === expected.deliveryContainerId &&
    principals.keyedSubject(principal.actorId, principal.scopeId) ===
      expected.requesterSubject;
}

function projectionTargetsChannel(
  projection: ReturnType<typeof decodeDiscordExternalPublicationId>,
  channel: GuildBasedChannel,
): projection is NonNullable<typeof projection> {
  return projection !== undefined && (projection.kind === "thread"
    ? channel.isThread() && projection.threadId === channel.id
    : !channel.isThread() && projection.parentChannelId === channel.id);
}
