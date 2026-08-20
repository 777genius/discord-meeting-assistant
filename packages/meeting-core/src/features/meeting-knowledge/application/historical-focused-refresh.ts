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
import type { HistoricalEmbeddingTokenizerPort } from
  "./ports/historical-embedding-tokenizer.js";

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
  readonly tokenizer: HistoricalEmbeddingTokenizerPort | undefined;
}): Promise<readonly LocallyRehydratedEvidenceBlockV1[]> {
  const refreshed: LocallyRehydratedEvidenceBlockV1[] = [];
  const authoritativeLocators = new Map<string, ReadonlySet<string>>();
  const options = input.signal === undefined ? {} : { signal: input.signal };
  const records = await input.store.findCurrentCandidates(
    input.scopeId,
    input.roomId,
    input.selected.map(({ candidateLocator }) => candidateLocator),
    options,
  );
  const recordsByLocator = new Map(records.flatMap((record) => {
    const locator = record.plan.documents[record.ordinal]?.manifest.candidateLocator;
    return locator === undefined ? [] : [[locator, record] as const];
  }));
  const currentGenerationByRelease = new Map<string, boolean>();
  const meetingByRelease = new Map<string, Awaited<ReturnType<
    HistoricalEvidenceAuthority["loadAcceptedFinalMeeting"]>>>();
  for (const prior of input.selected) {
    const record = recordsByLocator.get(prior.candidateLocator);
    if (
      record === undefined ||
      !input.requestedMeeting(record.binding.meetingId) ||
      record.plan.topology.indexGeneration !== prior.indexGeneration
    ) {
      continue;
    }
    const releaseId = record.binding.releaseId;
    let currentGeneration = currentGenerationByRelease.get(releaseId);
    if (currentGeneration === undefined) {
      currentGeneration = await input.store.isCurrentGeneration(
        record.binding,
        prior.indexGeneration,
        options,
      );
      currentGenerationByRelease.set(releaseId, currentGeneration);
    }
    if (!currentGeneration) {
      continue;
    }
    let meeting = meetingByRelease.get(releaseId);
    if (!meetingByRelease.has(releaseId)) {
      meeting = await input.authority.loadAcceptedFinalMeeting(
        record.binding,
        options,
      );
      meetingByRelease.set(releaseId, meeting ?? null);
    }
    if (meeting === null || meeting === undefined) {
      continue;
    }
    authoritativeLocators.set(
      historicalSourceKey(record.binding),
      new Set(record.plan.documents.map(({ manifest }) => manifest.candidateLocator)),
    );
    try {
      const block = rehydrateHistoricalBlock(
        meeting,
        record.plan,
        record.ordinal,
        input.ids,
        { policy: input.blockPolicy, tokenizer: input.tokenizer },
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
  return retainStrictSourceSubsets(refreshed, authoritativeLocators);
}
