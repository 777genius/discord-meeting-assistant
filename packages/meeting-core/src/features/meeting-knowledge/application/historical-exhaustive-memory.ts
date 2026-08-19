import type { ExhaustiveCoverage } from "./exhaustive-coverage.js";
import type { CanonicalEvidenceTurnHashPort } from "./same-room-focused-memory.js";
import type {
  ExhaustiveMemoryRetrievalPort,
  ExhaustiveMemoryRetrievalRequest,
  ExhaustiveMemoryRetrievalResult,
} from "./ports/final-reply.js";

/** Maps the checkpointed historical every-block plan to text-free locators. */
export class HistoricalExhaustiveMemoryRetrieval
  implements ExhaustiveMemoryRetrievalPort
{
  public constructor(
    private readonly coverage: Pick<ExhaustiveCoverage, "buildPlan">,
    private readonly hashes: CanonicalEvidenceTurnHashPort,
    private readonly servingAuthorized: boolean | (() => boolean) = true,
  ) {}

  public async retrieve(
    input: ExhaustiveMemoryRetrievalRequest,
  ): Promise<ExhaustiveMemoryRetrievalResult> {
    if (!(typeof this.servingAuthorized === "function"
      ? this.servingAuthorized()
      : this.servingAuthorized)) {
      return { schemaVersion: 1, status: "unavailable" };
    }
    const result = await this.coverage.buildPlan({
      authorizationPrincipalRef: input.authorizationPrincipalRef,
      question: input.question,
      requestId: input.requestId,
      roomId: input.roomId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      scopeId: input.scopeId,
    });
    if (result.status !== "ready") {
      return {
        schemaVersion: 1,
        status: result.status === "invalidated"
          ? "stale"
          : result.status,
      };
    }
    const blocks = new Map(result.plan.selectedBlocks.map((block) => [
      block.candidateLocator,
      block,
    ]));
    const selectedTurns = result.plan.reduction.selectedTurns.flatMap((selection) => {
      const block = blocks.get(selection.blockLocator);
      const turn = block?.turns.find((candidate) =>
        candidate.turnId === selection.turnId &&
        candidate.sourceRef === selection.sourceRef &&
        candidate.sourceStartCodePoint === selection.sourceStartCodePoint &&
        candidate.sourceEndCodePoint === selection.sourceEndCodePoint
      );
      return block === undefined || turn === undefined ? [] : [{ block, turn }];
    });
    if (
      selectedTurns.length !== result.plan.reduction.selectedTurns.length ||
      selectedTurns.length > 256 ||
      new Set(result.plan.reduction.selectedTurns.map((selection) => JSON.stringify([
        selection.blockLocator,
        selection.turnId,
        selection.sourceRef,
        selection.sourceStartCodePoint,
        selection.sourceEndCodePoint,
      ]))).size !== selectedTurns.length
    ) {
      return { schemaVersion: 1, status: "unsupported" };
    }
    const candidates = selectedTurns.map(({ block, turn }) =>
      Object.freeze({
        meetingId: block.binding.meetingId,
        sourceEndCodePoint: turn.sourceEndCodePoint,
        sourceStartCodePoint: turn.sourceStartCodePoint,
        transcriptId: block.binding.transcriptId,
        transcriptVersion: block.binding.transcriptVersion,
        turnHash: this.hashes.hash(turn),
        turnId: turn.turnId,
      })
    );
    const unique = new Map(candidates.map((candidate) => [[
      candidate.meetingId,
      candidate.transcriptId,
      candidate.transcriptVersion,
      candidate.turnId,
      candidate.sourceStartCodePoint,
      candidate.sourceEndCodePoint,
    ].join("\u0000"), candidate]));
    if (unique.size > 256) {
      return { schemaVersion: 1, status: "unsupported" };
    }
    return Object.freeze({
      authorityGeneration: input.expectedAuthorityGeneration,
      candidates: Object.freeze([...unique.values()]),
      coverageBitmap: result.plan.coverageBitmap,
      coveragePlanDigest: result.plan.coveragePlanDigest,
      coverageReduction: Object.freeze({
        evidenceBlockCount: result.plan.coverageBitmap.length,
        payload: result.plan.reduction.payload,
        schemaVersion: 1,
        selectionStatus: result.plan.reduction.selectionStatus,
        selectedCanonicalTurnCount: unique.size,
        selectedEvidenceBlockCount: result.plan.selectedBlocks.length,
      }),
      schemaVersion: 1,
      status: "current",
    });
  }

  public async recheck(
    input: ExhaustiveMemoryRetrievalRequest & {
      readonly coveragePlanDigest: string;
    },
  ): Promise<boolean> {
    const refreshed = await this.retrieve(input);
    return refreshed.status === "current" &&
      refreshed.coveragePlanDigest === input.coveragePlanDigest;
  }
}
