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
  const scores = new Map(
    result.plan.sources.map(({ locator, qualifiedScore }) => [
      locator,
      normalizedScore(qualifiedScore),
    ]),
  );
  return Object.freeze(result.plan.blocks.flatMap((block) =>
    block.turns.map((turn, turnIndex) => Object.freeze({
      meetingId: block.binding.meetingId,
      // A provider score qualifies the block, not every turn inside it. Decay
      // successive turns so one wide block cannot monopolize the fused top-k.
      relevanceScore: (scores.get(block.candidateLocator) ?? 0) /
        (turnIndex + 1),
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

/** Deterministic score fusion that retains both non-empty evidence sources. */
function crossSourceRank(
  current: readonly FocusedMemoryReference[],
  historical: readonly FocusedMemoryReference[],
  maximumCandidates: number,
): FocusedMemoryReference[] {
  const decorated = [
    ...current.map((candidate, rank) => ({ candidate, rank, source: 0 })),
    ...historical.map((candidate, rank) => ({ candidate, rank, source: 1 })),
  ].toSorted((left, right) =>
    scoreFor(right.candidate, right.rank) - scoreFor(left.candidate, left.rank) ||
    left.source - right.source ||
    left.rank - right.rank ||
    referenceKey(left.candidate).localeCompare(referenceKey(right.candidate))
  );
  const selected: FocusedMemoryReference[] = [];
  const reservedCurrent = current[0];
  const reservedHistorical = historical[0];
  if (reservedCurrent !== undefined && maximumCandidates > 0) {
    selected.push(reservedCurrent);
  }
  if (reservedHistorical !== undefined && selected.length < maximumCandidates) {
    selected.push(reservedHistorical);
  }
  for (const { candidate } of decorated) {
    if (selected.length >= maximumCandidates) {
      break;
    }
    if (candidate !== reservedCurrent && candidate !== reservedHistorical) {
      selected.push(candidate);
    }
  }
  return selected;
}

function scoreFor(candidate: FocusedMemoryReference, rank: number): number {
  return candidate.relevanceScore ?? 1 / (rank + 2);
}

function normalizedScore(score: number): number {
  return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
}

function deduplicate(
  candidates: readonly FocusedMemoryReference[],
  excluded: ReadonlySet<string> = new Set(),
): Map<string, FocusedMemoryReference> {
  const values = new Map<string, FocusedMemoryReference>();
  for (const candidate of candidates) {
    const key = referenceKey(candidate);
    const previous = values.get(key);
    if (!excluded.has(key) && (
      previous === undefined ||
      (candidate.relevanceScore ?? 0) > (previous.relevanceScore ?? 0)
    )) {
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
