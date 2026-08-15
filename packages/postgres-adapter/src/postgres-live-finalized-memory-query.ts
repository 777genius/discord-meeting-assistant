import { createHash } from "node:crypto";

import type {
  CanonicalEvidenceTurn, LiveFinalizedMemoryQueryPort, LiveMemoryCandidateReferenceV1,
  LiveMemoryCandidateResultV1, LiveMemoryContextV1, LiveMemoryRehydrationResultV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

import { canonicalFinalReplyTurnHash } from "./postgres-final-reply-evidence.js";

interface ContextRow {
  readonly applied_generation: number;
  readonly human_actor_ids: unknown;
  readonly identity_generation: number;
  readonly meeting_id: string;
  readonly room_id: string;
  readonly scope_id: string;
  readonly source_generation: number;
  readonly state: "active" | "ended" | "withdrawn";
}

interface TailRow {
  readonly source_generation: number; readonly turn: CanonicalEvidenceTurn;
  readonly turn_hash: string;
}

interface ScoredTurn {
  readonly index: number; readonly matchedTerms: number;
  readonly score: number; readonly row: TailRow;
}

const ignoredTerms = new Set([
  "about", "after", "answer", "could", "does", "from", "have", "please",
  "tell", "that", "their", "there", "these", "this", "what", "when",
  "where", "which", "who", "would", "were", "was", "какая", "какие",
  "какой", "когда", "ответ", "после", "пожал", "расск", "сказа", "этого",
  "что",
].map(termRoot));
const correction = /\b(?:actually|correction|instead|not|rather|revised|updated)\b|(?:вообще-то|исправ|не\s|нет|обнов|поправ|уточн)/iu;

function termRoot(value: string): string {
  return value.length <= 5 ? value : value.slice(0, 5);
}

function terms(value: string): ReadonlySet<string> {
  return new Set((value.normalize("NFKC").toLocaleLowerCase()
    .match(/[\p{L}\p{N}]{3,}/gu) ?? [])
    .map(termRoot)
    .filter((term) => !ignoredTerms.has(term)));
}

function roster(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error("stored live memory roster is invalid");
  }
  const actors = value.filter(
    (actorId): actorId is string => typeof actorId === "string",
  );
  if (actors.length !== value.length) {
    throw new Error("stored live memory roster is invalid");
  }
  return Object.freeze([...new Set(actors)].toSorted((left, right) =>
    left.localeCompare(right)
  ));
}

function knowledgeEpoch(row: ContextRow): string {
  return `live-memory:v1:${createHash("sha256").update(JSON.stringify({
    appliedGeneration: row.applied_generation,
    identityGeneration: row.identity_generation,
    meetingId: row.meeting_id,
    roomId: row.room_id,
    scopeId: row.scope_id,
    sourceGeneration: row.source_generation,
  }), "utf8").digest("hex")}`;
}

function context(row: ContextRow): LiveMemoryContextV1 {
  return Object.freeze({
    appliedGeneration: row.applied_generation,
    humanActorIds: roster(row.human_actor_ids),
    identityGeneration: row.identity_generation,
    knowledgeEpoch: knowledgeEpoch(row),
    meetingId: row.meeting_id,
    roomId: row.room_id,
    scopeId: row.scope_id,
    sourceGeneration: row.source_generation,
  });
}

function scoreRows(rows: readonly TailRow[], query: string): readonly ScoredTurn[] {
  const queryTerms = terms(query);
  if (queryTerms.size === 0) {
    return [];
  }
  return rows.map((row, index) => {
    const rowTerms = terms(row.turn.text);
    let matchedTerms = 0;
    for (const term of queryTerms) {
      if (rowTerms.has(term)) {
        matchedTerms += 1;
      }
    }
    return {
      index,
      matchedTerms,
      row,
      score: matchedTerms * 100 +
        (matchedTerms > 0 && correction.test(row.turn.text) ? 25 : 0),
    };
  }).filter(({ matchedTerms }) => matchedTerms > 0)
    .toSorted((left, right) =>
      right.score - left.score ||
      right.row.source_generation - left.row.source_generation ||
      left.row.turn.turnId.localeCompare(right.row.turn.turnId)
    );
}

function selectRows(
  rows: readonly TailRow[],
  scored: readonly ScoredTurn[],
  maximumCandidates: number,
  neighborTurns: number,
): readonly TailRow[] {
  const selected = new Set<number>();
  for (const hit of scored) {
    for (
      let index = Math.max(0, hit.index - neighborTurns);
      index <= Math.min(rows.length - 1, hit.index + neighborTurns);
      index += 1
    ) {
      if (selected.size >= maximumCandidates) {
        break;
      }
      selected.add(index);
    }
    if (selected.size >= maximumCandidates) {
      break;
    }
  }
  return Object.freeze([...selected].map((index) => rows[index])
    .filter((row): row is TailRow => row !== undefined)
    .toSorted((left, right) =>
      left.turn.startMs - right.turn.startMs ||
      left.turn.endMs - right.turn.endMs ||
      left.turn.turnId.localeCompare(right.turn.turnId)
    ));
}

export class PostgresLiveFinalizedMemoryQuery
  implements LiveFinalizedMemoryQueryPort
{
  public constructor(private readonly pool: Pool) {}

  public async resolveContext(input: {
    readonly meetingId: string;
    readonly requesterActorId: string;
    readonly roomId: string;
    readonly signal?: AbortSignal;
  }): Promise<LiveMemoryContextV1 | null> {
    const row = await this.loadContext(input.meetingId, input.signal);
    return row !== null &&
        row.state === "active" &&
        row.room_id === input.roomId &&
        row.applied_generation === row.source_generation &&
        roster(row.human_actor_ids).includes(input.requesterActorId)
      ? context(row)
      : null;
  }

  public async searchHotTail(input: {
    readonly maximumCandidates: number;
    readonly meetingId: string;
    readonly neighborTurns: number;
    readonly question: string;
    readonly requesterActorId: string;
    readonly roomId: string;
    readonly signal?: AbortSignal;
    readonly scopeId: string;
  }): Promise<LiveMemoryCandidateResultV1> {
    if (
      !Number.isSafeInteger(input.maximumCandidates) ||
      input.maximumCandidates < 1 ||
      input.maximumCandidates > 256 ||
      !Number.isSafeInteger(input.neighborTurns) ||
      input.neighborTurns < 0 ||
      input.neighborTurns > 8
    ) {
      return { schemaVersion: 1, status: "unavailable" };
    }
    const row = await this.loadContext(input.meetingId, input.signal);
    if (
      row === null ||
      row.state !== "active" ||
      row.room_id !== input.roomId ||
      row.scope_id !== input.scopeId ||
      !roster(row.human_actor_ids).includes(input.requesterActorId)
    ) {
      return { schemaVersion: 1, status: "ineligible" };
    }
    if (row.applied_generation !== row.source_generation) {
      return { schemaVersion: 1, status: "pending" };
    }
    const tail = await queryWithSignal<TailRow>(this.pool, {
      text: `
        SELECT hot.source_generation::float8 AS source_generation,
               hot.turn_hash,
               turn.turn
        FROM meeting_knowledge.live_memory_hot_tail AS hot
        JOIN meeting_core.live_meeting_turns AS turn
          ON turn.meeting_id = hot.meeting_id
         AND turn.turn_id = hot.turn_id
        WHERE hot.meeting_id = $1
        ORDER BY hot.source_generation
      `,
      values: [input.meetingId],
    }, input.signal);
    const admittedActors = new Set(roster(row.human_actor_ids));
    const eligibleTail = tail.rows.filter(({ turn }) =>
      admittedActors.has(turn.speakerId)
    );
    const selected = selectRows(
      eligibleTail,
      scoreRows(eligibleTail, input.question),
      input.maximumCandidates,
      input.neighborTurns,
    );
    if (selected.length === 0 || selected.length >= eligibleTail.length) {
      return { schemaVersion: 1, status: "low_coverage" };
    }
    const currentContext = context(row);
    return Object.freeze({
      candidates: Object.freeze(selected.map((candidate) => Object.freeze({
        meetingId: input.meetingId,
        sourceGeneration: currentContext.sourceGeneration,
        turnHash: candidate.turn_hash,
        turnId: candidate.turn.turnId,
      }))),
      context: currentContext,
      schemaVersion: 1,
      status: "current",
    });
  }

  public async rehydrateHotTail(input: {
    readonly candidates: readonly LiveMemoryCandidateReferenceV1[];
    readonly expectedGeneration: number;
    readonly meetingId: string;
    readonly requesterActorId: string;
    readonly roomId: string;
    readonly signal?: AbortSignal;
    readonly scopeId: string;
  }): Promise<LiveMemoryRehydrationResultV1> {
    if (
      input.candidates.length === 0 ||
      input.candidates.length > 256 ||
      new Set(input.candidates.map(({ turnId }) => turnId)).size !==
        input.candidates.length
    ) {
      return { schemaVersion: 1, status: "invalid_selection" };
    }
    const row = await this.loadContext(input.meetingId, input.signal);
    if (
      row === null ||
      row.state !== "active" ||
      row.scope_id !== input.scopeId ||
      row.room_id !== input.roomId ||
      !roster(row.human_actor_ids).includes(input.requesterActorId)
    ) {
      return { schemaVersion: 1, status: "unavailable" };
    }
    if (
      row.source_generation !== input.expectedGeneration ||
      row.applied_generation !== input.expectedGeneration ||
      input.candidates.some((candidate) =>
        candidate.meetingId !== input.meetingId ||
        candidate.sourceGeneration !== input.expectedGeneration
      )
    ) {
      return { schemaVersion: 1, status: "stale" };
    }
    const result = await queryWithSignal<TailRow>(this.pool, {
      text: `
        SELECT hot.source_generation::float8 AS source_generation,
               hot.turn_hash,
               turn.turn
        FROM meeting_knowledge.live_memory_hot_tail AS hot
        JOIN meeting_core.live_meeting_turns AS turn
          ON turn.meeting_id = hot.meeting_id
         AND turn.turn_id = hot.turn_id
        WHERE hot.meeting_id = $1
          AND hot.turn_id = ANY($2::text[])
      `,
      values: [input.meetingId, input.candidates.map(({ turnId }) => turnId)],
    }, input.signal);
    const rows = new Map(result.rows.map((candidate) => [
      candidate.turn.turnId,
      candidate,
    ]));
    const turns = input.candidates.flatMap((candidate) => {
      const found = rows.get(candidate.turnId);
      if (
        found === undefined ||
        found.turn_hash !== candidate.turnHash ||
        canonicalFinalReplyTurnHash(found.turn) !== candidate.turnHash ||
        !roster(row.human_actor_ids).includes(found.turn.speakerId)
      ) {
        return [];
      }
      return [Object.freeze({
        ...found.turn,
        source: Object.freeze({
          meetingId: input.meetingId,
          transcriptId: `live-memory-v1:${input.meetingId}`,
          transcriptVersion: input.expectedGeneration,
        }),
        turnHash: candidate.turnHash,
      })];
    });
    if (turns.length !== input.candidates.length) {
      return { schemaVersion: 1, status: "invalid_selection" };
    }
    return Object.freeze({
      context: context(row),
      schemaVersion: 1,
      status: "current",
      turns: Object.freeze(turns),
    });
  }

  private async loadContext(
    meetingId: string,
    signal?: AbortSignal,
  ): Promise<ContextRow | null> {
    const result = await queryWithSignal<ContextRow>(this.pool, {
      text: `
        SELECT meeting_id, scope_id, room_id, human_actor_ids,
               identity_generation::float8 AS identity_generation,
               source_generation::float8 AS source_generation,
               applied_generation::float8 AS applied_generation,
               state
        FROM meeting_knowledge.live_memory_meetings
        WHERE meeting_id = $1
      `,
      values: [meetingId],
    }, signal);
    return result.rows[0] ?? null;
  }
}

type AbortableQuery = Readonly<{ text: string; values: readonly unknown[] }>;

/** A cancelled read destroys its dedicated connection so PostgreSQL work cannot linger. */
async function queryWithSignal<Row extends QueryResultRow>(
  pool: Pool,
  query: AbortableQuery,
  signal?: AbortSignal,
): Promise<QueryResult<Row>> {
  if (signal === undefined) {
    return pool.query<Row>(query.text, [...query.values]);
  }
  signal.throwIfAborted();
  const client = await acquireAbortableClient(pool, signal);
  const release = releaseClientOnce(client);
  const abort = (): void => {
    release(true);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const result = await client.query<Row>(query.text, [...query.values]);
    signal.throwIfAborted();
    return result;
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    release(signal.aborted);
  }
}

async function acquireAbortableClient(pool: Pool, signal: AbortSignal): Promise<PoolClient> {
  const pending = pool.connect();
  let rejectAbort!: (reason?: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = (): void => {
    try {
      signal.throwIfAborted();
    } catch (error) {
      rejectAbort(error);
    }
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([pending, aborted]);
  } catch (error) {
    void destroyClientWhenAcquired(pending);
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function releaseClientOnce(client: PoolClient): (destroy?: boolean) => void {
  let released = false;
  return (destroy = false): void => {
    if (released) {
      return;
    }
    released = true;
    client.release(destroy);
  };
}

async function destroyClientWhenAcquired(pending: Promise<PoolClient>): Promise<void> {
  try {
    const client = await pending;
    client.release(true);
  } catch {
    // A failed acquisition owns no connection that needs releasing.
  }
}
