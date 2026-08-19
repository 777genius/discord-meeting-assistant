import type {
  HistoricalIndexPlanV1,
  HistoricalOpaqueIdPort,
} from "./ports/historical-memory.js";
import type { HistoricalSyncLeaseV1 } from "./ports/historical-state.js";
import type { HistoricalReleaseBindingV1 } from
  "../domain/historical-evidence.js";

export function historicalOperationOptions(signal: AbortSignal | undefined):
  { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

export function historicalDeletionMutationId(
  lease: HistoricalSyncLeaseV1,
  ids: HistoricalOpaqueIdPort,
): string {
  return lease.plan?.deleteMutationId ??
    `mkmutation1.${ids.keyedId("historical-delete-mutation", [lease.binding.releaseId])}`;
}

export function historicalBindingsMatch(
  left: HistoricalReleaseBindingV1,
  right: HistoricalReleaseBindingV1,
): boolean {
  return left.acceptedMeetingRevision === right.acceptedMeetingRevision &&
    left.desiredGeneration === right.desiredGeneration &&
    left.meetingId === right.meetingId &&
    left.releaseId === right.releaseId &&
    left.roomId === right.roomId &&
    left.scopeId === right.scopeId &&
    left.transcriptId === right.transcriptId &&
    left.transcriptVersion === right.transcriptVersion;
}

export function historicalRemoteDocumentIdsForPlan(
  plan: HistoricalIndexPlanV1,
  remoteDocumentIds: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const plannedExternalIds = new Set(
    plan.documents.map(({ manifest }) => manifest.documentExternalId),
  );
  return Object.freeze(Object.fromEntries(
    Object.entries(remoteDocumentIds).filter(([externalId]) =>
      plannedExternalIds.has(externalId)
    ),
  ));
}
