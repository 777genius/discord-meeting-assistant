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
  const historicalReferences = references.filter(({ meetingId }) =>
    meetingId !== binding.meetingId
  );
  if (
    historicalReferences.some(({ historicalSource }) =>
      historicalSource === undefined
    ) ||
    references.some(({ historicalSource, meetingId }) =>
      meetingId === binding.meetingId && historicalSource !== undefined
    )
  ) {
    return null;
  }
  const historicalMeetingIds = [
    ...new Set(historicalReferences.map(({ meetingId }) => meetingId)),
  ];
  const referencedRows = historicalMeetingIds.length === 0
    ? []
    : (await pool.query<ReferencedMeetingRow>(
        `SELECT meeting.meeting_id, meeting.snapshot
         FROM meeting_core.meetings AS meeting
         WHERE meeting.meeting_id = ANY($1::text[])`,
        [historicalMeetingIds],
      )).rows;
  const historicalPlans = historicalReferences.length === 0
    ? []
    : (await pool.query<CurrentHistoricalPlanRow>(
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
        [[...new Set(historicalReferences.flatMap(({ historicalSource }) =>
          historicalSource === undefined ? [] : [historicalSource.releaseId]
        ))]],
      )).rows;
  try {
    const plans = new Map(historicalPlans.map((row) => [
      row.release_id,
      { plan: decodeHistoricalIndexPlanV1(row.plan), row },
    ]));
    return historicalReferences.every((reference) =>
      historicalReferenceMatches(reference, binding, plans)
    ) ? Object.freeze(referencedRows) : null;
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
