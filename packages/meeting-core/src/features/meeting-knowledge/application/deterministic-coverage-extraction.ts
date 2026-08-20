import type {
  CoverageExtractV1,
  CoverageExtractorPort,
  CoverageReducerPort,
  CoverageReductionV1,
  CoverageSelectedTurnV1,
} from "./ports/historical-grounding.js";
import { selectedTurnIdentity } from "./exhaustive-coverage-contract.js";

const word = /[\p{L}\p{N}]{3,}/gu;
const ignoredQuestionTerms = new Set([
  "across", "address", "addressed", "all", "answer", "complete", "count",
  "cover", "covered", "discuss", "discussed", "each", "entire", "enumerate",
  "every", "exhaustive", "full", "history", "list", "meeting", "meetings",
  "mention", "mentioned", "overview", "present", "question", "raise", "raised",
  "recap", "record", "recorded", "summarize", "summary", "tell", "the",
  "timeline", "was", "were", "what", "which", "whole", "все", "всех", "всю",
  "историю", "кажд", "посч", "сколько",
].map((value) => value.slice(0, 6)));
const correctionOrConflict = /\b(?:actually|correction|instead|not|rather|revised|updated)\b|(?:вообще-то|исправ|не\s|нет|обнов|поправ|уточн)/iu;

function terms(value: string): ReadonlySet<string> {
  return new Set(
    (value.normalize("NFKC").toLocaleLowerCase().match(word) ?? [])
      .map((term) => term.length > 6 ? term.slice(0, 6) : term)
      .filter((term) => !ignoredQuestionTerms.has(term)),
  );
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

export class CoverageSelectionLimitExceededError extends Error {
  public override readonly name = "CoverageSelectionLimitExceededError";
}

/**
 * Deterministic question-specific extractor used by providerless qualification
 * and as the bounded reducer for provider-backed extracts. It emits an explicit
 * no-match result for every inspected block and never truncates a relevant
 * canonical selection. Exceeding a synthesis bound is an honest unsupported
 * outcome, not permission to claim completeness from a prefix.
 */
export class DeterministicExhaustiveCoverageExtraction
  implements CoverageExtractorPort, CoverageReducerPort
{
  public readonly profile =
    "meeting-knowledge.coverage.question-specific-lexical-reducer.v2";

  public constructor(
    private readonly maximumSynthesisBlocks = 64,
    private readonly maximumSelectedTurns = 256,
  ) {
    assertReductionBounds(maximumSynthesisBlocks, maximumSelectedTurns);
  }

  public extract(
    input: Parameters<CoverageExtractorPort["extract"]>[0],
  ): Promise<CoverageExtractV1> {
    input.signal?.throwIfAborted();
    const queryTerms = terms(input.question);
    const matchedOrdinals = input.analysisTurns.flatMap((turn, ordinal) => {
      const turnTerms = terms(turn.text);
      return (queryTerms.size === 0 ||
          [...queryTerms].some((term) => turnTerms.has(term)))
        ? [ordinal]
        : [];
    });
    const selectedOrdinals = new Set<number>();
    for (const ordinal of matchedOrdinals) {
      selectedOrdinals.add(ordinal);
      if (ordinal > 0) {
        selectedOrdinals.add(ordinal - 1);
      }
      if (ordinal + 1 < input.analysisTurns.length) {
        selectedOrdinals.add(ordinal + 1);
      }
    }
    for (const [ordinal, turn] of input.analysisTurns.entries()) {
      if (matchedOrdinals.length > 0 && correctionOrConflict.test(turn.text)) {
        selectedOrdinals.add(ordinal);
      }
    }
    const selectedTurns = [...selectedOrdinals].toSorted((left, right) => left - right)
      .map((ordinal): CoverageSelectedTurnV1 | undefined => {
        const turn = input.analysisTurns[ordinal];
        if (turn === undefined) {
          return undefined;
        }
        return Object.freeze({
          blockLocator: input.block.candidateLocator,
          relevance: matchedOrdinals.includes(ordinal)
            ? "direct" as const
            : correctionOrConflict.test(turn.text)
              ? "conflicting" as const
              : "context" as const,
          sourceEndCodePoint: turn.sourceEndCodePoint,
          sourceRef: turn.sourceRef,
          sourceStartCodePoint: turn.sourceStartCodePoint,
          turnId: turn.turnId,
        });
      })
      .filter((turn): turn is CoverageSelectedTurnV1 => turn !== undefined);
    if (selectedTurns.length > this.maximumSelectedTurns) {
      throw new CoverageSelectionLimitExceededError(
        "one coverage extract exceeds the qualified canonical turn bound",
      );
    }
    return Promise.resolve(Object.freeze({
      blockLocator: input.block.candidateLocator,
      evidenceLocators: Object.freeze(selectedTurns.length === 0
        ? []
        : [input.block.candidateLocator]),
      payload: Object.freeze({
        blocksReviewed: 1,
        lexicalMatches: matchedOrdinals.length,
        selectedTurnCount: selectedTurns.length,
        turnsReviewed: input.analysisTurns.length,
      }),
      selectedTurns: Object.freeze(selectedTurns),
      selectionStatus: selectedTurns.length === 0 ? "no_match" : "selected",
      schemaVersion: 1,
    }));
  }

  public reduce(
    input: Parameters<CoverageReducerPort["reduce"]>[0],
  ): Promise<CoverageReductionV1> {
    return reduceSelections(
      input,
      this.maximumSynthesisBlocks,
      this.maximumSelectedTurns,
      "lexicalMatches",
    );
  }
}

/** Deterministic, lossless union for independently validated semantic extracts. */
export class DeterministicCoverageReducer implements CoverageReducerPort {
  public readonly profile = "meeting-knowledge.coverage.semantic-union-reducer.v1";

  public constructor(
    private readonly maximumSynthesisBlocks = 64,
    private readonly maximumSelectedTurns = 256,
  ) {
    assertReductionBounds(maximumSynthesisBlocks, maximumSelectedTurns);
  }

  public reduce(
    input: Parameters<CoverageReducerPort["reduce"]>[0],
  ): Promise<CoverageReductionV1> {
    return reduceSelections(
      input,
      this.maximumSynthesisBlocks,
      this.maximumSelectedTurns,
      "semanticClaimCount",
    );
  }
}

function assertReductionBounds(
  maximumSynthesisBlocks: number,
  maximumSelectedTurns: number,
): void {
  if (
    !Number.isSafeInteger(maximumSynthesisBlocks) ||
    maximumSynthesisBlocks < 1 ||
    maximumSynthesisBlocks > 256 ||
    !Number.isSafeInteger(maximumSelectedTurns) ||
    maximumSelectedTurns < 1 ||
    maximumSelectedTurns > 256
  ) {
    throw new RangeError("deterministic coverage synthesis block bound is invalid");
  }
}

function reduceSelections(
  input: Parameters<CoverageReducerPort["reduce"]>[0],
  maximumSynthesisBlocks: number,
  maximumSelectedTurns: number,
  aggregateField: "lexicalMatches" | "semanticClaimCount",
): Promise<CoverageReductionV1> {
  input.signal?.throwIfAborted();
  const selected = new Map<string, CoverageSelectedTurnV1>();
  for (const value of input.values) {
    for (const turn of value.selectedTurns) {
      const identity = selectedTurnIdentity(turn);
      const prior = selected.get(identity);
      if (prior === undefined || preferredSelection(turn, prior) === turn) {
        selected.set(identity, turn);
      }
    }
  }
  const selectedTurns = [...selected.values()].toSorted((left, right) =>
    left.blockLocator.localeCompare(right.blockLocator) ||
    left.sourceRef.localeCompare(right.sourceRef) ||
    left.sourceStartCodePoint - right.sourceStartCodePoint ||
    left.sourceEndCodePoint - right.sourceEndCodePoint ||
    left.turnId.localeCompare(right.turnId)
  );
  const evidenceLocators = [...new Set(
    selectedTurns.map(({ blockLocator }) => blockLocator),
  )].toSorted();
  if (
    evidenceLocators.length > maximumSynthesisBlocks ||
    selectedTurns.length > maximumSelectedTurns
  ) {
    throw new CoverageSelectionLimitExceededError(
      "coverage reduction exceeds the qualified synthesis selection",
    );
  }
  const aggregate = input.values.reduce(
    (total, value) => total + count(value.payload[aggregateField]),
    0,
  );
  return Promise.resolve(Object.freeze({
    evidenceLocators: Object.freeze(evidenceLocators),
    payload: Object.freeze({
      blocksReviewed: input.values.reduce(
        (total, value) => total + count(value.payload.blocksReviewed),
        0,
      ),
      [aggregateField]: aggregate,
      selectedTurnCount: selectedTurns.length,
      turnsReviewed: input.values.reduce(
        (total, value) => total + count(value.payload.turnsReviewed),
        0,
      ),
    }),
    selectedTurns: Object.freeze(selectedTurns),
    selectionStatus: selectedTurns.length === 0 ? "no_match" : "selected",
    schemaVersion: 1,
  }));
}

function preferredSelection(
  left: CoverageSelectedTurnV1,
  right: CoverageSelectedTurnV1,
): CoverageSelectedTurnV1 {
  const relevance = { conflicting: 2, context: 1, direct: 3 } as const;
  const difference = relevance[left.relevance] - relevance[right.relevance];
  return difference > 0 ||
      (difference === 0 && left.blockLocator.localeCompare(right.blockLocator) < 0)
    ? left
    : right;
}
