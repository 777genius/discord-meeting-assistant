import type { RehydratedEvidenceTurn } from "../domain/grounding-plan.js";
import type {
  FocusedEvidenceSelectionCandidateV1,
  FocusedEvidenceSelectionResultV1,
  FocusedEvidenceSelectorPort,
} from "./ports/focused-evidence-selector.js";

const MAX_CANDIDATES = 40;
const MAX_SELECTED = 5;
const MAX_SNIPPET_BYTES = 1_600;
const MAX_QUESTION_BYTES = 4_096;
const stopWords = new Set([
  "a", "an", "and", "are", "did", "do", "for", "how", "in", "is", "it",
  "of", "on", "or", "the", "to", "was", "what", "when", "where", "who", "why",
  "а", "был", "была", "были", "в", "где", "для", "и", "или", "как", "когда",
  "кто", "на", "о", "по", "почему", "что", "это",
]);

export type FocusedEvidenceSelection =
  | {
      readonly mode: "lexical_fallback" | "semantic";
      readonly status: "selected";
      readonly turns: readonly RehydratedEvidenceTurn[];
    }
  | {
      readonly mode: "lexical_fallback" | "semantic";
      readonly status: "insufficient_evidence";
      readonly turns: readonly [];
    };

export class SelectFocusedEvidence {
  public constructor(
    private readonly selector: FocusedEvidenceSelectorPort,
    private readonly observe: (measurement: {
      readonly candidateCount: number;
      readonly elapsedMilliseconds: number;
      readonly mode: "lexical_fallback" | "semantic";
      readonly profile: string;
      readonly selectedCount: number;
      readonly status: FocusedEvidenceSelection["status"];
    }) => void,
    private readonly now: () => number,
  ) {}

  public async execute(input: {
    readonly question: string;
    readonly signal?: AbortSignal;
    readonly turns: readonly RehydratedEvidenceTurn[];
  }): Promise<FocusedEvidenceSelection> {
    input.signal?.throwIfAborted();
    const candidates = buildCandidates(input.turns);
    const startedAt = this.now();
    let mode: FocusedEvidenceSelection["mode"] = "semantic";
    let result: FocusedEvidenceSelectionResultV1;
    try {
      result = validateResult(await this.selector.select({
        candidates,
        question: boundedText(input.question, MAX_QUESTION_BYTES),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }), candidates);
    } catch {
      input.signal?.throwIfAborted();
      mode = "lexical_fallback";
      result = lexicalFallback(input.question, input.turns);
    }
    const turns = result.status === "selected"
      ? result.selectedCandidateIds.map((id) => input.turns[candidateIndex(id)])
      : [];
    const selection = result.status === "selected" && turns.every(isTurn)
      ? { mode, status: "selected" as const, turns: Object.freeze(turns) }
      : { mode, status: "insufficient_evidence" as const, turns: [] as const };
    const elapsed = this.now() - startedAt;
    try {
      this.observe({
        candidateCount: candidates.length,
        elapsedMilliseconds: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0,
        mode,
        profile: this.selector.profile,
        selectedCount: selection.turns.length,
        status: selection.status,
      });
    } catch {
      // Telemetry cannot change a grounding decision.
    }
    return Object.freeze(selection);
  }
}

function buildCandidates(
  turns: readonly RehydratedEvidenceTurn[],
): readonly FocusedEvidenceSelectionCandidateV1[] {
  if (turns.length < 1 || turns.length > MAX_CANDIDATES) {
    throw new RangeError("focused selection requires 1..40 canonical turns");
  }
  const speakers = new Map<string, string>();
  return Object.freeze(turns.map((turn, index) => {
    const speakerReference = speakers.get(turn.speakerId) ??
      `S${speakers.size + 1}`;
    speakers.set(turn.speakerId, speakerReference);
    return Object.freeze({
      candidateId: candidateId(index),
      endMs: turn.endMs,
      snippet: boundedText(turn.text, MAX_SNIPPET_BYTES),
      speakerReference,
      startMs: turn.startMs,
    });
  }));
}

function boundedText(value: string, maximumBytes: number): string {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) {
    throw new RangeError("focused selection text is empty");
  }
  let result = "";
  for (const character of normalized) {
    if (bytes(result + character) > maximumBytes) {
      break;
    }
    result += character;
  }
  return result;
}

function validateResult(
  result: FocusedEvidenceSelectionResultV1,
  candidates: readonly FocusedEvidenceSelectionCandidateV1[],
): FocusedEvidenceSelectionResultV1 {
  const value: unknown = result;
  if (typeof value !== "object" || value === null) {
    throw new Error("focused selector returned a malformed result");
  }
  const ids: unknown = Reflect.get(value, "selectedCandidateIds");
  const status: unknown = Reflect.get(value, "status");
  if (!Array.isArray(ids) ||
      !ids.every((id: unknown): id is string => typeof id === "string")) {
    throw new Error("focused selector returned malformed candidate identities");
  }
  const known = new Set(candidates.map(({ candidateId: id }) => id));
  if (
    Reflect.get(value, "schemaVersion") !== 1 ||
    ids.length > MAX_SELECTED ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !known.has(id)) ||
    (status !== "selected" && status !== "insufficient_evidence") ||
    (status === "selected") !== (ids.length > 0)
  ) {
    throw new Error("focused selector returned invalid candidate identities");
  }
  return Object.freeze({
    schemaVersion: 1,
    selectedCandidateIds: Object.freeze(ids),
    status,
  }) as FocusedEvidenceSelectionResultV1;
}

function lexicalFallback(
  question: string,
  turns: readonly RehydratedEvidenceTurn[],
): FocusedEvidenceSelectionResultV1 {
  const wanted = terms(question);
  const ranked = turns.map((turn, index) => ({
    index,
    score: [...terms(turn.text)].filter((term) => wanted.has(term)).length,
    turn,
  })).filter(({ score }) => score > 0)
    .toSorted((left, right) => right.score - left.score || left.index - right.index);
  const selected: typeof ranked = [];
  const buckets = new Set<string>();
  for (const item of ranked) {
    const bucket = `${item.turn.speakerId}:${Math.floor(item.turn.startMs / 60_000)}`;
    if (!buckets.has(bucket)) {
      selected.push(item);
      buckets.add(bucket);
    }
    if (selected.length === MAX_SELECTED) {
      return selectionResult(selected);
    }
  }
  for (const item of ranked) {
    if (!selected.includes(item)) {
      selected.push(item);
    }
    if (selected.length === MAX_SELECTED) {
      break;
    }
  }
  return selectionResult(selected);
}

function selectionResult(
  selected: readonly { readonly index: number }[],
): FocusedEvidenceSelectionResultV1 {
  const selectedCandidateIds = Object.freeze(
    selected.map(({ index }) => candidateId(index)),
  );
  return selectedCandidateIds.length > 0
    ? Object.freeze({
        schemaVersion: 1,
        selectedCandidateIds,
        status: "selected",
      })
    : Object.freeze({
        schemaVersion: 1,
        selectedCandidateIds: [] as const,
        status: "insufficient_evidence",
      });
}

function terms(value: string): Set<string> {
  return new Set(value.normalize("NFKC").toLowerCase()
    .match(/[\p{L}\p{N}]{2,}/gu)?.filter((term) => !stopWords.has(term)) ?? []);
}

function candidateId(index: number): string {
  return `candidate-${String(index + 1).padStart(6, "0")}`;
}

function candidateIndex(id: string): number {
  return Number(id.slice(-6)) - 1;
}

function isTurn(value: RehydratedEvidenceTurn | undefined):
  value is RehydratedEvidenceTurn {
  return value !== undefined;
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
