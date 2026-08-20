export interface HistoricalEvidenceSource {
  readonly candidateLocator: string;
  readonly indexGeneration: string;
  readonly releaseId: string;
}

export function historicalEvidenceSourceKey(
  source: HistoricalEvidenceSource | undefined,
): string {
  return source === undefined
    ? "current"
    : [
        "historical",
        source.releaseId,
        source.indexGeneration,
        source.candidateLocator,
      ].join("\u0000");
}
