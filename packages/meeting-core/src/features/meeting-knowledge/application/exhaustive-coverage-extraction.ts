import type { HistoricalReleaseBindingV1 } from "../domain/historical-evidence.js";
import {
  allDefined,
  validateExtract,
  type ExhaustiveCoveragePolicyV1,
  type ExhaustiveCoverageRequestV1,
  type ExhaustiveCoverageResultV1,
  type ExtractedCoverage,
  type LoadedCoveragePlan,
} from "./exhaustive-coverage-contract.js";
import type {
  CoverageCheckpointLeaseV1,
  CoverageExtractorPort,
  ExhaustiveCoverageStore,
} from "./ports/historical-grounding.js";
import { CoverageExtractionCapacityError } from "./ports/historical-grounding.js";
import type {
  HistoricalOpaqueIdPort,
  LocallyRehydratedEvidenceBlockV1,
} from "./ports/historical-memory.js";

interface CoverageExtractionDependencies {
  readonly checkpoints: ExhaustiveCoverageStore;
  readonly extractor: CoverageExtractorPort;
  readonly ids: HistoricalOpaqueIdPort;
}

type ExtractOneResult =
  | { readonly checkpoint: CoverageCheckpointLeaseV1 }
  | ExhaustiveCoverageResultV1;

interface ExtractOneInput {
  readonly block: LocallyRehydratedEvidenceBlockV1;
  readonly checkpoint: CoverageCheckpointLeaseV1;
  readonly checkpointId: string;
  readonly dependencies: CoverageExtractionDependencies;
  readonly loaded: LoadedCoveragePlan;
  readonly ordinal: number;
  readonly policy: ExhaustiveCoveragePolicyV1;
  readonly request: ExhaustiveCoverageRequestV1;
}

export async function extractEveryCoverageBlock(
  dependencies: CoverageExtractionDependencies,
  policy: ExhaustiveCoveragePolicyV1,
  input: ExhaustiveCoverageRequestV1,
  bindings: readonly HistoricalReleaseBindingV1[],
  loaded: LoadedCoveragePlan,
): Promise<ExtractedCoverage | ExhaustiveCoverageResultV1> {
  const questionHash = dependencies.ids.keyedId("coverage-question", [input.question]);
  const checkpointId = `mkcoverage1.${dependencies.ids.keyedId(
    "coverage-checkpoint",
    [input.requestId, loaded.digest, questionHash],
  )}`;
  let checkpoint = await dependencies.checkpoints.open({
    blockLocators: loaded.blocks.map(({ candidateLocator }) => candidateLocator),
    checkpointId,
    planDigest: loaded.digest,
    questionHash,
    releaseBindings: bindings,
    retentionSeconds: policy.checkpointRetentionSeconds,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const checkpointFailure = await validateOpenedCheckpoint(
    checkpoint,
    dependencies,
    policy,
    input,
    { checkpointId, loaded },
  );
  if (checkpointFailure !== null) {
    return checkpointFailure;
  }
  for (const [ordinal, block] of loaded.blocks.entries()) {
    input.signal?.throwIfAborted();
    if (checkpoint.bitmap[ordinal] === true) {
      continue;
    }
    const result = await extractOneBlock({
      block,
      checkpoint,
      checkpointId,
      dependencies,
      loaded,
      ordinal,
      policy,
      request: input,
    });
    if ("status" in result) {
      return result;
    }
    checkpoint = result.checkpoint;
  }
  if (checkpoint.bitmap.some((covered) => !covered)) {
    return { checkpointId, reason: "coverage_bitmap_incomplete", status: "incomplete" };
  }
  const storedExtracts = loaded.blocks.map((block) =>
    checkpoint.extracts[block.candidateLocator]
  );
  if (checkpoint.state === "completed") {
    return { checkpoint, checkpointId, extracts: Object.freeze([]) };
  }
  if (!allDefined(storedExtracts)) {
    return { checkpointId, reason: "coverage_extract_missing", status: "incomplete" };
  }
  try {
    return {
      checkpoint,
      checkpointId,
      extracts: Object.freeze(storedExtracts.map((extract, ordinal) => {
        if (extract === undefined) {
          return blockMissing();
        }
        return validateExtract(
          extract,
          loaded.blocks[ordinal] ?? blockMissing(),
          policy,
        );
      })),
    };
  } catch {
    return { reason: "coverage_checkpoint_extract_invalid", status: "invalidated" };
  }
}

async function validateOpenedCheckpoint(
  checkpoint: CoverageCheckpointLeaseV1,
  dependencies: CoverageExtractionDependencies,
  policy: ExhaustiveCoveragePolicyV1,
  input: ExhaustiveCoverageRequestV1,
  context: {
    readonly checkpointId: string;
    readonly loaded: LoadedCoveragePlan;
  },
): Promise<ExhaustiveCoverageResultV1 | null> {
  const { checkpointId, loaded } = context;
  if (checkpoint.state === "failed" || checkpoint.state === "invalidated") {
    return {
      checkpointId,
      reason: checkpoint.terminalReason ?? `coverage_checkpoint_${checkpoint.state}`,
      status: checkpoint.state === "failed" ? "incomplete" : "invalidated",
    };
  }
  if (checkpoint.attempt > policy.maximumCheckpointAttempts) {
    await dependencies.checkpoints.terminate({
      checkpointId,
      fence: checkpoint.fence,
      reason: "coverage_checkpoint_attempt_budget_exhausted",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      state: "failed",
    });
    return {
      checkpointId,
      reason: "coverage_checkpoint_attempt_budget_exhausted",
      status: "incomplete",
    };
  }
  if (checkpoint.planDigest !== loaded.digest ||
    checkpoint.bitmap.length !== loaded.blocks.length) {
    return { reason: "coverage_checkpoint_binding_mismatch", status: "invalidated" };
  }
  if (checkpoint.state === "completed" &&
    (checkpoint.reduction === null || checkpoint.bitmap.some((covered) => !covered))) {
    return { reason: "coverage_checkpoint_completion_invalid", status: "invalidated" };
  }
  return null;
}

async function extractOneBlock(input: ExtractOneInput): Promise<ExtractOneResult> {
  try {
    const extract = validateExtract(await input.dependencies.extractor.extract({
      block: input.block,
      question: input.request.question,
      ...(input.request.signal === undefined
        ? {}
        : { signal: input.request.signal }),
    }), input.block, input.policy);
    const refreshed = await input.dependencies.checkpoints.recordExtract({
      blockOrdinal: input.ordinal,
      checkpointId: input.checkpointId,
      extract,
      fence: input.checkpoint.fence,
      ...(input.request.signal === undefined
        ? {}
        : { signal: input.request.signal }),
    });
    if (
      refreshed.planDigest !== input.loaded.digest ||
      refreshed.bitmap.length !== input.loaded.blocks.length ||
      refreshed.bitmap[input.ordinal] !== true
    ) {
      return { reason: "coverage_checkpoint_binding_mismatch", status: "invalidated" };
    }
    return { checkpoint: refreshed };
  } catch (error) {
    input.request.signal?.throwIfAborted();
    if (error instanceof CoverageExtractionCapacityError) {
      return {
        reason: "coverage_extract_capacity_exceeded",
        status: "unsupported",
      };
    }
    return {
      checkpointId: input.checkpointId,
      reason: error instanceof Error ? error.name : "coverage_extract_failed",
      status: "incomplete",
    };
  }
}

function blockMissing(): never {
  throw new Error("coverage checkpoint block disappeared");
}
