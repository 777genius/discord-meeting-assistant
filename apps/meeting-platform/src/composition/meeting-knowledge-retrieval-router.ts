import { PersistedFocusedMemoryRetrievalV2,
  type FocusedMemoryRetrievalPort,
  type FocusedMemoryRetrievalResult,
  type HistoricalFocusedLocatorRetrievalV2 } from
  "@discord-meeting/meeting-core/meeting-knowledge";

/** Production serving has one constructible historical retrieval path: V2. */
export function createPersistedFocusedMemoryRoute(input: {
  readonly current: FocusedMemoryRetrievalPort;
  readonly retrievalV2Historical?: HistoricalFocusedLocatorRetrievalV2;
}): FocusedMemoryRetrievalPort {
  const retrievalV2 = input.retrievalV2Historical === undefined ? undefined
    : new PersistedFocusedMemoryRetrievalV2({
        current: input.current,
        historical: input.retrievalV2Historical,
      });
  return new BoundFocusedMemoryRetrieval(input.current, retrievalV2);
}

class BoundFocusedMemoryRetrieval implements FocusedMemoryRetrievalPort {
  public constructor(
    private readonly current: FocusedMemoryRetrievalPort,
    private readonly retrievalV2?: PersistedFocusedMemoryRetrievalV2,
  ) {}

  public retrieve(input: Parameters<FocusedMemoryRetrievalPort["retrieve"]>[0]):
  Promise<FocusedMemoryRetrievalResult> {
    if (input.retrievalBinding?.retrievalPath ===
      "canonical_local_exact_lexical_v1") {
      return this.current.retrieve(input);
    }
    if (input.retrievalBinding?.retrievalPath === "infinity_locator_v2" &&
      this.retrievalV2 !== undefined) {
      return this.retrievalV2.retrieve(input);
    }
    return Promise.resolve({ schemaVersion: 1, status: "unavailable" });
  }

  public reauthorizeHistoricalEvidence(input: {
    readonly authorizationPrincipalRef: string;
    readonly roomId: string;
    readonly scopeId: string;
  }): Promise<boolean> {
    return this.retrievalV2?.reauthorizeHistoricalEvidence(input) ??
      Promise.resolve(false);
  }
}
