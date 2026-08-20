import {
  MAXIMUM_HISTORICAL_SYNC_LEASE_DURATION_MS,
  type HistoricalSyncClaimOptionsV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";

export function requireHistoricalLeaseDuration(
  options: HistoricalSyncClaimOptionsV1,
): void {
  if (
    !Number.isSafeInteger(options.leaseDurationMs) ||
    options.leaseDurationMs < 1_000 ||
    options.leaseDurationMs > MAXIMUM_HISTORICAL_SYNC_LEASE_DURATION_MS
  ) {
    throw new RangeError("historical sync lease duration is outside its bounds");
  }
}

export async function requireHistoricalRowUpdated(
  result: { readonly rowCount: number | null },
  operation: string,
): Promise<void> {
  if (result.rowCount !== 1) {
    throw new Error(`historical sync ${operation} lost its lease fence`);
  }
}
