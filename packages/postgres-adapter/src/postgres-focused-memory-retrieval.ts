import {
  type CanonicalEvidenceTurn,
  type FocusedMemoryReference,
  type FocusedMemoryRetrievalPort,
  type FocusedMemoryRetrievalResult,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { Pool } from "pg";

import {
  canonicalFinalReplyTurnHash,
  loadCurrentReplyAuthority,
  type ResolvedFinalReplyAuthority,
} from "./postgres-final-reply-evidence.js";

interface ExactLexicalMatch {
  readonly matchedTerms: number;
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
  "how",
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
  "early",
  "earlier",
  "final",
  "first",
  "initial",
  "last",
  "late",
  "latest",
  "recent",
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
  "итог",
  "начал",
  "перв",
  "послед",
]);

function searchableTerms(value: string): ReadonlySet<string> {
  const tokens = value.normalize("NFKC").toLocaleLowerCase()
    .match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return new Set(tokens);
}

function queryTerms(value: string): ReadonlySet<string> {
  return new Set([...searchableTerms(value)].filter((term) =>
    !ignoredQueryTerms.has(term)
  ));
}

function exactLexicalMatches(
  turns: readonly CanonicalEvidenceTurn[],
  question: string,
): readonly ExactLexicalMatch[] {
  const terms = queryTerms(question);
  const matches: ExactLexicalMatch[] = [];
  for (const turn of turns) {
    const turnTerms = searchableTerms(turn.text);
    const matchedTerms = [...terms].filter((term) => turnTerms.has(term)).length;
    if (matchedTerms > 0) {
      matches.push(Object.freeze({ matchedTerms, turn }));
    }
  }
  return matches
    .toSorted((left, right) =>
      right.matchedTerms - left.matchedTerms ||
      left.turn.startMs - right.turn.startMs ||
      left.turn.endMs - right.turn.endMs ||
      left.turn.turnId.localeCompare(right.turn.turnId)
    );
}

function selectExactLexicalTurns(
  matches: readonly ExactLexicalMatch[],
  maximumCandidates: number,
): readonly ExactLexicalMatch[] {
  return Object.freeze(matches.slice(0, maximumCandidates));
}

function referenceFor(
  input: Parameters<FocusedMemoryRetrievalPort["retrieve"]>[0],
  matched: ExactLexicalMatch,
): FocusedMemoryReference {
  const { turn } = matched;
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
      if (queryTerms(input.question).size === 0) {
        return { schemaVersion: 1, status: "low_coverage" };
      }
      const matches = exactLexicalMatches(humanTurns, input.question);
      if (matches.length === 0) {
        return { schemaVersion: 1, status: "low_coverage" };
      }
      const selected = selectExactLexicalTurns(matches, input.maximumCandidates);
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
