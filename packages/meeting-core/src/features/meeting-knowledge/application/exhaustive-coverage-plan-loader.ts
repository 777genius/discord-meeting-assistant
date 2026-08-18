import {
  admitsHistoricalRetrieval,
  type HistoricalReleaseBindingV1,
  type TwoHourHistoricalRetrievalProfileV1,
} from "../domain/historical-evidence.js";
import {
  buildHistoricalIndexPlan,
  HistoricalIndexPlanError,
  rehydrateHistoricalBlock,
} from "./historical-index-plan.js";
import {
  compareOpaque,
  type ExhaustiveCoveragePolicyV1,
  type LoadedCoveragePlan,
} from "./exhaustive-coverage-contract.js";
import type {
  CoverageExtractorPort,
  CoverageReducerPort,
  HistoricalAuthorizationPort,
} from "./ports/historical-grounding.js";
import type { HistoricalOpaqueIdPort } from "./ports/historical-memory.js";
import type { HistoricalEmbeddingTokenizerPort } from
  "./ports/historical-embedding-tokenizer.js";
import type {
  HistoricalEvidenceAuthority,
  HistoricalSyncStore,
} from "./ports/historical-state.js";

export interface CoveragePlanLoaderDependencies {
  readonly authority: HistoricalEvidenceAuthority;
  readonly authorization: HistoricalAuthorizationPort;
  readonly extractor: CoverageExtractorPort;
  readonly ids: HistoricalOpaqueIdPort;
  readonly reducer: CoverageReducerPort;
  readonly sync: HistoricalSyncStore;
  readonly tokenizer?: () => HistoricalEmbeddingTokenizerPort | undefined;
}

export async function loadExhaustiveCoveragePlan(input: {
  readonly bindings: readonly HistoricalReleaseBindingV1[];
  readonly dependencies: CoveragePlanLoaderDependencies;
  readonly policy: ExhaustiveCoveragePolicyV1;
  readonly signal?: AbortSignal;
  readonly twoHourProfile: TwoHourHistoricalRetrievalProfileV1;
}): Promise<LoadedCoveragePlan | null> {
  const { bindings, dependencies, policy, signal, twoHourProfile } = input;
  if (new Set(bindings.map(({ releaseId }) => releaseId)).size !== bindings.length) {
    return null;
  }
  const ordered = bindings.toSorted((left, right) =>
    compareOpaque(left.meetingId, right.meetingId) ||
    left.transcriptVersion - right.transcriptVersion ||
    compareOpaque(left.releaseId, right.releaseId)
  );
  const indexPlans = [];
  const blocks = [];
  for (const binding of ordered) {
    signal?.throwIfAborted();
    const meeting = await dependencies.authority.loadAcceptedFinalMeeting(
      binding,
      signal === undefined ? {} : { signal },
    );
    if (meeting === null || !admitsHistoricalRetrieval(meeting, twoHourProfile)) {
      return null;
    }
    const tokenizer = dependencies.tokenizer?.();
    const plan = buildHistoricalIndexPlan(
      meeting,
      dependencies.ids,
      policy.blockPolicy,
      tokenizer,
    );
    if (!await dependencies.sync.isCurrentGeneration(
      binding,
      plan.topology.indexGeneration,
      signal === undefined ? {} : { signal },
    )) {
      return null;
    }
    indexPlans.push(plan);
    for (const document of plan.documents) {
      blocks.push(rehydrateHistoricalBlock(
        meeting,
        plan,
        document.manifest.ordinal,
        dependencies.ids,
        { policy: policy.blockPolicy, tokenizer },
      ));
      if (blocks.length > policy.maximumBlocks) {
        throw new HistoricalIndexPlanError(
          "BLOCK_LIMIT_EXCEEDED",
          "authorized room exceeds the exhaustive block bound",
        );
      }
    }
  }
  if (new Set(blocks.map(({ candidateLocator }) => candidateLocator)).size !== blocks.length) {
    return null;
  }
  return Object.freeze({
    blocks: Object.freeze(blocks),
    digest: `mkcoverageplan1.${dependencies.ids.keyedId("coverage-plan", [
      policy.processingRelease,
      policy.version,
      dependencies.extractor.profile,
      dependencies.reducer.profile,
      ...indexPlans.map(({ planDigest }) => planDigest),
    ])}`,
    indexPlans: Object.freeze(indexPlans),
  });
}
