import { HmacHistoricalOpaqueIds, InfinityContextRetrievalV2Adapter } from
  "@discord-meeting/infinity-context-adapter";
import { HistoricalFocusedLocatorRetrievalV2,
  PrepareFocusedLocatorRetrievalV2Request,
  DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE,
  type FocusedLocatorRetrievalV2ProviderBinding,
  type HistoricalAuthorizationPort, type SpeakerAliasMapV1,
  type TwoHourHistoricalRetrievalProfileV1 } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { PostgresHistoricalEvidenceAuthority, PostgresHistoricalMemoryStore,
  canonicalFinalReplyTurnHash } from "@discord-meeting/postgres-adapter";
import type { Pool } from "pg";

import type { PlatformConfig } from "../config.js";
import { participantSpeakerAliases } from
  "../config/participant-greeting-profiles.js";

export class InfinityRetrievalV2Composition {
  readonly #ids: HmacHistoricalOpaqueIds;
  readonly #retrieval: InfinityContextRetrievalV2Adapter;

  public constructor(private readonly input: {
    readonly baseUrl: string;
    readonly operationTimeoutMs: number;
    readonly pool: Pool;
    readonly requestTimeoutMs: number;
    readonly speakerAliases: SpeakerAliasMapV1;
    readonly token: string;
    readonly topologyKey: string;
    readonly twoHourProfile: TwoHourHistoricalRetrievalProfileV1;
  }) {
    this.#ids = new HmacHistoricalOpaqueIds(input.topologyKey);
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
      providerBinding: binding,
      speakerAliases: this.input.speakerAliases,
      store: new PostgresHistoricalMemoryStore(this.input.pool),
    });
  }

  public retrieval(authorization: HistoricalAuthorizationPort) {
    return new HistoricalFocusedLocatorRetrievalV2({
      authority: new PostgresHistoricalEvidenceAuthority(this.input.pool),
      authorization,
      ids: this.#ids,
      retrieval: this.#retrieval,
      store: new PostgresHistoricalMemoryStore(this.input.pool),
      turnHashes: { hash: canonicalFinalReplyTurnHash },
    }, this.input.twoHourProfile);
  }
}

export function createInfinityRetrievalV2Composition(
  config: PlatformConfig,
  pool: Pool,
  token: string,
  topologyKey: string,
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
      operationTimeoutMs: infinity.operationTimeoutMs,
      pool,
      requestTimeoutMs: infinity.requestTimeoutMs,
      speakerAliases: participantSpeakerAliases(config.participantGreetingProfiles),
      token,
      topologyKey,
      twoHourProfile,
    }),
    twoHourProfile,
  });
}
