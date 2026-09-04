import {
  decodeHistoricalIndexPlanV1,
  type FocusedMemoryReference,
  type HistoricalIndexPlanV1,
  type QuestionBindingSnapshot,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { Pool } from "pg";

interface ReferencedMeetingRow {
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
    reference.historicalSource !== undefined
  );
  // The current authoritative meeting is already loaded and fenced by the
  // caller. Only other meetings need another snapshot read here.
  const historicalMeetingIds = [...new Set(eligible
    .filter(({ meetingId }) => meetingId !== binding.meetingId)
    .map(({ meetingId }) => meetingId))];
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

function currentMeetingBindingMatches(
  reference: FocusedMemoryReference,
  binding: QuestionBindingSnapshot,
  plan: HistoricalIndexPlanV1,
): boolean {
  if (reference.meetingId !== binding.meetingId) {
    return true;
  }
  return plan.binding.meetingId === binding.meetingId &&
    plan.binding.acceptedMeetingRevision === binding.meetingRevision &&
    plan.binding.scopeId === binding.scopeId &&
    plan.binding.roomId === binding.roomId &&
    plan.binding.transcriptId === binding.transcriptId &&
    plan.binding.transcriptVersion === binding.transcriptVersion;
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
  const currentMeetingMatches = currentMeetingBindingMatches(reference, binding, plan);
  return currentMeetingMatches &&
    row.release_id === plan.binding.releaseId &&
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
