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

export const discordParticipantQuestionPolicyVersion =
  "discord.participant-current-results.v2" as const;

const observationTtlMilliseconds = 30_000;

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

export async function abortableDiscordOperation<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  if (signal === undefined) {
    return operation();
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(signal.reason);
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
    readonly expectedContainerId: string;
    readonly expectedScopeId: string;
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
        return { reason: "denied", status: "denied" };
      }
      const permissions = await freshDiscordContainerPermissions(
        channel,
        member,
        undefined,
        this.operations,
      );
      if (permissions === null) {
        return { reason: "denied", status: "denied" };
      }
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
    } catch {
      return { reason: "unavailable", status: "denied" };
    }
  }
}
