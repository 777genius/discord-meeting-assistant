import type {
  HistoricalAuthorizationObservationV1,
  HistoricalAuthorizationPort,
  HistoricalAuthorizationRequestV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { Client } from "discord.js";

import {
  BoundedDiscordAuthorizationQueue,
  discordParticipantQuestionPolicyVersion,
  freshDiscordContainerPermissions,
} from "./discord-question-authorization.js";
import { DiscordQuestionPrincipalCodec } from "./discord-question-principal.js";

export const discordSameRoomHistoricalPolicyVersion =
  "discord.participant-same-room-history.v2" as const;

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
    private readonly operations = new BoundedDiscordAuthorizationQueue(),
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
      const guild = await this.operations.execute(request.signal, () =>
        this.client.guilds.fetch(principal.scopeId)
      );
      await this.operations.execute(request.signal, () => guild.roles.fetch());
      const [member, principalContainer, sourceRoom] = await Promise.all([
        this.operations.execute(request.signal, () =>
          guild.members.fetch({ force: true, user: principal.actorId })
        ),
        this.operations.execute(request.signal, () =>
          guild.channels.fetch(principal.authorizationContainerId, { force: true })
        ),
        principal.authorizationContainerId === request.roomId
          ? this.operations.execute(request.signal, () =>
              guild.channels.fetch(principal.authorizationContainerId, { force: true })
            )
          : this.operations.execute(request.signal, () =>
              guild.channels.fetch(request.roomId, { force: true })
            ),
      ]);
      if (principalContainer === null || sourceRoom === null) {
        return denied();
      }
      const [principalPermissions, sourcePermissions] = await Promise.all([
        freshDiscordContainerPermissions(
          principalContainer,
          member,
          request.signal,
          this.operations,
        ),
        principalContainer.id === sourceRoom.id
          ? Promise.resolve(null)
          : freshDiscordContainerPermissions(
              sourceRoom,
              member,
              request.signal,
              this.operations,
            ),
      ]);
      const effectiveSourcePermissions = principalContainer.id === sourceRoom.id
        ? principalPermissions
        : sourcePermissions;
      if (principalPermissions === null || effectiveSourcePermissions === null) {
        return denied();
      }
      const digest = this.principals.observationDigest(
        discordParticipantQuestionPolicyVersion,
        discordSameRoomHistoricalPolicyVersion,
        principal.actorId,
        principal.scopeId,
        principal.containerId,
        principal.authorizationContainerId,
        request.roomId,
        principalPermissions.bitfield.toString(),
        effectiveSourcePermissions.bitfield.toString(),
      );
      return {
        authorizationDigest: digest,
        authorizationEpoch: digest,
        authorized: true,
        policyVersion: discordSameRoomHistoricalPolicyVersion,
      };
    } catch {
      request.signal?.throwIfAborted();
      return denied();
    }
  }
}
