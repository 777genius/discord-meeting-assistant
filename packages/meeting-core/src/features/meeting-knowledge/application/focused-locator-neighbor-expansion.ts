import type {
  FocusedLocatorRetrievalPort,
  FocusedLocatorRetrievalRequestSnapshot,
  FocusedLocatorRetrievalV2Candidate,
} from "./ports/focused-locator-retrieval-v2.js";

export function availableRemoteWithinLimit(
  remote: Awaited<ReturnType<FocusedLocatorRetrievalPort["retrieve"]>>,
  request: FocusedLocatorRetrievalRequestSnapshot,
): remote is Extract<typeof remote, { readonly status: "available" }> {
  if (remote.status !== "available" ||
    remote.candidates.length > request.budgets.resultLimit) {return false;}
  const neighbors = remote.expandedNeighbors ?? [];
  if (request.schemaVersion === 3 && request.budgets.neighborRadius === 1) {
    return neighbors.length <= request.budgets.resultLimit * 2;
  }
  return neighbors.length === 0;
}

export function interleaveExpandedNeighbors(
  seeds: readonly FocusedLocatorRetrievalV2Candidate[],
  neighbors: readonly FocusedLocatorRetrievalV2Candidate[],
): readonly FocusedLocatorRetrievalV2Candidate[] | null {
  const bySeed = new Map<string, FocusedLocatorRetrievalV2Candidate[]>();
  for (const neighbor of neighbors) {
    const seed = neighbor.retrievalProvenance.relation?.seedLocator;
    if (seed === undefined) {return null;}
    bySeed.set(seed, [...(bySeed.get(seed) ?? []), neighbor]);
  }
  const expanded: FocusedLocatorRetrievalV2Candidate[] = [];
  for (const seed of seeds) {
    expanded.push(seed, ...(bySeed.get(seed.locator) ?? []));
    bySeed.delete(seed.locator);
  }
  return bySeed.size === 0 ? Object.freeze(expanded) : null;
}

export function candidateInventoryIsValid(
  remote: Extract<Awaited<ReturnType<FocusedLocatorRetrievalPort["retrieve"]>>,
    { readonly status: "available" }>,
  request: FocusedLocatorRetrievalRequestSnapshot,
  seeds: readonly FocusedLocatorRetrievalV2Candidate[],
  neighbors: readonly FocusedLocatorRetrievalV2Candidate[],
): boolean {
  const exact = request.schemaVersion === 3;
  return !(exact && seeds.length !== remote.candidates.length) &&
    !(!exact && remote.candidates.length > 0 && seeds.length < 1) &&
    neighbors.length === (remote.expandedNeighbors?.length ?? 0) &&
    seeds.every(({ retrievalProvenance }) => retrievalProvenance.relation === undefined) &&
    neighbors.every(({ retrievalProvenance }) => retrievalProvenance.relation !== undefined);
}
