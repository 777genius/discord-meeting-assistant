import type {
  CanonicalEvidenceTurn,
  FocusedMemoryReference,
} from "../domain/grounding-plan.js";
import type { HistoricalFocusedRetrieval } from "./historical-retrieval.js";
import type {
  FocusedMemoryRetrievalPort,
  FocusedMemoryRetrievalResult,
} from "./ports/final-reply.js";

export interface CanonicalEvidenceTurnHashPort {
  hash(turn: CanonicalEvidenceTurn): string;
}

type HistoricalPlanResult = Awaited<
  ReturnType<HistoricalFocusedRetrieval["buildPlan"]>
> | null;

function historicalServingDenied(result: HistoricalPlanResult): boolean {
  return result?.status === "route_required" || result?.status === "unauthorized";
}

function historicalPriorityCandidates(
  result: HistoricalPlanResult,
  turnHashes: CanonicalEvidenceTurnHashPort,
): readonly FocusedMemoryReference[] {
  if (result?.status !== "ready") {
    return [];
  }
  return Object.freeze(result.plan.blocks.flatMap((block) =>
    block.turns.map((turn) => Object.freeze({
      meetingId: block.binding.meetingId,
      sourceEndCodePoint: turn.sourceEndCodePoint,
      sourceStartCodePoint: turn.sourceStartCodePoint,
      transcriptId: block.binding.transcriptId,
      transcriptVersion: block.binding.transcriptVersion,
      turnHash: turnHashes.hash(turn),
      turnId: turn.turnId,
    }))
  ));
}

function hasNoUsableEvidence(
  currentCount: number,
  historicalCount: number,
): boolean {
  return currentCount === 0 && historicalCount === 0;
}

/**
 * Adapts locally rehydrated historical blocks to the existing text-free
 * candidate boundary. The Discord message being replied to identifies the
 * current meeting and room; it does not restrict evidence to that meeting.
 */
export class SameRoomFocusedMemoryRetrieval
  implements FocusedMemoryRetrievalPort
{
  public constructor(
    private readonly dependencies: {
      readonly current: FocusedMemoryRetrievalPort;
      readonly historical: Pick<
        HistoricalFocusedRetrieval,
        "buildPlan" | "reauthorizeRoom"
      >;
      readonly turnHashes: CanonicalEvidenceTurnHashPort;
    },
    private readonly flags: {
      readonly historicalServingAuthorized: boolean | (() => boolean);
      readonly remoteSearchAvailable: boolean | (() => boolean);
    },
  ) {}

  public async retrieve(
    input: Parameters<FocusedMemoryRetrievalPort["retrieve"]>[0],
  ): Promise<FocusedMemoryRetrievalResult> {
    const currentPromise = this.dependencies.current.retrieve(input);
    const servingAuthorized = enabled(this.flags.historicalServingAuthorized);
    const historicalPromise = input.authorizationPrincipalRef === undefined ||
        !servingAuthorized
      ? Promise.resolve(null)
      : this.dependencies.historical.buildPlan({
        authorizationPrincipalRef: input.authorizationPrincipalRef,
        currentMeetingId: input.meetingId,
        question: input.question,
        roomId: input.roomId,
        scopeId: input.scopeId,
        searchEnabled: enabled(this.flags.remoteSearchAvailable),
        servingAuthorized,
        // The current adapter already owns current-release selection. Asking
        // the historical side for the whole room lets a highly relevant
        // current block consume its bounded rerank budget twice and can starve
        // the historical meeting that this merge exists to add.
        sourceSet: "historical",
      });
    const [current, historical] = await Promise.all([
      currentPromise,
      historicalPromise,
    ]);
    if (
      current.status !== "current" &&
      current.status !== "low_coverage"
    ) {
      return current;
    }
    if (historicalServingDenied(historical)) {
      return { schemaVersion: 1, status: "unavailable" };
    }
    const historicalCandidates = historicalPriorityCandidates(
      historical,
      this.dependencies.turnHashes,
    );
    const deduplicatedCurrent = deduplicate(
      current.status === "current" ? current.candidates : [],
    );
    const currentKeys = new Set(deduplicatedCurrent.keys());
    const deduplicatedHistorical = deduplicate(historicalCandidates, currentKeys);
    if (hasNoUsableEvidence(
      deduplicatedCurrent.size,
      deduplicatedHistorical.size,
    )) {
      return current.status === "low_coverage"
        ? current
        : { schemaVersion: 1, status: "unavailable" };
    }
    const rankedCandidates = crossSourceRank(
      [...deduplicatedCurrent.values()],
      [...deduplicatedHistorical.values()],
      Math.min(input.maximumCandidates, 256),
    );
    return Object.freeze({
      authorityGeneration: current.status === "current"
        ? current.authorityGeneration
        : input.expectedAuthorityGeneration,
      candidates: Object.freeze(rankedCandidates),
      schemaVersion: 1,
      status: "current",
    });
  }

  public reauthorizeHistoricalEvidence(input: {
    readonly authorizationPrincipalRef: string;
    readonly roomId: string;
    readonly scopeId: string;
  }): Promise<boolean> {
    return enabled(this.flags.historicalServingAuthorized)
      ? this.dependencies.historical.reauthorizeRoom(input)
      : Promise.resolve(false);
  }
}

function enabled(value: boolean | (() => boolean)): boolean {
  return typeof value === "function" ? value() : value;
}

/**
 * Deterministic rank fusion across current and historical source lists. Each
 * list is already in qualified relevance order. Alternating equal ranks keeps
 * history from starving live-final evidence while leaving unused capacity to
 * whichever source still has candidates.
 */
function crossSourceRank(
  current: readonly FocusedMemoryReference[],
  historical: readonly FocusedMemoryReference[],
  maximumCandidates: number,
): FocusedMemoryReference[] {
  const selected: FocusedMemoryReference[] = [];
  for (let rank = 0; selected.length < maximumCandidates; rank += 1) {
    const currentCandidate = current[rank];
    const historicalCandidate = historical[rank];
    if (currentCandidate === undefined && historicalCandidate === undefined) {
      break;
    }
    if (currentCandidate !== undefined) {
      selected.push(currentCandidate);
    }
    if (
      historicalCandidate !== undefined &&
      selected.length < maximumCandidates
    ) {
      selected.push(historicalCandidate);
    }
  }
  return selected;
}

function deduplicate(
  candidates: readonly FocusedMemoryReference[],
  excluded: ReadonlySet<string> = new Set(),
): Map<string, FocusedMemoryReference> {
  const values = new Map<string, FocusedMemoryReference>();
  for (const candidate of candidates) {
    const key = referenceKey(candidate);
    if (!excluded.has(key) && !values.has(key)) {
      values.set(key, candidate);
    }
  }
  return values;
}

function referenceKey(candidate: FocusedMemoryReference): string {
  return [
    candidate.meetingId,
    candidate.transcriptId,
    candidate.transcriptVersion,
    candidate.turnId,
    candidate.sourceStartCodePoint ?? "whole",
    candidate.sourceEndCodePoint ?? "whole",
  ].join("\u0000");
}
