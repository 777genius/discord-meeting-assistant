import type { HistoricalReleaseBindingV1 } from "../../domain/historical-evidence.js";
import type { LocallyRehydratedEvidenceBlockV1 } from "./historical-memory.js";

export interface HistoricalAuthorizationRequestV1 {
  readonly authorizationPrincipalRef: string;
  readonly roomId: string;
  readonly signal?: AbortSignal;
  readonly scopeId: string;
}

export interface HistoricalAuthorizationObservationV1 {
  readonly authorizationDigest: string;
  readonly authorizationEpoch: string;
  readonly authorized: boolean;
  readonly policyVersion: string;
}

export interface HistoricalAuthorizationPort {
  authorize(
    request: HistoricalAuthorizationRequestV1,
  ): Promise<HistoricalAuthorizationObservationV1>;
}

type CoverageTurnRelevanceV1 = "conflicting" | "context" | "direct";

/**
 * Local canonical identity selected by one question-specific semantic claim.
 * These identities are checkpoint data only; provider answer requests receive
 * newly assigned question-local evidence IDs after canonical rehydration.
 */
export interface CoverageSelectedTurnV1 {
  readonly blockLocator: string;
  readonly relevance: CoverageTurnRelevanceV1;
  readonly turnId: string;
}

export interface CoverageExtractV1 {
  readonly blockLocator: string;
  readonly evidenceLocators: readonly string[];
  readonly payload: Readonly<Record<string, boolean | number | string | readonly string[]>>;
  readonly selectedTurns: readonly CoverageSelectedTurnV1[];
  readonly selectionStatus: "no_match" | "selected";
  readonly schemaVersion: 1;
}

export class CoverageExtractionCapacityError extends Error {
  public override readonly name = "CoverageExtractionCapacityError";
}

export interface CoverageReductionV1 {
  readonly evidenceLocators: readonly string[];
  readonly payload: Readonly<Record<string, boolean | number | string | readonly string[]>>;
  readonly selectedTurns: readonly CoverageSelectedTurnV1[];
  readonly selectionStatus: "no_match" | "selected";
  readonly schemaVersion: 1;
}

export interface CoverageExtractorPort {
  /** Must change whenever extraction semantics or its qualified runtime change. */
  readonly profile: string;

  extract(input: {
    readonly block: LocallyRehydratedEvidenceBlockV1;
    readonly question: string;
    readonly signal?: AbortSignal;
  }): Promise<CoverageExtractV1>;
}

export interface CoverageReducerPort {
  /** Must change whenever reduction semantics or its qualified runtime change. */
  readonly profile: string;

  reduce(input: {
    readonly level: number;
    readonly question: string;
    readonly values: readonly (CoverageExtractV1 | CoverageReductionV1)[];
    readonly signal?: AbortSignal;
  }): Promise<CoverageReductionV1>;
}

export interface CoverageCheckpointLeaseV1 {
  readonly attempt: number;
  readonly bitmap: readonly boolean[];
  readonly checkpointId: string;
  readonly extracts: Readonly<Record<string, CoverageExtractV1>>;
  readonly fence: number;
  readonly planDigest: string;
  readonly reduction: CoverageReductionV1 | null;
  readonly state: "active" | "completed" | "failed" | "invalidated";
  readonly terminalReason: string | null;
}

export interface ExhaustiveCoverageStore {
  open(input: {
    readonly blockLocators: readonly string[];
    readonly checkpointId: string;
    readonly planDigest: string;
    readonly questionHash: string;
    readonly releaseBindings: readonly HistoricalReleaseBindingV1[];
    readonly retentionSeconds: number;
    readonly signal?: AbortSignal;
  }): Promise<CoverageCheckpointLeaseV1>;

  recordExtract(input: {
    readonly blockOrdinal: number;
    readonly checkpointId: string;
    readonly extract: CoverageExtractV1;
    readonly fence: number;
    readonly signal?: AbortSignal;
  }): Promise<CoverageCheckpointLeaseV1>;

  recordReduction(input: {
    readonly checkpointId: string;
    readonly fence: number;
    readonly reduction: CoverageReductionV1;
    readonly signal?: AbortSignal;
  }): Promise<void>;

  complete(input: {
    readonly checkpointId: string;
    readonly fence: number;
    readonly signal?: AbortSignal;
  }): Promise<void>;

  terminate(input: {
    readonly checkpointId: string;
    readonly fence: number;
    readonly reason: string;
    readonly signal?: AbortSignal;
    readonly state: "failed" | "invalidated";
  }): Promise<void>;

  /** Bounded maintenance that scrubs expired active/completed payloads. */
  scrubExpired(
    maximumRows: number,
    options?: { readonly signal?: AbortSignal },
  ): Promise<number>;
}
