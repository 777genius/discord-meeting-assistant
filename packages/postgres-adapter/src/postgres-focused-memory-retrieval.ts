import {
  type CanonicalEvidenceTurn,
  compareRetrievalV2Utf8,
  type FocusedMemoryReference,
  type FocusedMemoryRetrievalPort,
  type FocusedMemoryRetrievalResult,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import {
  canonicalFinalReplyTurnHash,
  loadCurrentReplyAuthority,
  type ResolvedFinalReplyAuthority,
} from "./postgres-final-reply-evidence.js";
import {
  type HistoricalPostgresCancellationPort,
  withHistoricalPostgresClient,
} from "./postgres-historical-query.js";

interface ExactLexicalMatch {
  readonly matchedTerms: number;
  readonly turn: CanonicalEvidenceTurn;
}

const ignoredQueryTerms = new Set([
  "about",
  "after",
  "answer",
  "could",
  "current",
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
  const tokens = value.normalize("NFKC").toLowerCase()
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
      compareRetrievalV2Utf8(left.turn.turnId, right.turn.turnId)
    );
}

function selectExactLexicalTurns(
  matches: readonly ExactLexicalMatch[],
  maximumCandidates: number,
): readonly ExactLexicalMatch[] {
  const speakerOrder: string[] = [];
  const bySpeaker = new Map<string, Map<number, ExactLexicalMatch[]>>();
  for (const match of matches) {
    let buckets = bySpeaker.get(match.turn.speakerId);
    if (buckets === undefined) {
      buckets = new Map();
      bySpeaker.set(match.turn.speakerId, buckets);
      speakerOrder.push(match.turn.speakerId);
    }
    const timeBucket = Math.floor(match.turn.startMs / 60_000);
    buckets.set(timeBucket, [...(buckets.get(timeBucket) ?? []), match]);
  }
  const selected: ExactLexicalMatch[] = [];
  const nextBucket = new Map<string, number>();
  while (selected.length < maximumCandidates) {
    let progressed = false;
    for (const speakerId of speakerOrder) {
      const buckets = bySpeaker.get(speakerId);
      if (buckets === undefined) {
        continue;
      }
      const bucketOrder = [...buckets.keys()];
      const start = nextBucket.get(speakerId) ?? 0;
      for (let offset = 0; offset < bucketOrder.length; offset += 1) {
        const index = (start + offset) % bucketOrder.length;
        const bucket = buckets.get(bucketOrder[index]!);
        const match = bucket?.shift();
        if (match !== undefined) {
          selected.push(match);
          nextBucket.set(speakerId, (index + 1) % bucketOrder.length);
          progressed = true;
          break;
        }
      }
      if (selected.length === maximumCandidates) {
        break;
      }
    }
    if (!progressed) {
      break;
    }
  }
  return Object.freeze(selected);
}

function referenceFor(
  input: Parameters<FocusedMemoryRetrievalPort["retrieve"]>[0],
  matched: ExactLexicalMatch,
  providerRank: number,
  requestDigest: string,
  responseDigest: string,
): FocusedMemoryReference {
  const { turn } = matched;
  const identity = input.retrievalBinding?.localCurrentIdentity;
  const fingerprint = identity?.profileFingerprint ??
    createHash("sha256").update("canonical-local-unbound", "utf8").digest("hex");
  return Object.freeze({
    meetingId: input.meetingId,
    retrievalAudit: Object.freeze({
      contributions: Object.freeze([Object.freeze({
        contributionScorePicos: matched.matchedTerms * 1_000_000,
        providerLaneId: "canonical_local_exact_lexical",
        providerRank,
        queryId: "original-question",
        rawScoreKind: "bm25" as const,
        rawScoreValue: matched.matchedTerms,
      })]),
      fusedScore: matched.matchedTerms,
      laneIdentity: Object.freeze({
        algorithmId: "canonical_local_exact_lexical_v1" as const,
        lane: "local_current" as const,
        profileFingerprint: fingerprint,
        profileId: "meeting-knowledge.local-current.v2" as const,
      }),
      locator: `canonical-turn:${turn.turnId}`,
      providerRank,
      requestDigest,
      responseDigest,
    }),
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
    private readonly cancellation?: HistoricalPostgresCancellationPort,
  ) {}

  public async retrieve(
    input: Parameters<FocusedMemoryRetrievalPort["retrieve"]>[0],
  ): Promise<FocusedMemoryRetrievalResult> {
    input.signal?.throwIfAborted();
    if (!validRetrievalInput(input)) {
      return { schemaVersion: 1, status: "unavailable" };
    }
    try {
      input.signal?.throwIfAborted();
      const readAuthority = async (executor: Pick<Pool, "query"> | PoolClient) => {
        const unavailable = await executor.query<{ readonly unavailable: boolean }>(
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
          return { authority: null, unavailable: true } as const;
        }
        const authority = await loadCurrentReplyAuthority(
          executor,
          input.meetingId,
          this.botApplicationIdentity,
        );
        return { authority, unavailable: false } as const;
      };
      const loaded = input.signal === undefined
        ? await readAuthority(this.pool)
        : await withHistoricalPostgresClient(
            this.pool, input.signal, readAuthority, this.cancellation,
          );
      if (loaded.unavailable) {
        return { schemaVersion: 1, status: "unavailable" };
      }
      input.signal?.throwIfAborted();
      const authority = loaded.authority;
      input.signal?.throwIfAborted();
      if (authority === null || !authorityMatchesRetrieval(authority, input)) {
        return { schemaVersion: 1, status: "stale" };
      }
      const humanActors = new Set(authority.binding.humanActorIds);
      const requestedSpeakers = new Set(input.hardFilters?.speakerIds ?? []);
      const interval = input.hardFilters?.relativeTimeInterval ?? null;
      const canonicalHumanTurns = authority.turns.filter(({ speakerId }) =>
        humanActors.has(speakerId)
      );
      const humanTurns = canonicalHumanTurns.filter(({ speakerId }) =>
        (input.hardFilters?.requiresSpeakerMatch !== true ||
          requestedSpeakers.has(speakerId))
      ).filter((turn) =>
        interval === null ||
        (turn.startMs < interval.endMs && turn.endMs > interval.startMs)
      );
      if (queryTerms(input.question).size === 0) {
        return { authorityGeneration: authority.binding.memoryGeneration, schemaVersion: 1, status: "low_coverage" };
      }
      const matches = exactLexicalMatches(humanTurns, input.question);
      if (matches.length === 0) {
        return { authorityGeneration: authority.binding.memoryGeneration, schemaVersion: 1, status: "low_coverage" };
      }
      const selected = selectExactLexicalTurns(matches, input.maximumCandidates);
      if (selected.length === 0 || selected.length >= canonicalHumanTurns.length) {
        return { authorityGeneration: authority.binding.memoryGeneration, schemaVersion: 1, status: "low_coverage" };
      }
      const requestDigest = digestJson({
        hardFilters: input.hardFilters ?? null,
        laneIdentity: input.retrievalBinding?.localCurrentIdentity ?? null,
        originalQuestion: input.retrievalBinding?.originalQuestion ?? input.question,
        schemaVersion: 1,
      });
      return Object.freeze({
        authorityGeneration: authority.binding.memoryGeneration,
        candidates: Object.freeze(selected.map((turn, index) =>
          referenceFor(input, turn, index + 1, requestDigest, digestJson({
            contributions: [{
              contributionScorePicos: turn.matchedTerms * 1_000_000,
              providerLaneId: "canonical_local_exact_lexical",
              providerRank: index + 1,
              queryId: "original-question",
              rawScoreKind: "bm25",
              rawScoreValue: turn.matchedTerms,
            }],
            fusedScore: turn.matchedTerms,
            locator: `canonical-turn:${turn.turn.turnId}`,
            providerRank: index + 1,
          }))
        )),
        schemaVersion: 1,
        status: "current",
      });
    } catch {
      input.signal?.throwIfAborted();
      return { schemaVersion: 1, status: "unavailable" };
    }
  }
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8")
    .digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {return value.map(canonicalValue);}
  if (typeof value !== "object" || value === null) {return value;}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .toSorted(([left], [right]) => compareRetrievalV2Utf8(left, right))
    .map(([key, nested]) => [key, canonicalValue(nested)]));
}
