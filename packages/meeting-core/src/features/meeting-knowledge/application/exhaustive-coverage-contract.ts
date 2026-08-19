import type { HistoricalReleaseBindingV1 } from "../domain/historical-evidence.js";
import {
  DEFAULT_HISTORICAL_EVIDENCE_BLOCK_POLICY,
  type HistoricalEvidenceBlockPolicyV1,
} from "./historical-index-plan.js";
import type {
  CoverageExtractV1,
  CoverageReductionV1,
  CoverageSelectedTurnV1,
  ExhaustiveCoverageStore,
  HistoricalAuthorizationObservationV1,
  HistoricalAuthorizationRequestV1,
} from "./ports/historical-grounding.js";
import type {
  HistoricalEvidenceSliceV1,
  HistoricalIndexPlanV1,
  LocallyRehydratedEvidenceBlockV1,
} from "./ports/historical-memory.js";

export interface ExhaustiveCoveragePolicyV1 {
  readonly blockPolicy: HistoricalEvidenceBlockPolicyV1;
  readonly checkpointRetentionSeconds: number;
  readonly maximumBlocks: number;
  readonly maximumCheckpointAttempts: number;
  readonly maximumCumulativeEvidenceUtf8Bytes: number;
  readonly maximumExtractPayloadUtf8Bytes: number;
  readonly maximumReduceCalls: number;
  readonly maximumReductionPayloadUtf8Bytes: number;
  readonly maximumSelectedTurns: number;
  readonly maximumSynthesisBlocks: number;
  /** Explicit application release binding for durable checkpoint reuse. */
  readonly processingRelease: string;
  readonly reduceFanIn: number;
  readonly version: "meeting-knowledge.exhaustive-coverage.v1";
}

type CoverageExtractInputV1 = Omit<CoverageExtractV1, "schemaVersion"> & {
  readonly schemaVersion: number;
};

type CoverageReductionInputV1 = Omit<CoverageReductionV1, "schemaVersion"> & {
  readonly schemaVersion: number;
};

type ExhaustiveCoveragePolicyInputV1 = Omit<ExhaustiveCoveragePolicyV1, "version"> & {
  readonly version: string;
};

export const DEFAULT_EXHAUSTIVE_COVERAGE_POLICY: ExhaustiveCoveragePolicyV1 =
  Object.freeze({
    blockPolicy: DEFAULT_HISTORICAL_EVIDENCE_BLOCK_POLICY,
    checkpointRetentionSeconds: 86_400,
    maximumBlocks: 2_048,
    maximumCheckpointAttempts: 8,
    maximumCumulativeEvidenceUtf8Bytes: 8_388_608,
    maximumExtractPayloadUtf8Bytes: 16_384,
    maximumReduceCalls: 1_024,
    maximumReductionPayloadUtf8Bytes: 32_768,
    maximumSelectedTurns: 256,
    maximumSynthesisBlocks: 64,
    processingRelease: "meeting-knowledge.exhaustive-coverage.r2",
    reduceFanIn: 8,
    version: "meeting-knowledge.exhaustive-coverage.v1",
  });

export interface ExhaustiveGroundingPlanV1 {
  readonly coverageBitmap: readonly true[];
  readonly coveragePlanDigest: string;
  readonly finalSynthesisAllowed: true;
  readonly reduction: CoverageReductionV1;
  readonly schemaVersion: 1;
  readonly selectedBlocks: readonly LocallyRehydratedEvidenceBlockV1[];
  /** Canonical local blocks are rehydrated once more immediately before generation. */
  readonly synthesisRequiresCanonicalRehydration: true;
  readonly strategy: "exhaustive_coverage";
}

export type ExhaustiveCoverageResultV1 =
  | { readonly reason: string; readonly status: "invalidated" | "unauthorized" | "unsupported" }
  | { readonly checkpointId: string; readonly reason: string; readonly status: "incomplete" }
  | { readonly plan: ExhaustiveGroundingPlanV1; readonly status: "ready" };

export interface ExhaustiveCoverageRequestV1 {
  readonly authorizationPrincipalRef: string;
  readonly question: string;
  readonly requestId: string;
  readonly roomId: string;
  readonly scopeId: string;
  readonly signal?: AbortSignal;
}

export interface LoadedCoveragePlan {
  /** Question-analysis slices aligned by ordinal with immutable canonical blocks. */
  readonly analysisTurns: readonly (readonly HistoricalEvidenceSliceV1[])[];
  readonly blocks: readonly LocallyRehydratedEvidenceBlockV1[];
  readonly digest: string;
  readonly indexPlans: readonly HistoricalIndexPlanV1[];
}

export interface ExtractedCoverage {
  readonly checkpoint: Awaited<ReturnType<ExhaustiveCoverageStore["open"]>>;
  readonly checkpointId: string;
  readonly extracts: readonly CoverageExtractV1[];
}

export interface CoverageFinalization {
  readonly authorizationBefore: HistoricalAuthorizationObservationV1;
  readonly authorizationRequest: HistoricalAuthorizationRequestV1;
  readonly bindings: readonly HistoricalReleaseBindingV1[];
  readonly extracted: ExtractedCoverage;
  readonly loaded: LoadedCoveragePlan;
  readonly reduction: CoverageReductionV1;
  readonly request: ExhaustiveCoverageRequestV1;
}

export function allDefined<T>(values: readonly (T | undefined)[]): values is readonly T[] {
  return values.every((value) => value !== undefined);
}

export function sameAuthorization(
  before: HistoricalAuthorizationObservationV1,
  after: HistoricalAuthorizationObservationV1,
): boolean {
  return before.authorized && after.authorized &&
    before.authorizationDigest === after.authorizationDigest &&
    before.authorizationEpoch === after.authorizationEpoch &&
    before.policyVersion === after.policyVersion;
}

function unique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].toSorted());
}

function payloadUtf8Bytes(
  payload: Readonly<Record<string, boolean | number | string | readonly string[]>>,
  maximumArrayItems: number,
): number {
  const entries = Object.entries(payload);
  if (entries.length > 64) {
    throw new Error("coverage payload contains too many fields");
  }
  for (const [key, value] of entries) {
    if (key.length === 0 || new TextEncoder().encode(key).byteLength > 128) {
      throw new Error("coverage payload field identity is invalid");
    }
    if (
      typeof value !== "boolean" &&
      typeof value !== "number" &&
      typeof value !== "string" &&
      !Array.isArray(value)
    ) {
      throw new Error("coverage payload value is outside its structured contract");
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("coverage payload number must be finite");
    }
    if (
      Array.isArray(value) &&
      (value.length > maximumArrayItems || value.some((item) => typeof item !== "string"))
    ) {
      throw new Error("coverage payload array is outside its bounded contract");
    }
  }
  return new TextEncoder().encode(JSON.stringify(payload)).byteLength;
}

export function compareOpaque(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sameBindings(
  left: readonly HistoricalReleaseBindingV1[],
  right: readonly HistoricalReleaseBindingV1[],
): boolean {
  const orderedLeft = left.toSorted((a, b) => compareOpaque(a.releaseId, b.releaseId));
  const orderedRight = right.toSorted((a, b) => compareOpaque(a.releaseId, b.releaseId));
  return orderedLeft.length === orderedRight.length && orderedLeft.every((binding, index) => {
    const candidate = orderedRight[index];
    return candidate !== undefined &&
      binding.releaseId === candidate.releaseId &&
      binding.desiredGeneration === candidate.desiredGeneration &&
      binding.acceptedMeetingRevision === candidate.acceptedMeetingRevision &&
      binding.scopeId === candidate.scopeId &&
      binding.roomId === candidate.roomId &&
      binding.meetingId === candidate.meetingId &&
      binding.transcriptId === candidate.transcriptId &&
      binding.transcriptVersion === candidate.transcriptVersion;
  });
}

export function validateExtract(
  extract: CoverageExtractInputV1,
  block: LocallyRehydratedEvidenceBlockV1,
  policy: ExhaustiveCoveragePolicyV1,
  analysisTurns: readonly HistoricalEvidenceSliceV1[] = block.turns,
): CoverageExtractV1 {
  const selectedTurns = validateSelectedTurns(
    extract.selectedTurns,
    new Map([[block.candidateLocator, new Set(analysisTurns.map(({ turnId }) => turnId))]]),
    policy.maximumSelectedTurns,
  );
  const selectedLocators = unique(selectedTurns.map(({ blockLocator }) => blockLocator));
  if (
    extract.schemaVersion !== 1 ||
    extract.blockLocator !== block.candidateLocator ||
    extract.selectionStatus !== (selectedTurns.length === 0 ? "no_match" : "selected") ||
    extract.evidenceLocators.length > 1 ||
    extract.evidenceLocators.some((locator) => locator !== block.candidateLocator) ||
    !sameStrings(unique(extract.evidenceLocators), selectedLocators)
  ) {
    throw new Error("coverage extractor returned an invalid evidence-only contract");
  }
  if (
    payloadUtf8Bytes(extract.payload, policy.maximumBlocks) >
      policy.maximumExtractPayloadUtf8Bytes
  ) {
    throw new Error("coverage extractor payload exceeds its qualified byte bound");
  }
  return Object.freeze({
    ...extract,
    evidenceLocators: unique(extract.evidenceLocators),
    payload: Object.freeze({ ...extract.payload }),
    selectedTurns,
    selectionStatus: extract.selectionStatus,
    schemaVersion: 1,
  });
}

export function validateReduction(
  reduction: CoverageReductionInputV1,
  allowedEvidence: ReadonlySet<string>,
  allowedSelectedTurns: ReadonlySet<string>,
  policy: ExhaustiveCoveragePolicyV1,
): CoverageReductionV1 {
  const allowedByBlock = new Map<string, Set<string>>();
  for (const identity of allowedSelectedTurns) {
    const separator = identity.indexOf("\u0000");
    if (separator < 1) {
      throw new Error("coverage reducer allowed-turn identity is invalid");
    }
    const blockLocator = identity.slice(0, separator);
    const turnId = identity.slice(separator + 1);
    const turns = allowedByBlock.get(blockLocator) ?? new Set<string>();
    turns.add(turnId);
    allowedByBlock.set(blockLocator, turns);
  }
  const selectedTurns = validateSelectedTurns(
    reduction.selectedTurns,
    allowedByBlock,
    policy.maximumSelectedTurns,
  );
  const selectedLocators = unique(selectedTurns.map(({ blockLocator }) => blockLocator));
  if (
    reduction.schemaVersion !== 1 ||
    reduction.selectionStatus !== (selectedTurns.length === 0 ? "no_match" : "selected") ||
    reduction.evidenceLocators.length > allowedEvidence.size ||
    reduction.evidenceLocators.length > policy.maximumSynthesisBlocks ||
    reduction.evidenceLocators.some((locator) => !allowedEvidence.has(locator)) ||
    !sameStrings(unique(reduction.evidenceLocators), selectedLocators)
  ) {
    throw new Error("coverage reducer returned evidence outside its bounded inputs");
  }
  if (
    payloadUtf8Bytes(reduction.payload, policy.maximumBlocks) >
      policy.maximumReductionPayloadUtf8Bytes
  ) {
    throw new Error("coverage reducer payload exceeds its qualified byte bound");
  }
  return Object.freeze({
    ...reduction,
    evidenceLocators: unique(reduction.evidenceLocators),
    payload: Object.freeze({ ...reduction.payload }),
    selectedTurns,
    selectionStatus: reduction.selectionStatus,
    schemaVersion: 1,
  });
}

function isBoundedInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

export function assertExhaustiveCoveragePolicy(
  policy: ExhaustiveCoveragePolicyInputV1,
): ExhaustiveCoveragePolicyV1 {
  if (
    policy.version !== "meeting-knowledge.exhaustive-coverage.v1" ||
    !isBoundedInteger(policy.checkpointRetentionSeconds, 60, 604_800) ||
    !isBoundedInteger(policy.maximumBlocks, 1, 2_048) ||
    !isBoundedInteger(policy.maximumCheckpointAttempts, 1, 100) ||
    !isBoundedInteger(
      policy.maximumCumulativeEvidenceUtf8Bytes,
      1_024,
      67_108_864,
    ) ||
    !isBoundedInteger(policy.maximumExtractPayloadUtf8Bytes, 256, 65_536) ||
    !isBoundedInteger(policy.maximumReductionPayloadUtf8Bytes, 256, 131_072) ||
    !isBoundedInteger(policy.maximumReduceCalls, 1, 4_096) ||
    !isBoundedInteger(policy.maximumSelectedTurns, 1, 256) ||
    !isBoundedInteger(policy.maximumSynthesisBlocks, 1, 256) ||
    !isBoundedInteger(policy.reduceFanIn, 2, 32) ||
    policy.processingRelease.trim().length === 0 ||
    new TextEncoder().encode(policy.processingRelease).byteLength > 256
  ) {
    throw new RangeError("exhaustive coverage policy is outside its qualified bounds");
  }
  return Object.freeze({ ...policy, version: "meeting-knowledge.exhaustive-coverage.v1" });
}

export function selectedTurnIdentity(
  turn: Pick<CoverageSelectedTurnV1, "blockLocator" | "turnId">,
): string {
  return `${turn.blockLocator}\u0000${turn.turnId}`;
}

function validateSelectedTurns(
  selected: readonly CoverageSelectedTurnV1[],
  allowedByBlock: ReadonlyMap<string, ReadonlySet<string>>,
  maximum: number,
): readonly CoverageSelectedTurnV1[] {
  const typedSelection: readonly CoverageSelectedTurnV1[] = selected;
  if (!Array.isArray(selected) || typedSelection.length > maximum) {
    throw new Error("coverage selected turns exceed their bounded contract");
  }
  const identities = new Set<string>();
  const normalized = typedSelection.map((turn) => {
    const allowedTurns = allowedByBlock.get(turn.blockLocator);
    const identity = selectedTurnIdentity(turn);
    if (
      allowedTurns === undefined ||
      !allowedTurns.has(turn.turnId) ||
      !new Set(["conflicting", "context", "direct"]).has(turn.relevance) ||
      identities.has(identity)
    ) {
      throw new Error("coverage selected turn is outside its canonical input");
    }
    identities.add(identity);
    return Object.freeze({ ...turn });
  }).toSorted((left, right) =>
    compareOpaque(left.blockLocator, right.blockLocator) ||
    compareOpaque(left.turnId, right.turnId)
  );
  return Object.freeze(normalized);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function boundedCoverageIdentity(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || new TextEncoder().encode(normalized).byteLength > 4_096) {
    throw new RangeError(`${field} is outside its bounded contract`);
  }
  return normalized;
}
