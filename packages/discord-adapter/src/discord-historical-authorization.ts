import type {
  HistoricalAuthorizationObservationV1,
  HistoricalAuthorizationPort,
  HistoricalAuthorizationRequestV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  Client,
  PermissionFlagsBits,
} from "discord.js";

import {
  discordParticipantQuestionPolicyVersion,
} from "./discord-question-authorization.js";
import { DiscordQuestionPrincipalCodec } from "./discord-question-principal.js";

export const discordSameRoomHistoricalPolicyVersion =
  "discord.participant-same-room-history.v1" as const;

function denied(): HistoricalAuthorizationObservationV1 {
  return {
    authorizationDigest: "denied",
    authorizationEpoch: "denied",
    authorized: false,
    policyVersion: discordSameRoomHistoricalPolicyVersion,
  };
}

/**
 * Rechecks both the principal's results container and the source voice room.
 * The encrypted principal identifies the requester; it never becomes evidence.
 */
export class DiscordHistoricalAuthorizationAdapter
  implements HistoricalAuthorizationPort
{
  public constructor(
    private readonly client: Client,
    private readonly principals: DiscordQuestionPrincipalCodec,
    private readonly nowMilliseconds: () => number = Date.now,
  ) {}

  public async authorize(
    request: HistoricalAuthorizationRequestV1,
  ): Promise<HistoricalAuthorizationObservationV1> {
    const principal = this.principals.resolve(request.authorizationPrincipalRef);
    if (
      principal === null ||
      principal.scopeId !== request.scopeId ||
      principal.expiresAtMilliseconds <= this.nowMilliseconds()
    ) {
      return denied();
    }
    try {
      const guild = await this.client.guilds.fetch(principal.scopeId);
      await guild.roles.fetch();
      const [member, principalContainer, sourceRoom] = await Promise.all([
        guild.members.fetch({ force: true, user: principal.actorId }),
        guild.channels.fetch(principal.containerId, { force: true }),
        principal.containerId === request.roomId
          ? guild.channels.fetch(principal.containerId, { force: true })
          : guild.channels.fetch(request.roomId, { force: true }),
      ]);
      if (principalContainer === null || sourceRoom === null) {
        return denied();
      }
      const principalPermissions = principalContainer.permissionsFor(member);
      const sourcePermissions = sourceRoom.permissionsFor(member);
      const required = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
      ];
      if (
        required.some((permission) => !principalPermissions.has(permission)) ||
        required.some((permission) => !sourcePermissions.has(permission))
      ) {
        return denied();
      }
      const digest = this.principals.observationDigest(
        discordParticipantQuestionPolicyVersion,
        discordSameRoomHistoricalPolicyVersion,
        principal.actorId,
        principal.scopeId,
        principal.containerId,
        request.roomId,
        principalPermissions.bitfield.toString(),
        sourcePermissions.bitfield.toString(),
      );
      return {
        authorizationDigest: digest,
        authorizationEpoch: digest,
        authorized: true,
        policyVersion: discordSameRoomHistoricalPolicyVersion,
      };
    } catch {
      return denied();
    }
  }
}
