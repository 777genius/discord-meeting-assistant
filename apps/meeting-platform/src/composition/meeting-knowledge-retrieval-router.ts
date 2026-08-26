import { PersistedFocusedMemoryRetrievalV2, SameRoomFocusedMemoryRetrieval,
  type CanonicalEvidenceTurnHashPort, type FocusedMemoryRetrievalPort,
  type HistoricalFocusedLocatorRetrievalV2, type HistoricalFocusedRetrieval } from
  "@discord-meeting/meeting-core/meeting-knowledge";

/** Keeps legacy and V2 engines mutually exclusive for one persisted job. */
export class PersistedRetrievalBindingRouter implements FocusedMemoryRetrievalPort {
  public constructor(
    private readonly legacy: FocusedMemoryRetrievalPort,
    private readonly v2: FocusedMemoryRetrievalPort | undefined,
  ) {}

  public retrieve(input: Parameters<FocusedMemoryRetrievalPort["retrieve"]>[0]) {
    return input.retrievalBinding?.retrievalPath === "infinity_locator_v2"
      ? this.v2?.retrieve(input) ?? Promise.resolve({
          schemaVersion: 1 as const,
          status: "unavailable" as const,
        })
      : this.legacy.retrieve(input);
  }

  public reauthorizeHistoricalEvidence(input: {
    readonly authorizationPrincipalRef: string;
    readonly roomId: string;
    readonly scopeId: string;
  }): Promise<boolean> {
    return this.v2?.reauthorizeHistoricalEvidence?.(input) ??
      this.legacy.reauthorizeHistoricalEvidence?.(input) ?? Promise.resolve(false);
  }
}

export function createPersistedFocusedMemoryRoute(input: {
  readonly current: FocusedMemoryRetrievalPort;
  readonly historicalServingAuthorized: () => boolean;
  readonly legacyHistorical?: Pick<HistoricalFocusedRetrieval,
    "buildPlan" | "reauthorizeRoom">;
  readonly remoteSearchAvailable: () => boolean;
  readonly retrievalV2Historical?: HistoricalFocusedLocatorRetrievalV2;
  readonly turnHashes: CanonicalEvidenceTurnHashPort;
}): FocusedMemoryRetrievalPort {
  const legacy = input.legacyHistorical === undefined
    ? input.current
    : new SameRoomFocusedMemoryRetrieval({
        current: input.current,
        historical: input.legacyHistorical,
        turnHashes: input.turnHashes,
      }, {
        historicalServingAuthorized: input.historicalServingAuthorized,
        remoteSearchAvailable: input.remoteSearchAvailable,
      });
  const v2 = input.retrievalV2Historical === undefined
    ? undefined
    : new PersistedFocusedMemoryRetrievalV2({
        current: input.current,
        historical: input.retrievalV2Historical,
      });
  return new PersistedRetrievalBindingRouter(legacy, v2);
}
