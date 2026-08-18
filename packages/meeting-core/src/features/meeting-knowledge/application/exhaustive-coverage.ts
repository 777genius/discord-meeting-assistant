import {
  classifyHistoricalGroundingMode,
  normalizeHistoricalQuestion,
} from "../domain/grounding-mode.js";
import type { HistoricalReleaseBindingV1 } from "../domain/historical-evidence.js";
import {
  buildHistoricalIndexPlan,
  HistoricalIndexPlanError,
  rehydrateHistoricalBlock,
} from "./historical-index-plan.js";
import {
  DEFAULT_EXHAUSTIVE_COVERAGE_POLICY,
  assertExhaustiveCoveragePolicy,
  boundedCoverageIdentity,
  compareOpaque,
  sameAuthorization,
  sameBindings,
  selectedTurnIdentity,
  validateReduction,
  type CoverageFinalization,
  type ExhaustiveCoveragePolicyV1,
  type ExhaustiveCoverageRequestV1,
  type ExhaustiveCoverageResultV1,
  type ExtractedCoverage,
  type LoadedCoveragePlan,
} from "./exhaustive-coverage-contract.js";
import { extractEveryCoverageBlock } from "./exhaustive-coverage-extraction.js";
import { CoverageSelectionLimitExceededError } from "./deterministic-coverage-extraction.js";
import type {
  CoverageExtractV1,
  CoverageExtractorPort,
  CoverageReducerPort,
  CoverageReductionV1,
  ExhaustiveCoverageStore,
  HistoricalAuthorizationPort,
} from "./ports/historical-grounding.js";
import type {
  HistoricalIndexPlanV1,
  HistoricalOpaqueIdPort,
  LocallyRehydratedEvidenceBlockV1,
} from "./ports/historical-memory.js";
import type {
  HistoricalEvidenceAuthority,
  HistoricalSyncStore,
} from "./ports/historical-state.js";

export class ExhaustiveCoverage {
  readonly #policy: ExhaustiveCoveragePolicyV1;

  public constructor(
    private readonly dependencies: {
      readonly authority: HistoricalEvidenceAuthority;
      readonly authorization: HistoricalAuthorizationPort;
      readonly checkpoints: ExhaustiveCoverageStore;
      readonly extractor: CoverageExtractorPort;
      readonly ids: HistoricalOpaqueIdPort;
      readonly reducer: CoverageReducerPort;
      readonly sync: HistoricalSyncStore;
    },
    policy: ExhaustiveCoveragePolicyV1 = DEFAULT_EXHAUSTIVE_COVERAGE_POLICY,
  ) {
    this.#policy = assertExhaustiveCoveragePolicy(policy);
  }

  public async buildPlan(
    input: ExhaustiveCoverageRequestV1,
  ): Promise<ExhaustiveCoverageResultV1> {
    const request = Object.freeze({
      ...input,
      authorizationPrincipalRef: boundedCoverageIdentity(
        input.authorizationPrincipalRef,
        "authorizationPrincipalRef",
      ),
      question: normalizeHistoricalQuestion(input.question),
      requestId: boundedCoverageIdentity(input.requestId, "requestId"),
      roomId: boundedCoverageIdentity(input.roomId, "roomId"),
      scopeId: boundedCoverageIdentity(input.scopeId, "scopeId"),
    });
    request.signal?.throwIfAborted();
    if (classifyHistoricalGroundingMode(request.question) !== "exhaustive_coverage") {
      return { reason: "question_does_not_require_exhaustive_coverage", status: "unsupported" };
    }
    const authorizationRequest = {
      authorizationPrincipalRef: request.authorizationPrincipalRef,
      roomId: request.roomId,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      scopeId: request.scopeId,
    };
    const before = await this.dependencies.authorization.authorize(authorizationRequest);
    if (!before.authorized) {
      return { reason: "room_authorization_denied", status: "unauthorized" };
    }
    const authorizationIsCurrent = async () => sameAuthorization(before,
      await this.dependencies.authorization.authorize(authorizationRequest));

    const bindings = await this.dependencies.sync.listDesiredRoomBindings(
      request.scopeId,
      request.roomId,
      this.#policy.maximumBlocks + 1,
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (bindings.length > this.#policy.maximumBlocks) {
      return { reason: "exhaustive_block_bound_not_qualified", status: "unsupported" };
    }
    let loaded: LoadedCoveragePlan | null;
    try {
      loaded = await this.loadCoveragePlan(bindings, request.signal);
    } catch (error) {
      if (!(error instanceof HistoricalIndexPlanError)) {
        throw error;
      }
      return error.code === "BLOCK_LIMIT_EXCEEDED" || error.code === "INVALID_POLICY"
        ? { reason: "exhaustive_block_plan_not_qualified", status: "unsupported" }
        : { reason: "missing_or_stale_authoritative_release", status: "invalidated" };
    }
    if (loaded === null) {
      return { reason: "missing_or_stale_authoritative_release", status: "invalidated" };
    }
    if (loaded.blocks.length > this.#policy.maximumBlocks) {
      return { reason: "exhaustive_block_bound_not_qualified", status: "unsupported" };
    }
    if (coverageInputUpperBoundBytes(loaded.blocks, request.question) >
      this.#policy.maximumCumulativeEvidenceUtf8Bytes) {
      return { reason: "exhaustive_evidence_budget_exceeded", status: "unsupported" };
    }

    const extracted = await extractEveryCoverageBlock(
      { ...this.dependencies, authorizationIsCurrent },
      this.#policy,
      request,
      bindings,
      loaded,
    );
    if ("status" in extracted) {
      return extracted;
    }
    const reduced = await this.reduceExtracts(
      request,
      extracted,
      loaded,
      authorizationIsCurrent,
    );
    if ("status" in reduced) {
      return reduced;
    }
    return this.finalize({
      authorizationBefore: before,
      authorizationRequest,
      bindings,
      extracted,
      loaded,
      reduction: reduced.reduction,
      request,
    });
  }

  private async reduceExtracts(
    input: ExhaustiveCoverageRequestV1,
    extracted: ExtractedCoverage,
    loaded: LoadedCoveragePlan,
    authorizationIsCurrent: () => Promise<boolean>,
  ): Promise<{ readonly reduction: CoverageReductionV1 } | ExhaustiveCoverageResultV1> {
    if (extracted.checkpoint.state === "completed") {
      const stored = extracted.checkpoint.reduction;
      if (stored === null) {
        return { reason: "coverage_checkpoint_reduction_missing", status: "invalidated" };
      }
      try {
        return {
          reduction: validateReduction(
            stored,
            new Set(loaded.blocks.map(({ candidateLocator }) => candidateLocator)),
            new Set(loaded.blocks.flatMap((block) =>
              block.turns.map(({ turnId }) => selectedTurnIdentity({
                blockLocator: block.candidateLocator,
                turnId,
              }))
            )),
            this.#policy,
          ),
        };
      } catch {
        return { reason: "coverage_checkpoint_reduction_invalid", status: "invalidated" };
      }
    }
    let levelValues: readonly (CoverageExtractV1 | CoverageReductionV1)[] = extracted.extracts;
    let reduceCalls = 0;
    let level = 0;
    while (levelValues.length > 1) {
      const next: CoverageReductionV1[] = [];
      for (let index = 0; index < levelValues.length; index += this.#policy.reduceFanIn) {
        reduceCalls += 1;
        if (reduceCalls > this.#policy.maximumReduceCalls) {
          return { reason: "coverage_reduce_budget_exceeded", status: "unsupported" };
        }
        const values = levelValues.slice(index, index + this.#policy.reduceFanIn);
        try {
          if (!await authorizationIsCurrent()) {
            return {
              reason: "authorization_changed",
              status: "unauthorized",
            };
          }
          next.push(validateReduction(await this.dependencies.reducer.reduce({
            level,
            question: input.question,
            values,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          }), new Set(values.flatMap(({ evidenceLocators }) => evidenceLocators)),
          new Set(values.flatMap(({ selectedTurns }) =>
            selectedTurns.map(selectedTurnIdentity)
          )), this.#policy));
        } catch (error) {
          input.signal?.throwIfAborted();
          if (error instanceof CoverageSelectionLimitExceededError) {
            return { reason: "coverage_synthesis_selection_exceeded", status: "unsupported" };
          }
          return {
            checkpointId: extracted.checkpointId,
            reason: error instanceof Error ? error.name : "coverage_reduce_failed",
            status: "incomplete",
          };
        }
      }
      levelValues = Object.freeze(next);
      level += 1;
    }
    const reduction = levelValues[0];
    return { reduction: reduction === undefined
      ? Object.freeze({
          evidenceLocators: Object.freeze([]),
          payload: Object.freeze({ emptyAuthorizedCorpus: true }),
          selectedTurns: Object.freeze([]),
          selectionStatus: "no_match" as const,
          schemaVersion: 1,
        })
      : Object.freeze({
          evidenceLocators: reduction.evidenceLocators,
          payload: reduction.payload,
          selectedTurns: reduction.selectedTurns,
          selectionStatus: reduction.selectionStatus,
          schemaVersion: 1,
        }) };
  }

  private async finalize(
    finalization: CoverageFinalization,
  ): Promise<ExhaustiveCoverageResultV1> {
    const { authorizationBefore, authorizationRequest, bindings, extracted,
      loaded, reduction, request } = finalization;
    const currentBindings = await this.dependencies.sync.listDesiredRoomBindings(
      request.scopeId,
      request.roomId,
      this.#policy.maximumBlocks + 1,
      request.signal === undefined ? {} : { signal: request.signal },
    );
    let current: LoadedCoveragePlan | null = null;
    if (sameBindings(bindings, currentBindings)) {
      try {
        current = await this.loadCoveragePlan(currentBindings, request.signal);
      } catch (error) {
        if (!(error instanceof HistoricalIndexPlanError)) {
          throw error;
        }
      }
    }
    const after = await this.dependencies.authorization.authorize(authorizationRequest);
    if (current === null || current.digest !== loaded.digest) {
      await this.invalidateCheckpoint(extracted, "coverage_source_changed", request.signal);
      return { reason: "coverage_source_changed", status: "invalidated" };
    }
    if (!sameAuthorization(authorizationBefore, after)) {
      await this.invalidateCheckpoint(extracted, "authorization_changed", request.signal);
      return { reason: "authorization_changed", status: "unauthorized" };
    }
    const selected = new Set(reduction.evidenceLocators);
    const selectedBlocks = current.blocks.filter(({ candidateLocator }) =>
      selected.has(candidateLocator)
    );
    if (extracted.checkpoint.state === "active") {
      await this.dependencies.checkpoints.recordReduction({
        checkpointId: extracted.checkpointId,
        fence: extracted.checkpoint.fence,
        reduction,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      await this.dependencies.checkpoints.complete({
        checkpointId: extracted.checkpointId,
        fence: extracted.checkpoint.fence,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    }
    return {
      plan: Object.freeze({
        coverageBitmap: Object.freeze(extracted.checkpoint.bitmap.map(() => true as const)),
        coveragePlanDigest: current.digest,
        finalSynthesisAllowed: true,
        reduction,
        schemaVersion: 1,
        selectedBlocks: Object.freeze(selectedBlocks),
        strategy: "exhaustive_coverage",
        synthesisRequiresCanonicalRehydration: true,
      }),
      status: "ready",
    };
  }

  private async loadCoveragePlan(
    bindings: readonly HistoricalReleaseBindingV1[],
    signal?: AbortSignal,
  ): Promise<LoadedCoveragePlan | null> {
    if (new Set(bindings.map(({ releaseId }) => releaseId)).size !== bindings.length) {
      return null;
    }
    const ordered = bindings.toSorted((left, right) =>
      compareOpaque(left.meetingId, right.meetingId) ||
      left.transcriptVersion - right.transcriptVersion ||
      compareOpaque(left.releaseId, right.releaseId)
    );
    const indexPlans: HistoricalIndexPlanV1[] = [];
    const blocks: LocallyRehydratedEvidenceBlockV1[] = [];
    for (const binding of ordered) {
      signal?.throwIfAborted();
      const meeting = await this.dependencies.authority.loadAcceptedFinalMeeting(
        binding,
        signal === undefined ? {} : { signal },
      );
      if (meeting === null) {
        return null;
      }
      const plan = buildHistoricalIndexPlan(
        meeting,
        this.dependencies.ids,
        this.#policy.blockPolicy,
      );
      if (!await this.dependencies.sync.isCurrentGeneration(
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
          this.dependencies.ids,
          this.#policy.blockPolicy,
        ));
        if (blocks.length > this.#policy.maximumBlocks) {
          throw new HistoricalIndexPlanError(
            "BLOCK_LIMIT_EXCEEDED",
            "authorized room exceeds the exhaustive block bound",
          );
        }
      }
    }
    if (
      new Set(blocks.map(({ candidateLocator }) => candidateLocator)).size !==
        blocks.length
    ) {
      return null;
    }
    return Object.freeze({
      blocks: Object.freeze(blocks),
      digest: `mkcoverageplan1.${this.dependencies.ids.keyedId(
        "coverage-plan",
        [
          this.#policy.processingRelease,
          this.#policy.version,
          this.dependencies.extractor.profile,
          this.dependencies.reducer.profile,
          ...indexPlans.map(({ planDigest }) => planDigest),
        ],
      )}`,
      indexPlans: Object.freeze(indexPlans),
    });
  }

  private async invalidateCheckpoint(
    extracted: ExtractedCoverage,
    reason: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (extracted.checkpoint.state !== "active") {
      return;
    }
    await this.dependencies.checkpoints.terminate({
      checkpointId: extracted.checkpointId,
      fence: extracted.checkpoint.fence,
      reason,
      ...(signal === undefined ? {} : { signal }),
      state: "invalidated",
    });
  }
}

function coverageInputUpperBoundBytes(
  blocks: readonly LocallyRehydratedEvidenceBlockV1[],
  question: string,
): number {
  const encoder = new TextEncoder();
  const questionBytes = encoder.encode(question).byteLength;
  return blocks.reduce((total, block) => total + questionBytes + 1_024 +
    block.turns.reduce((turnTotal, turn) =>
      turnTotal + encoder.encode(turn.text).byteLength + 512, 0), 0);
}
