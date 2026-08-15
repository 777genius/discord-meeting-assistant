import {
  HistoricalIndexPlanError,
  rehydrateHistoricalBlock,
  type HistoricalEvidenceBlockPolicyV1,
} from "./historical-index-plan.js";
import {
  historicalSourceKey,
  retainStrictSourceSubsets,
} from "./historical-retrieval-ranking.js";
import type {
  HistoricalEvidenceAuthority,
  HistoricalSyncStore,
} from "./ports/historical-state.js";
import type {
  HistoricalOpaqueIdPort,
  LocallyRehydratedEvidenceBlockV1,
} from "./ports/historical-memory.js";

export async function refreshStrictFocusedBlocks(input: {
  readonly authority: HistoricalEvidenceAuthority;
  readonly blockPolicy: HistoricalEvidenceBlockPolicyV1;
  readonly ids: HistoricalOpaqueIdPort;
  readonly requestedMeeting: (meetingId: string) => boolean;
  readonly scopeId: string;
  readonly roomId: string;
  readonly selected: readonly LocallyRehydratedEvidenceBlockV1[];
  readonly signal: AbortSignal | undefined;
  readonly store: HistoricalSyncStore;
}): Promise<readonly LocallyRehydratedEvidenceBlockV1[]> {
  const refreshed: LocallyRehydratedEvidenceBlockV1[] = [];
  const authoritativeTurnCounts = new Map<string, number>();
  for (const prior of input.selected) {
    const options = input.signal === undefined ? {} : { signal: input.signal };
    const record = await input.store.findCurrentCandidate(
      input.scopeId,
      input.roomId,
      prior.candidateLocator,
      options,
    );
    if (
      record === null ||
      !input.requestedMeeting(record.binding.meetingId) ||
      record.plan.topology.indexGeneration !== prior.indexGeneration ||
      !await input.store.isCurrentGeneration(
        record.binding,
        prior.indexGeneration,
        options,
      )
    ) {
      continue;
    }
    const meeting = await input.authority.loadAcceptedFinalMeeting(
      record.binding,
      options,
    );
    if (meeting === null) {
      continue;
    }
    authoritativeTurnCounts.set(
      historicalSourceKey(record.binding),
      meeting.humanTurns.length,
    );
    try {
      const block = rehydrateHistoricalBlock(
        meeting,
        record.plan,
        record.ordinal,
        input.ids,
        input.blockPolicy,
      );
      if (
        block.candidateLocator === prior.candidateLocator &&
        block.contentHash === prior.contentHash
      ) {
        refreshed.push(block);
      }
    } catch (error) {
      if (!(error instanceof HistoricalIndexPlanError)) {
        throw error;
      }
    }
  }
  return retainStrictSourceSubsets(refreshed, authoritativeTurnCounts);
}
