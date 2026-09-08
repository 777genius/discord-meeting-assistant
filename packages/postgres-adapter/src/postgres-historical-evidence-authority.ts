import {
  type LegacyHistoricalReceiptVerifierPort,
  validateHistoricalReleaseBinding,
  type AcceptedFinalMeetingV1,
  type HistoricalEvidenceAuthority,
  type HistoricalOperationOptionsV1,
  type HistoricalReleaseBindingV1,
  type HistoricalRoomAuthoritySnapshotPort,
  type HistoricalRoomAuthoritySnapshotResultV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  Meeting,
  type MeetingSnapshot,
} from "@discord-meeting/meeting-core/meeting-lifecycle";
import type { Pool } from "pg";

import { CorruptMeetingSnapshotError } from "./errors.js";
import {
  queryHistoricalPostgres,
  withHistoricalPostgresTransaction,
  type HistoricalPostgresCancellationPort,
} from "./postgres-historical-query.js";
import { historicalAppliedFromRow, historicalSyncRowProjection,
  type HistoricalSyncRow } from "./postgres-historical-memory-row.js";

import { resolveAcceptedHistoricalMeeting } from "./postgres-accepted-historical-meeting.js";

interface MeetingRow {
  readonly legacy_receipt?: unknown;
  readonly legacy_current?: boolean;
  readonly withdrawn?: boolean;
  readonly revision: number;
  readonly snapshot: unknown;
}

interface SnapshotRow extends HistoricalSyncRow {
  readonly legacy_receipt?: unknown;
  readonly legacy_current?: boolean;
  readonly withdrawn?: boolean;
  readonly meeting_revision: number | null;
  readonly meeting_snapshot: unknown;
}

const constructedHistoricalEvidenceAuthorities = new WeakSet<object>();

/** Read-only nominal check; only this module's constructor can add instances. */
export function assertConstructedPostgresHistoricalEvidenceAuthority(value: unknown): asserts value is PostgresHistoricalEvidenceAuthority {
  if (typeof value !== "object" || value === null ||
    !constructedHistoricalEvidenceAuthorities.has(value)) {
    throw new Error("PostgreSQL historical evidence authority was not constructed by its adapter module");
  }
}

export class PostgresHistoricalEvidenceAuthority implements HistoricalEvidenceAuthority {
  public constructor(
    private readonly pool: Pool,
    private readonly cancellation?: HistoricalPostgresCancellationPort,
    private readonly legacyVerifier?: LegacyHistoricalReceiptVerifierPort,
  ) {
    constructedHistoricalEvidenceAuthorities.add(this);
    Object.freeze(this);
  }

  public async loadAcceptedFinalMeeting(
    candidate: HistoricalReleaseBindingV1,
    options: HistoricalOperationOptionsV1 = {},
  ): Promise<AcceptedFinalMeetingV1 | null> {
    const binding = validateHistoricalReleaseBinding(candidate);
    const result = await queryHistoricalPostgres<MeetingRow>(this.pool, {
      text: `
        SELECT revision::float8 AS revision, snapshot,
          (SELECT receipt_json::jsonb FROM meeting_core.legacy_historical_admissions
           WHERE release_id = $2 AND meeting_id = $1) AS legacy_receipt,
          EXISTS (SELECT 1 FROM meeting_core.historical_memory_sync
            WHERE release_id = $2 AND meeting_id = $1 AND is_current
              AND operation = 'index' AND state <> 'deleted'
              AND desired_generation = $3 AND accepted_meeting_revision = $4) AS legacy_current,
          EXISTS (SELECT 1 FROM meeting_knowledge.withdrawn_meeting_sources
            WHERE meeting_id = $1) AS withdrawn
        FROM meeting_core.meetings
        WHERE meeting_id = $1
      `,
      values: [binding.meetingId, binding.releaseId, binding.desiredGeneration, binding.acceptedMeetingRevision],
    }, options.signal, this.cancellation);
    const row = result.rows[0];
    if (row === undefined || row.withdrawn === true ||
      (row.legacy_receipt !== undefined && row.legacy_receipt !== null && row.legacy_current !== true)) {
      return null;
    }
    let snapshot: MeetingSnapshot;
    try {
      snapshot = Meeting.restore(row.snapshot as MeetingSnapshot).toSnapshot();
      if (snapshot.revision !== row.revision || snapshot.meetingId !== binding.meetingId) {
        throw new Error("meeting row identity does not match its snapshot");
      }
    } catch (error) {
      throw new CorruptMeetingSnapshotError(binding.meetingId, { cause: error });
    }
    if (snapshot.transcriptionStage.status !== "succeeded") {
      return null;
    }
    return resolveAcceptedHistoricalMeeting({ binding, revision: row.revision,
      snapshot: row.snapshot, receipt: row.legacy_receipt,
      ...(this.legacyVerifier === undefined ? {} : { verifier: this.legacyVerifier }) });
  }
}

export class PostgresHistoricalRoomAuthoritySnapshot
implements HistoricalRoomAuthoritySnapshotPort {
  public constructor(
    private readonly pool: Pool,
    private readonly cancellation?: HistoricalPostgresCancellationPort,
    private readonly legacyVerifier?: LegacyHistoricalReceiptVerifierPort,
  ) {}

  public async loadRoomAuthoritySnapshot(
    input: Parameters<HistoricalRoomAuthoritySnapshotPort[
      "loadRoomAuthoritySnapshot"
    ]>[0],
  ): Promise<HistoricalRoomAuthoritySnapshotResultV1> {
    if (!Number.isSafeInteger(input.maximumSources) || input.maximumSources < 1 ||
      input.maximumSources > 100 || !Number.isSafeInteger(input.pageSize) ||
      input.pageSize < 1 || input.pageSize > 50) {
      throw new RangeError("historical room authority snapshot bounds are invalid");
    }
    try {
      return await withHistoricalPostgresTransaction(
        this.pool,
        input.signal,
        async (client) => {
          const rows: SnapshotRow[] = [];
          let cursor = "";
          let complete = false;
          while (!complete) {
            input.signal?.throwIfAborted();
            const page = await client.query<SnapshotRow>(
              `SELECT historical.*,
                      meeting.revision::float8 AS meeting_revision,
                      meeting.snapshot AS meeting_snapshot,
                      admission.receipt_json::jsonb AS legacy_receipt,
                      EXISTS (SELECT 1 FROM meeting_knowledge.withdrawn_meeting_sources
                        WHERE meeting_id = historical.meeting_id) AS withdrawn
               FROM (
                 SELECT ${historicalSyncRowProjection}
                 FROM meeting_core.historical_memory_sync
                 WHERE scope_id = $1 AND room_id = $2
                   AND is_current AND operation = 'index'
                   AND state = 'applied' AND plan IS NOT NULL
                   AND release_id > $3
                 ORDER BY release_id
                 LIMIT $4
               ) AS historical
               LEFT JOIN meeting_core.meetings AS meeting
                 ON meeting.meeting_id = historical.meeting_id
               LEFT JOIN meeting_core.legacy_historical_admissions AS admission
                 ON admission.release_id = historical.release_id
                   AND admission.meeting_id = historical.meeting_id

               ORDER BY historical.release_id`,
              [input.scopeId, input.roomId, cursor, input.pageSize],
            );
            rows.push(...page.rows);
            if (rows.length > input.maximumSources) {
              return Object.freeze({ schemaVersion: 1 as const,
                status: "overflow" as const });
            }
            const last = page.rows.at(-1);
            if (last === undefined || page.rows.length < input.pageSize) {
              complete = true;
              continue;
            }
            if (last.release_id <= cursor) {
              throw new Error("historical room snapshot cursor did not advance");
            }
            cursor = last.release_id;
          }
          const count = await client.query<{ readonly count: number }>(
            `SELECT count(*)::float8 AS count
             FROM meeting_core.historical_memory_sync
             WHERE scope_id = $1 AND room_id = $2 AND is_current
               AND operation = 'index' AND state = 'applied' AND plan IS NOT NULL`,
            [input.scopeId, input.roomId],
          );
          if (count.rows[0]?.count !== rows.length) {
            return Object.freeze({ schemaVersion: 1 as const,
              status: "unavailable" as const });
          }
          return Object.freeze({
            entries: Object.freeze(rows.map((row) => {
              const applied = historicalAppliedFromRow(row);
              return Object.freeze({ ...applied,
                acceptedMeeting: acceptedMeetingFromSnapshotRow(row, applied.binding, this.legacyVerifier) });
            })),
            schemaVersion: 1 as const,
            status: "current" as const,
          });
        },
        this.cancellation,
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
    } catch {
      input.signal?.throwIfAborted();
      return Object.freeze({ schemaVersion: 1, status: "unavailable" });
    }
  }
}

function acceptedMeetingFromSnapshotRow(
  row: SnapshotRow,
  binding: HistoricalReleaseBindingV1,
  verifier?: LegacyHistoricalReceiptVerifierPort,
): AcceptedFinalMeetingV1 | null {
  if (row.withdrawn === true || row.meeting_snapshot === null || row.meeting_revision === null) { return null; }
  return resolveAcceptedHistoricalMeeting({ binding, revision: row.meeting_revision,
    snapshot: row.meeting_snapshot, receipt: row.legacy_receipt,
    ...(verifier === undefined ? {} : { verifier }) });
}
