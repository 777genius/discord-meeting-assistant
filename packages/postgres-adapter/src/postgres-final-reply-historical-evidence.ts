import {
  decodeHistoricalIndexPlanV1,
  type FocusedMemoryReference,
  type HistoricalIndexPlanV1,
  type QuestionBindingSnapshot,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { Pool } from "pg";

export interface ReferencedMeetingRow {
  readonly meeting_id: string;
  readonly snapshot: unknown;
}

export interface CurrentHistoricalReferenceBatch {
  readonly rows: readonly ReferencedMeetingRow[];
  readonly validReferences: ReadonlySet<FocusedMemoryReference>;
}

/** One bounded snapshot batch; malformed candidates isolate, query failure aborts. */
export async function loadCurrentHistoricalReferenceBatch(
  pool: Pool,
  binding: QuestionBindingSnapshot,
  references: readonly FocusedMemoryReference[],
): Promise<CurrentHistoricalReferenceBatch> {
  const eligible = references.filter((reference) =>
    reference.historicalSource !== undefined && reference.meetingId !== binding.meetingId
  );
  const historicalMeetingIds = [...new Set(eligible.map(({ meetingId }) => meetingId))];
  const releaseIds = [...new Set(eligible.map((reference) =>
    reference.historicalSource!.releaseId
  ))];
  const [referenced, plansResult] = await Promise.all([
    historicalMeetingIds.length === 0
      ? Promise.resolve({ rows: [] as ReferencedMeetingRow[] })
      : pool.query<ReferencedMeetingRow>(
          `SELECT meeting.meeting_id, meeting.snapshot
           FROM meeting_core.meetings AS meeting
           WHERE meeting.meeting_id = ANY($1::text[])`,
          [historicalMeetingIds],
        ),
    releaseIds.length === 0
      ? Promise.resolve({ rows: [] as CurrentHistoricalPlanRow[] })
      : pool.query<CurrentHistoricalPlanRow>(
          `SELECT historical.meeting_id, historical.release_id,
                  historical.scope_id, historical.room_id,
                  historical.transcript_id,
                  historical.transcript_version::float8 AS transcript_version,
                  historical.plan
           FROM meeting_core.historical_memory_sync AS historical
           WHERE historical.release_id = ANY($1::text[])
             AND historical.is_current
             AND historical.operation = 'index'
             AND historical.state = 'applied'
             AND historical.plan IS NOT NULL`,
          [releaseIds],
        ),
  ]);
  const plans = new Map(plansResult.rows.map((row) => [
    row.release_id,
    { plan: decodeHistoricalIndexPlanV1(row.plan), row },
  ]));
  return Object.freeze({
    rows: Object.freeze(referenced.rows),
    validReferences: new Set(eligible.filter((reference) =>
      historicalReferenceMatches(reference, binding, plans)
    )),
  });
}

interface CurrentHistoricalPlanRow {
  readonly meeting_id: string;
  readonly plan: unknown;
  readonly release_id: string;
  readonly room_id: string;
  readonly scope_id: string;
  readonly transcript_id: string;
  readonly transcript_version: number;
}

export async function loadCurrentHistoricalReferenceRows(
  pool: Pool,
  binding: QuestionBindingSnapshot,
  references: readonly FocusedMemoryReference[],
): Promise<readonly ReferencedMeetingRow[] | null> {
  try {
    const batch = await loadCurrentHistoricalReferenceBatch(pool, binding, references);
    const historical = references.filter(({ historicalSource }) =>
      historicalSource !== undefined
    );
    if (references.some(({ historicalSource, meetingId }) =>
      meetingId !== binding.meetingId && historicalSource === undefined
    ) || historical.some((reference) => !batch.validReferences.has(reference))) {
      return null;
    }
    return batch.rows;
  } catch {
    return null;
  }
}

function historicalReferenceMatches(
  reference: FocusedMemoryReference,
  binding: QuestionBindingSnapshot,
  plans: ReadonlyMap<string, {
    readonly plan: HistoricalIndexPlanV1;
    readonly row: CurrentHistoricalPlanRow;
  }>,
): boolean {
  const source = reference.historicalSource;
  if (source === undefined) {
    return false;
  }
  const current = plans.get(source.releaseId);
  if (current === undefined) {
    return false;
  }
  const { plan, row } = current;
  const document = plan.documents.find(({ manifest }) =>
    manifest.candidateLocator === source.candidateLocator
  );
  return row.release_id === plan.binding.releaseId &&
    row.release_id === source.releaseId &&
    row.meeting_id === reference.meetingId &&
    row.meeting_id === plan.binding.meetingId &&
    row.scope_id === binding.scopeId && row.scope_id === plan.binding.scopeId &&
    row.room_id === binding.roomId && row.room_id === plan.binding.roomId &&
    row.transcript_id === reference.transcriptId &&
    row.transcript_id === plan.binding.transcriptId &&
    row.transcript_version === reference.transcriptVersion &&
    row.transcript_version === plan.binding.transcriptVersion &&
    plan.topology.indexGeneration === source.indexGeneration &&
    document?.manifest.indexGeneration === source.indexGeneration &&
    document.manifest.turnSources.some((turn) =>
      turn.turnId === reference.turnId &&
      turn.sourceStartCodePoint === reference.sourceStartCodePoint &&
      turn.sourceEndCodePoint === reference.sourceEndCodePoint
    );
}
