import { HmacHistoricalOpaqueIds, InfinityContextRetrievalV2Adapter } from
  "@discord-meeting/infinity-context-adapter";
import { HistoricalFocusedLocatorRetrievalV2,
  PrepareFocusedLocatorRetrievalV2Request,
  DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE,
  type FocusedLocatorRetrievalV2ProviderBinding,
  type HistoricalAuthorizationPort, type HistoricalOpaqueIdPort,
  type LegacyHistoricalReceiptVerifierPort,
  type IdentitySkeletonPortV1,
  type RetrievalActorAliasOwnerV1,
  type RetrievalActorReferenceAuthorityV1,
  type TwoHourHistoricalRetrievalProfileV1 } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { PostgresHistoricalRoomAuthoritySnapshot,
  canonicalFinalReplyTurnHash } from "@discord-meeting/postgres-adapter";
import type { Pool } from "pg";

import type { PlatformConfig } from "../config.js";
export class InfinityRetrievalV2Composition {
  readonly #ids: HistoricalOpaqueIdPort;
  readonly #retrieval: InfinityContextRetrievalV2Adapter;

  public constructor(private readonly input: {
    readonly baseUrl: string;
    readonly operationTimeoutMs: number;
    readonly actorKeysForSpeaker: (speakerId: string) => readonly string[];
    readonly actorReferences: RetrievalActorReferenceAuthorityV1;
    readonly legacyVerifier?: LegacyHistoricalReceiptVerifierPort;
    readonly pool: Pool;
    readonly requestTimeoutMs: number;
    readonly servingAuthorized: () => boolean;
    readonly ids: HistoricalOpaqueIdPort;
    readonly identitySkeletons: IdentitySkeletonPortV1;
    readonly speakerAliases: readonly RetrievalActorAliasOwnerV1[];
    readonly token: string;
    readonly twoHourProfile: TwoHourHistoricalRetrievalProfileV1;
  }) {
    this.#ids = input.ids;
    this.#retrieval = new InfinityContextRetrievalV2Adapter({
      baseUrl: input.baseUrl,
      operationTimeoutMs: Math.min(input.operationTimeoutMs, 4_000),
      requestTimeoutMs: Math.min(input.requestTimeoutMs, 2_000),
      token: () => input.token,
    });
  }

  public admission(binding: FocusedLocatorRetrievalV2ProviderBinding) {
    return new PrepareFocusedLocatorRetrievalV2Request({
      ids: this.#ids,
      identitySkeletons: this.input.identitySkeletons,
      actorReferences: this.input.actorReferences,
      providerBinding: binding,
      servingAuthorized: this.input.servingAuthorized,
      speakerAliases: this.input.speakerAliases,
      snapshot: new PostgresHistoricalRoomAuthoritySnapshot(this.input.pool, undefined, this.input.legacyVerifier),
    });
  }

  public retrieval(authorization: HistoricalAuthorizationPort) {
    return new HistoricalFocusedLocatorRetrievalV2({
      actorKeysForSpeaker: this.input.actorKeysForSpeaker,
      authorization,
      ids: this.#ids,
      retrieval: this.#retrieval,
      servingAuthorized: this.input.servingAuthorized,
      snapshot: new PostgresHistoricalRoomAuthoritySnapshot(this.input.pool, undefined, this.input.legacyVerifier),
      turnHashes: { hash: canonicalFinalReplyTurnHash },
    }, this.input.twoHourProfile);
  }
}

export function createInfinityRetrievalV2Composition(
  config: PlatformConfig,
  pool: Pool,
  token: string,
  ids: HistoricalOpaqueIdPort,
  authority: {
    readonly actorReferences: RetrievalActorReferenceAuthorityV1;
    readonly legacyVerifier?: LegacyHistoricalReceiptVerifierPort;
    readonly actorKeysForSpeaker: (speakerId: string) => readonly string[];
    readonly identitySkeletons: IdentitySkeletonPortV1;
    readonly servingAuthorized: () => boolean;
    readonly speakerAliases: readonly RetrievalActorAliasOwnerV1[];
  },
) {
  const infinity = config.infinityContext;
  if (infinity === undefined) {
    throw new Error("Infinity configuration is required for Retrieval V2");
  }
  const twoHourProfile = Object.freeze({
    ...DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE,
    qualification: config.meetingKnowledge?.twoHourHistoricalQualification ?? null,
  });
  return Object.freeze({
    retrievalV2: new InfinityRetrievalV2Composition({
      baseUrl: infinity.baseUrl,
      actorReferences: authority.actorReferences,
      ...(authority.legacyVerifier === undefined ? {} : { legacyVerifier: authority.legacyVerifier }),
      actorKeysForSpeaker: authority.actorKeysForSpeaker,
      operationTimeoutMs: infinity.operationTimeoutMs,
      ids,
      identitySkeletons: authority.identitySkeletons,
      pool,
      requestTimeoutMs: infinity.requestTimeoutMs,
      servingAuthorized: authority.servingAuthorized,
      speakerAliases: authority.speakerAliases,
      token,
      twoHourProfile,
    }),
    twoHourProfile,
  });
}

export function createActorKeyBoundHistoricalIds(
  topologyKey: string,
  actorKeyProfileId: string,
): HmacHistoricalOpaqueIds {
  return new HmacHistoricalOpaqueIds(topologyKey, actorKeyProfileId);
}
