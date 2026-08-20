import {
  type CanonicalEvidenceTurn,
  decomposeHistoricalQuery,
  type FocusedMemoryReference,
  type FocusedMemoryRetrievalPort,
  type FocusedMemoryRetrievalResult,
  resolveRequestedSpeakerIds,
  type SpeakerAliasMapV1,
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
  readonly queryIndex: number;
  readonly relevanceScore: number;
  readonly turn: CanonicalEvidenceTurn;
}

const maximumQueries = 4;
const minimumRelevanceScore = 0.2;

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
  question: string,
  requestedSpeakerIds: ReadonlySet<string>,
): readonly ScoredTurn[] {
  const queries = decomposeHistoricalQuery(question, maximumQueries);
  const normalizedQuestion = question.normalize("NFKC").toLocaleLowerCase("und");
  const wantsCorrection = /\b(?:actual|correct|final|instead|latest|revised|updated)\b|(?:исправ|итог|послед|поправ|уточн)/iu
    .test(normalizedQuestion);
  const wantsStart = /\b(?:beginning|early|earlier|first|initial|start)\b|(?:вначал|начал|перв|раньш)/iu
    .test(normalizedQuestion);
  const wantsEnd = /\b(?:end|final|last|late|latest|recent)\b|(?:в\s+конце|итог|конеч|послед|поздн)/iu
    .test(normalizedQuestion);
  const profiles = queries.map((query, queryIndex) => ({
    queryIndex,
    terms: queryTerms(query),
  })).filter(({ terms }) => terms.size > 0);
  const maximumStartMs = turns.at(-1)?.startMs ?? 0;
  const best = new Map<number, ScoredTurn>();
  for (const [index, turn] of turns.entries()) {
    const turnTerms = searchableTerms(turn.text);
    for (const profile of profiles) {
      const matchedTerms = [...profile.terms].filter((term) => turnTerms.has(term)).length;
      if (matchedTerms === 0) {
        continue;
      }
      const lexicalScore = matchedTerms / profile.terms.size;
      const speakerScore = requestedSpeakerIds.has(turn.speakerId) ||
          normalizedQuestion.includes(
            turn.speakerId.normalize("NFKC").toLocaleLowerCase("und"),
          )
        ? 1
        : 0;
      const position = maximumStartMs <= 0 ? 1 : turn.startMs / maximumStartMs;
      const temporalScore = wantsStart === wantsEnd
        ? 0
        : wantsEnd ? position : 1 - position;
      const relevanceScore = Math.min(1, lexicalScore * 0.75 +
        (wantsCorrection && correctionOrConflict.test(turn.text) ? 0.1 : 0) +
        speakerScore * 0.1 + temporalScore * 0.05);
      if (relevanceScore < minimumRelevanceScore) {
        continue;
      }
      const candidate = Object.freeze({
        index,
        matchedTerms,
        queryIndex: profile.queryIndex,
        relevanceScore,
        turn,
      });
      const previous = best.get(index);
      if (previous === undefined || compareScored(candidate, previous) < 0) {
        best.set(index, candidate);
      }
    }
  }
  return [...best.values()]
    .toSorted((left, right) =>
      compareScored(left, right) ||
      left.turn.startMs - right.turn.startMs ||
      left.turn.endMs - right.turn.endMs ||
      left.turn.turnId.localeCompare(right.turn.turnId)
    );
}

function compareScored(left: ScoredTurn, right: ScoredTurn): number {
  return right.relevanceScore - left.relevanceScore ||
    right.matchedTerms - left.matchedTerms ||
    left.queryIndex - right.queryIndex;
}

function selectFocusedTurns(
  turns: readonly CanonicalEvidenceTurn[],
  scored: readonly ScoredTurn[],
  maximumCandidates: number,
  neighborTurns: number,
): readonly ScoredTurn[] {
  const neighborhoodWidth = neighborTurns * 2 + 1;
  const primaryHitCount = Math.max(
    1,
    Math.min(scored.length, Math.floor(maximumCandidates / neighborhoodWidth)),
  );
  const primary = new Map<number, ScoredTurn>();
  for (const hit of scored) {
    if (![...primary.values()].some(({ queryIndex }) => queryIndex === hit.queryIndex)) {
      primary.set(hit.index, hit);
    }
    if (primary.size >= primaryHitCount) {
      break;
    }
  }
  for (const hit of scored) {
    if (primary.size >= primaryHitCount) {
      break;
    }
    primary.set(hit.index, hit);
  }
  const selected = new Map<number, ScoredTurn>();
  for (const hit of primary.values()) {
    for (
      let index = Math.max(0, hit.index - neighborTurns);
      index <= Math.min(turns.length - 1, hit.index + neighborTurns);
      index += 1
    ) {
      if (selected.size >= maximumCandidates) {
        break;
      }
      const turn = turns[index];
      if (turn === undefined) {
        continue;
      }
      const distance = Math.abs(index - hit.index);
      const candidate = distance === 0 ? hit : Object.freeze({
        index,
        matchedTerms: 0,
        queryIndex: hit.queryIndex,
        relevanceScore: hit.relevanceScore * 0.5 / distance,
        turn,
      });
      const previous = selected.get(index);
      if (previous === undefined || compareScored(candidate, previous) < 0) {
        selected.set(index, candidate);
      }
    }
  }
  for (const hit of scored) {
    if (selected.size >= maximumCandidates) {
      break;
    }
    const previous = selected.get(hit.index);
    if (previous === undefined || compareScored(hit, previous) < 0) {
      selected.set(hit.index, hit);
    }
  }
  return Object.freeze([...selected.values()].toSorted((left, right) =>
    compareScored(left, right) ||
    left.turn.startMs - right.turn.startMs ||
    left.turn.turnId.localeCompare(right.turn.turnId)
  ));
}

function referenceFor(
  input: Parameters<FocusedMemoryRetrievalPort["retrieve"]>[0],
  scored: ScoredTurn,
): FocusedMemoryReference {
  const { turn } = scored;
  return Object.freeze({
    meetingId: input.meetingId,
    relevanceScore: scored.relevanceScore,
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
    private readonly speakerAliases: SpeakerAliasMapV1 = {},
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
      const scored = scoreTurns(
        humanTurns,
        input.question,
        resolveRequestedSpeakerIds(input.question, this.speakerAliases),
      );
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
