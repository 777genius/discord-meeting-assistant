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

/**
 * discord.js computes a private thread's base permissions from its parent but
 * does not prove that a non-manager is still a member of that thread. Fetching
 * the exact ThreadMember with cache disabled supplies the missing fresh fence.
 */
export async function freshDiscordContainerPermissions(
  channel: GuildBasedChannel,
  member: GuildMember,
): Promise<Readonly<PermissionsBitField> | null> {
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
      await channel.members.fetch({
        cache: false,
        force: true,
        member: member.id,
      });
    } catch {
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
      const guild = await this.client.guilds.fetch(principal.scopeId);
      await guild.roles.fetch();
      const [member, channel] = await Promise.all([
        guild.members.fetch({ force: true, user: principal.actorId }),
        guild.channels.fetch(principal.authorizationContainerId, { force: true }),
      ]);
      if (!isPresent(channel)) {
        return { reason: "denied", status: "denied" };
      }
      const permissions = await freshDiscordContainerPermissions(channel, member);
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
