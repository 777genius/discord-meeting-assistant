import { PersistedFocusedMemoryRetrievalV2,
  type FocusedMemoryRetrievalPort,
  type HistoricalFocusedLocatorRetrievalV2 } from
  "@discord-meeting/meeting-core/meeting-knowledge";

/** Production serving has one constructible historical retrieval path: V2. */
export function createPersistedFocusedMemoryRoute(input: {
  readonly current: FocusedMemoryRetrievalPort;
  readonly retrievalV2Historical?: HistoricalFocusedLocatorRetrievalV2;
}): FocusedMemoryRetrievalPort {
  if (input.retrievalV2Historical === undefined) {
    return new UnavailableFocusedMemoryRetrieval();
  }
  return new PersistedFocusedMemoryRetrievalV2({
    current: input.current,
    historical: input.retrievalV2Historical,
  });
}

class UnavailableFocusedMemoryRetrieval implements FocusedMemoryRetrievalPort {
  public retrieve(): Promise<{
    readonly schemaVersion: 1;
    readonly status: "unavailable";
  }> {
    return Promise.resolve({ schemaVersion: 1, status: "unavailable" });
  }
}
