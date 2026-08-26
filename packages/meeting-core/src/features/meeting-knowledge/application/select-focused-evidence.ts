import {
  createFocusedRetrievalGroundingPlan,
  type FocusedMemoryReference,
  type GroundingPlan,
  type RehydratedEvidenceTurn,
} from "../domain/grounding-plan.js";
import { historicalEvidenceSourceKey } from
  "../domain/historical-evidence-source.js";
import type { QuestionBindingSnapshot } from "../domain/question-job.js";
import { admittedHumanActors } from "./admitted-human-evidence.js";
import { authorityMatchesBinding } from "./final-reply-checks.js";
import type {
  FocusedEvidenceSelectionCandidateV1,
  FocusedEvidenceSelectionResultV1,
  FocusedEvidenceSelectorPort,
} from "./ports/focused-evidence-selector.js";
import { qualifiedFocusedEvidenceCandidateLimit } from
  "./ports/focused-evidence-selector.js";
import type { FinalReplyEvidencePort } from "./ports/final-reply.js";

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
      readonly selectedTurnIndices: readonly number[];
      readonly status: "selected";
      readonly turns: readonly RehydratedEvidenceTurn[];
    }
  | {
      readonly mode: "lexical_fallback" | "semantic";
      readonly selectedTurnIndices: readonly [];
      readonly status: "insufficient_evidence";
      readonly turns: readonly [];
    };

export type SelectedFocusedEvidencePreparation =
  | {
      readonly authority: Extract<
        Awaited<ReturnType<FinalReplyEvidencePort["rehydrateSelectedEvidence"]>>,
        { readonly status: "current" }
      >["binding"];
      readonly plan: GroundingPlan;
      readonly status: "prepared";
    }
  | {
      readonly status:
        | "insufficient_evidence"
        | "stale_binding"
        | "unavailable";
    };

export async function prepareSelectedFocusedEvidence(input: {
  readonly authorityGeneration: string;
  readonly binding: QuestionBindingSnapshot;
  readonly evidence: FinalReplyEvidencePort;
  readonly hydrationReferences: readonly FocusedMemoryReference[];
  readonly providerAttemptId: string;
  readonly question: string;
  readonly selector: Pick<SelectFocusedEvidence, "execute">;
  readonly turns: readonly RehydratedEvidenceTurn[];
}): Promise<SelectedFocusedEvidencePreparation> {
  const selection = await input.selector.execute({
    attemptId: input.providerAttemptId,
    question: input.question,
    turns: input.turns,
  });
  if (selection.status === "insufficient_evidence" ||
      selection.mode === "lexical_fallback") {
    return { status: "insufficient_evidence" };
  }
  const references = selection.selectedTurnIndices.map(
    (index) => input.hydrationReferences[index],
  );
  if (!references.every(isReference)) {
    return { status: "unavailable" };
  }
  const refreshed = await input.evidence.rehydrateSelectedEvidence(
    input.binding,
    references,
  );
  if (refreshed.status === "stale") {
    return { status: "stale_binding" };
  }
  if (refreshed.status !== "current") {
    return { status: "unavailable" };
  }
  if (!authorityMatchesBinding(refreshed.binding, input.binding)) {
    return { status: "stale_binding" };
  }
  if (!focusedHydrationMatchesReferences(
    input.binding,
    references,
    refreshed.turns,
  )) {
    return { status: "unavailable" };
  }
  return {
    authority: refreshed.binding,
    plan: createFocusedRetrievalGroundingPlan({
      authorityGeneration: input.authorityGeneration,
      coverage: "sufficient",
      humanActorIds: admittedHumanActors(refreshed),
      turns: refreshed.turns,
    }),
    status: "prepared",
  };
}

/** V2 accepts Infinity's persisted provider order and never invokes the legacy selector. */
export async function preparePersistedRetrievalV2Evidence(input: {
  readonly authorityGeneration: string;
  readonly binding: QuestionBindingSnapshot;
  readonly evidence: FinalReplyEvidencePort;
  readonly evidenceByteLimit: number;
  readonly references: readonly FocusedMemoryReference[];
  readonly turns: readonly RehydratedEvidenceTurn[];
}): Promise<SelectedFocusedEvidencePreparation> {
  const evidenceBytes = new TextEncoder().encode(
    input.turns.map(({ text }) => text).join("\n"),
  ).byteLength;
  if (evidenceBytes < 1 || evidenceBytes > input.evidenceByteLimit) {
    return { status: "unavailable" };
  }
  const refreshed = await input.evidence.rehydrateSelectedEvidence(
    input.binding,
    input.references,
  );
  if (refreshed.status === "stale") {
    return { status: "stale_binding" };
  }
  if (refreshed.status !== "current") {
    return { status: "unavailable" };
  }
  if (!authorityMatchesBinding(refreshed.binding, input.binding)) {
    return { status: "stale_binding" };
  }
  if (
    !focusedHydrationMatchesReferences(input.binding, input.references,
      refreshed.turns)) {
    return { status: "unavailable" };
  }
  const refreshedBytes = new TextEncoder().encode(
    refreshed.turns.map(({ text }) => text).join("\n"),
  ).byteLength;
  if (refreshedBytes !== evidenceBytes || refreshedBytes > input.evidenceByteLimit) {
    return { status: "unavailable" };
  }
  return Object.freeze({
    authority: refreshed.binding,
    plan: createFocusedRetrievalGroundingPlan({
      authorityGeneration: input.authorityGeneration,
      coverage: "sufficient",
      humanActorIds: admittedHumanActors(refreshed),
      turns: refreshed.turns,
    }),
    status: "prepared",
  });
}

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
    readonly attemptId: string;
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
        attemptId: input.attemptId,
        candidates,
        question: boundedText(input.question, MAX_QUESTION_BYTES),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }), candidates);
    } catch {
      input.signal?.throwIfAborted();
      mode = "lexical_fallback";
      result = lexicalFallback(input.question, input.turns);
    }
    const selectedTurnIndices = result.status === "selected"
      ? result.selectedCandidateIds.map(candidateIndex)
      : [];
    const turns = result.status === "selected"
      ? selectedTurnIndices.map((index) => input.turns[index])
      : [];
    const selection = result.status === "selected" && turns.every(isTurn)
      ? {
          mode,
          selectedTurnIndices: Object.freeze(selectedTurnIndices),
          status: "selected" as const,
          turns: Object.freeze(turns),
        }
      : {
          mode,
          selectedTurnIndices: [] as const,
          status: "insufficient_evidence" as const,
          turns: [] as const,
        };
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
  if (turns.length < 1 || turns.length > qualifiedFocusedEvidenceCandidateLimit) {
    throw new RangeError(
      `focused selection requires 1..${qualifiedFocusedEvidenceCandidateLimit} canonical turns`,
    );
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

function isReference(
  value: FocusedMemoryReference | undefined,
): value is FocusedMemoryReference {
  return value !== undefined;
}

export function focusedHydrationMatchesReferences(
  binding: QuestionBindingSnapshot,
  references: readonly FocusedMemoryReference[],
  turns: readonly RehydratedEvidenceTurn[],
): boolean {
  return references.length === turns.length && references.every((reference, index) => {
    const turn = turns[index];
    if (turn === undefined ||
        turn.turnId !== reference.turnId ||
        turn.turnHash !== reference.turnHash) {
      return false;
    }
    if (turn.source === undefined) {
      return reference.meetingId === binding.meetingId &&
        reference.historicalSource === undefined &&
        reference.transcriptId === binding.transcriptId &&
        reference.transcriptVersion === binding.transcriptVersion &&
        reference.sourceStartCodePoint === undefined &&
        reference.sourceEndCodePoint === undefined;
    }
    return turn.source.meetingId === reference.meetingId &&
      historicalEvidenceSourceKey(turn.source.historicalSource) ===
        historicalEvidenceSourceKey(reference.historicalSource) &&
      turn.source.transcriptId === reference.transcriptId &&
      turn.source.transcriptVersion === reference.transcriptVersion &&
      turn.source.sourceStartCodePoint === reference.sourceStartCodePoint &&
      turn.source.sourceEndCodePoint === reference.sourceEndCodePoint;
  });
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
