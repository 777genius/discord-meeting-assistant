import {
  admitsHistoricalRetrieval,
  type HistoricalReleaseBindingV1,
  type TwoHourHistoricalRetrievalProfileV1,
} from "../domain/historical-evidence.js";
import {
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
  const first = ordered[0];
  const persistedPlans = first === undefined
    ? []
    : await dependencies.sync.listCurrentRoomPlans(
        first.scopeId,
        first.roomId,
        policy.maximumBlocks + 1,
        signal === undefined ? {} : { signal },
      );
  const orderedPersisted = persistedPlans.toSorted((left, right) =>
    compareOpaque(left.binding.meetingId, right.binding.meetingId) ||
    left.binding.transcriptVersion - right.binding.transcriptVersion ||
    compareOpaque(left.binding.releaseId, right.binding.releaseId)
  );
  if (orderedPersisted.length !== ordered.length) {
    return null;
  }
  const indexPlans = [];
  const blocks = [];
  for (const [index, binding] of ordered.entries()) {
    signal?.throwIfAborted();
    const persisted = orderedPersisted[index];
    if (persisted === undefined ||
      !sameReleaseBinding(binding, persisted.binding) ||
      !sameReleaseBinding(binding, persisted.plan.binding)) {
      return null;
    }
    const meeting = await dependencies.authority.loadAcceptedFinalMeeting(
      binding,
      signal === undefined ? {} : { signal },
    );
    if (meeting === null || !admitsHistoricalRetrieval(meeting, twoHourProfile)) {
      return null;
    }
    const { plan } = persisted;
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
        policy.blockPolicy,
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

function sameReleaseBinding(
  left: HistoricalReleaseBindingV1,
  right: HistoricalReleaseBindingV1,
): boolean {
  return left.acceptedMeetingRevision === right.acceptedMeetingRevision &&
    left.desiredGeneration === right.desiredGeneration &&
    left.meetingId === right.meetingId && left.releaseId === right.releaseId &&
    left.roomId === right.roomId && left.scopeId === right.scopeId &&
    left.transcriptId === right.transcriptId &&
    left.transcriptVersion === right.transcriptVersion;
}
