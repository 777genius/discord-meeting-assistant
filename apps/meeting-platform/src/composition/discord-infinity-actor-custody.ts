import {
  DiscordInfinityActorKeys,
  decodeDiscordInfinityActorKeyring,
} from "@discord-meeting/discord-adapter";
import { infinityContextHistoricalIndexProfileId } from
  "@discord-meeting/infinity-context-adapter";

import type { PlatformConfig } from "../config.js";
import { participantRetrievalActorAliases } from
  "../config/participant-greeting-profiles.js";
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
    speakerAliases: participantRetrievalActorAliases(
      config.participantGreetingProfiles,
      actorKeys,
    ),
  });
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
