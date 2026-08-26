import {
  DiscordInfinityActorKeys,
  decodeDiscordInfinityActorKeyring,
} from "@discord-meeting/discord-adapter";
import { infinityContextHistoricalIndexProfileId } from
  "@discord-meeting/infinity-context-adapter";
import type { RetrievalActorAliasOwnerV1 } from
  "@discord-meeting/meeting-core/meeting-knowledge";

import type { PlatformConfig } from "../config.js";
import { createActorKeyBoundHistoricalIds } from "./infinity-retrieval-v2.js";

export function createDiscordInfinityActorCustody(
  config: PlatformConfig,
  topologyKey: string,
) {
  const encodedKeyring = config.secrets.meetingKnowledgeActorKeyring;
  if (encodedKeyring === undefined) {
    throw new Error("Discord actor-key mapping authority is required for Infinity");
  }
  const actorKeys = new DiscordInfinityActorKeys(
    decodeDiscordInfinityActorKeyring(encodedKeyring),
  );
  return Object.freeze({
    actorKeys,
    historicalIds: createActorKeyBoundHistoricalIds(
      topologyKey,
      actorKeys.activeProfileId(),
    ),
    speakerAliases: participantRetrievalAliasOwners(
      config.participantGreetingProfiles,
      actorKeys,
    ),
  });
}

function participantRetrievalAliasOwners(
  profiles: PlatformConfig["participantGreetingProfiles"],
  actorKeys: DiscordInfinityActorKeys,
): readonly RetrievalActorAliasOwnerV1[] {
  return Object.freeze(Object.entries(profiles).map(([participantId, profile]) =>
    Object.freeze({
      actorKeys: Object.freeze([...actorKeys.actorKeysForFilter(participantId)]),
      aliases: Object.freeze([...new Set([
        profile.displayName,
        profile.spokenName,
        participantId,
      ])]),
    })
  ));
}

export function requireHistoricalRuntimeSecrets(config: PlatformConfig): {
  readonly token: string;
  readonly topologyKey: string;
} {
  const token = config.secrets.infinityContextToken;
  const topologyKey = config.secrets.infinityContextTopologyKey;
  if (token === undefined || topologyKey === undefined) {
    throw new Error("Infinity runtime secrets are missing after configuration validation");
  }
  return { token, topologyKey };
}

export function configuredHistoricalIndexProfileId(
  activation: NonNullable<PlatformConfig["infinityContext"]>["activation"],
  actorKeyProfileId: string,
): string {
  const digest = activation.embeddingProfileAttestation
    ?.embeddingProfileDigestSha256 ?? "sha256:" + "0".repeat(64);
  return `${infinityContextHistoricalIndexProfileId(digest)}|${actorKeyProfileId}`;
}
