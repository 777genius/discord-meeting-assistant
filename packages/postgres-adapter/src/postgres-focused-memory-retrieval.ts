import type {
  CanonicalEvidenceTurn,
  FocusedMemoryReference,
  FocusedMemoryRetrievalPort,
  FocusedMemoryRetrievalResult,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { Pool } from "pg";

import {
  canonicalFinalReplyTurnHash,
  loadCurrentReplyAuthority,
  type ResolvedFinalReplyAuthority,
} from "./postgres-final-reply-evidence.js";

interface ScoredTurn {
  readonly index: number;
  readonly matchedTerms: number;
  readonly score: number;
  readonly turn: CanonicalEvidenceTurn;
}

const ignoredQueryTerms = new Set([
  "about",
  "after",
  "answer",
  "could",
  "did",
  "does",
  "from",
  "have",
  "please",
  "tell",
  "the",
  "that",
  "their",
  "there",
  "these",
  "this",
  "what",
  "when",
  "where",
  "which",
  "who",
  "would",
  "were",
  "was",
  "были",
  "было",
  "быть",
  "какая",
  "какие",
  "какой",
  "когда",
  "котор",
  "ответ",
  "после",
  "пожал",
  "расск",
  "сказа",
  "этого",
  "что",
].map(termRoot));

const correctionOrConflict = /\b(?:actually|correction|instead|not|rather|revised|updated)\b|(?:вообще-то|исправ|не\s|нет|обнов|поправ|уточн)/iu;

function termRoot(value: string): string {
  return value.length <= 5 ? value : value.slice(0, 5);
}

function searchableTerms(value: string): ReadonlySet<string> {
  const tokens = value.normalize("NFKC").toLocaleLowerCase()
    .match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return new Set(tokens.map(termRoot));
}

function queryTerms(value: string): ReadonlySet<string> {
  return new Set([...searchableTerms(value)].filter((term) =>
    !ignoredQueryTerms.has(term)
  ));
}

function scoreTurns(
  turns: readonly CanonicalEvidenceTurn[],
  terms: ReadonlySet<string>,
): readonly ScoredTurn[] {
  return turns.map((turn, index) => {
    const turnTerms = searchableTerms(turn.text);
    let matchedTerms = 0;
    for (const term of terms) {
      if (turnTerms.has(term)) {
        matchedTerms += 1;
      }
    }
    return Object.freeze({
      index,
      matchedTerms,
      score: matchedTerms * 100 +
        (matchedTerms > 0 && correctionOrConflict.test(turn.text) ? 25 : 0),
      turn,
    });
  }).filter(({ matchedTerms }) => matchedTerms > 0)
    .toSorted((left, right) =>
      right.score - left.score ||
      left.turn.startMs - right.turn.startMs ||
      left.turn.endMs - right.turn.endMs ||
      left.turn.turnId.localeCompare(right.turn.turnId)
    );
}

function selectFocusedTurns(
  turns: readonly CanonicalEvidenceTurn[],
  scored: readonly ScoredTurn[],
  maximumCandidates: number,
  neighborTurns: number,
): readonly CanonicalEvidenceTurn[] {
  const neighborhoodWidth = neighborTurns * 2 + 1;
  const primaryHitCount = Math.max(
    1,
    Math.min(scored.length, Math.floor(maximumCandidates / neighborhoodWidth)),
  );
  const selected = new Set<number>();
  for (const hit of scored.slice(0, primaryHitCount)) {
    for (
      let index = Math.max(0, hit.index - neighborTurns);
      index <= Math.min(turns.length - 1, hit.index + neighborTurns);
      index += 1
    ) {
      if (selected.size >= maximumCandidates) {
        break;
      }
      selected.add(index);
    }
  }
  for (const hit of scored) {
    if (selected.size >= maximumCandidates) {
      break;
    }
    selected.add(hit.index);
  }
  return Object.freeze([...selected].toSorted((left, right) => left - right)
    .map((index) => turns[index])
    .filter((turn): turn is CanonicalEvidenceTurn => turn !== undefined));
}

function referenceFor(
  input: Parameters<FocusedMemoryRetrievalPort["retrieve"]>[0],
  turn: CanonicalEvidenceTurn,
): FocusedMemoryReference {
  return Object.freeze({
    meetingId: input.meetingId,
    transcriptId: input.transcriptId,
    transcriptVersion: input.transcriptVersion,
    turnHash: canonicalFinalReplyTurnHash(turn),
    turnId: turn.turnId,
  });
}

function validRetrievalInput(
  input: Parameters<FocusedMemoryRetrievalPort["retrieve"]>[0],
): boolean {
  return Number.isSafeInteger(input.maximumCandidates) &&
    input.maximumCandidates >= 1 &&
    input.maximumCandidates <= 256 &&
    Number.isSafeInteger(input.neighborTurns) &&
    input.neighborTurns >= 0 &&
    input.neighborTurns <= 8 &&
    input.question.trim().length > 0;
}

function authorityMatchesRetrieval(
  authority: ResolvedFinalReplyAuthority,
  input: Parameters<FocusedMemoryRetrievalPort["retrieve"]>[0],
): boolean {
  const binding = authority.binding;
  return binding.canonicalEvidenceHash === input.canonicalEvidenceHash &&
    binding.finalProjectionReceipt === input.finalProjectionReceipt &&
    binding.meetingId === input.meetingId &&
    binding.meetingRevision === input.meetingRevision &&
    binding.memoryGeneration === input.expectedAuthorityGeneration &&
    binding.projectionTargetContainerId === input.projectionTargetContainerId &&
    binding.roomId === input.roomId &&
    binding.scopeId === input.scopeId &&
    binding.transcriptId === input.transcriptId &&
    binding.transcriptVersion === input.transcriptVersion;
}

/**
 * Production-local focused retrieval scans the authoritative accepted release,
 * but crosses the consumer port with references only. The application then
 * performs a separate canonical rehydration before generation. It is not an
 * Infinity SDK or synchronization adapter.
 */
export class PostgresFocusedMemoryRetrieval
  implements FocusedMemoryRetrievalPort
{
  public constructor(
    private readonly pool: Pool,
    private readonly botApplicationIdentity: string,
  ) {}

  public async retrieve(
    input: Parameters<FocusedMemoryRetrievalPort["retrieve"]>[0],
  ): Promise<FocusedMemoryRetrievalResult> {
    if (!validRetrievalInput(input)) {
      return { schemaVersion: 1, status: "unavailable" };
    }
    try {
      const unavailable = await this.pool.query<{ readonly unavailable: boolean }>(
        `
          SELECT EXISTS (
            SELECT 1
            FROM meeting_knowledge.unavailable_final_projections
            WHERE final_projection_receipt = $1
          ) AS unavailable
        `,
        [input.finalProjectionReceipt],
      );
      if (unavailable.rows[0]?.unavailable === true) {
        return { schemaVersion: 1, status: "unavailable" };
      }
      const authority = await loadCurrentReplyAuthority(
        this.pool,
        input.meetingId,
        this.botApplicationIdentity,
      );
      if (authority === null || !authorityMatchesRetrieval(authority, input)) {
        return { schemaVersion: 1, status: "stale" };
      }
      const humanActors = new Set(authority.binding.humanActorIds);
      const humanTurns = authority.turns.filter(({ speakerId }) =>
        humanActors.has(speakerId)
      );
      const terms = queryTerms(input.question);
      if (terms.size === 0) {
        return { schemaVersion: 1, status: "low_coverage" };
      }
      const scored = scoreTurns(humanTurns, terms);
      if (scored.length === 0) {
        return { schemaVersion: 1, status: "low_coverage" };
      }
      const selected = selectFocusedTurns(
        humanTurns,
        scored,
        input.maximumCandidates,
        input.neighborTurns,
      );
      if (selected.length === 0 || selected.length >= humanTurns.length) {
        return { schemaVersion: 1, status: "low_coverage" };
      }
      return Object.freeze({
        authorityGeneration: authority.binding.memoryGeneration,
        candidates: Object.freeze(selected.map((turn) => referenceFor(input, turn))),
        schemaVersion: 1,
        status: "current",
      });
    } catch {
      return { schemaVersion: 1, status: "unavailable" };
    }
  }
}
