import {
  LiveMeetingInvariantError,
  normalizeLiveGenerationTelemetry,
  normalizeLiveGenerationUsage,
  type CommitLiveMeetingSummaryInput,
  type LiveAppendResult,
  type LiveFinalizedTurn,
  type LiveGenerationTelemetrySnapshot,
  type LiveGenerationUsageSnapshot,
} from "@discord-meeting/meeting-core/live-meeting";
import {
  type TranscriptTurnSnapshot,
} from "@discord-meeting/meeting-core/transcription";
import type { Pool, PoolClient } from "pg";

import { normalizeLiveTurn, restoreStoredLiveTurn } from "./postgres-live-meeting-codec.js";
import {
  PostgresLiveMeetingStateStore,
  type LiveMeetingQueryExecutor,
} from "./postgres-live-meeting-state.js";
import { projectLiveFinalizedMemoryOutbox } from "./postgres-live-finalized-memory.js";

interface StoredLiveTurnRow {
  readonly is_summarized: boolean;
  readonly turn: unknown;
}

interface ExistingRecordRow {
  readonly payload_matches: boolean;
}

interface LockedLifecycleRow {
  readonly revision: number;
  readonly status: "active" | "ended";
}

interface CountRow {
  readonly count: number;
}

const usageTable = "meeting_core.live_meeting_generation_usage";
const telemetryTable = "meeting_core.live_meeting_generation_telemetry";

export class PostgresLiveMeetingRecords {
  public constructor(
    private readonly pool: Pool,
    private readonly state: PostgresLiveMeetingStateStore,
  ) {}

  public async appendFinalizedTurn(
    meetingId: string,
    turn: TranscriptTurnSnapshot,
  ): Promise<LiveAppendResult> {
    const normalized = normalizeLiveTurn(turn);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const lifecycle = await this.lockLifecycle(client, meetingId);
      if (lifecycle === null) {
        await client.query("COMMIT");
        return "not-found";
      }
      const existing = await this.findTurnReplay(client, meetingId, normalized);
      if (existing !== null) {
        if (!existing) {
          throw new LiveMeetingInvariantError(
            "CONFLICTING_COMPLETION",
            "live turn identity was reused with different content",
          );
        }
        await client.query("COMMIT");
        return "reused";
      }
      if (lifecycle.status !== "active") {
        throw new LiveMeetingInvariantError(
          "INVALID_LIFECYCLE_STATE",
          "cannot append a live turn after the meeting ended",
        );
      }
      const insertedTurn = await client.query(
        `
          INSERT INTO meeting_core.live_meeting_turns
            (meeting_id, turn_id, start_ms, end_ms, speaker_id, turn)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        `,
        [
          meetingId,
          normalized.turnId,
          normalized.startMs,
          normalized.endMs,
          normalized.speakerId,
          normalized,
        ],
      );
      if (insertedTurn.rowCount !== 1) {
        throw new Error("locked live meeting turn could not be appended");
      }
      await projectLiveFinalizedMemoryOutbox(client, meetingId, normalized);
      const revisionUpdate = await client.query(
        `
          UPDATE meeting_core.live_meetings
          SET revision = revision + 1,
              snapshot = jsonb_set(
                snapshot,
                '{revision}',
                to_jsonb(revision + 1),
                false
              ),
              updated_at = transaction_timestamp()
          WHERE meeting_id = $1
            AND revision = $2
        `,
        [meetingId, lifecycle.revision],
      );
      if (revisionUpdate.rowCount !== 1) {
        throw new Error("locked live meeting revision could not be advanced");
      }
      await client.query("COMMIT");
      return "appended";
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public listFinalizedTurns(meetingId: string): Promise<readonly LiveFinalizedTurn[]> {
    return this.listFinalizedTurnsWithExecutor(this.pool, meetingId);
  }

  public async listFinalizedTurnsWithExecutor(
    executor: LiveMeetingQueryExecutor,
    meetingId: string,
  ): Promise<readonly LiveFinalizedTurn[]> {
    const result = await executor.query<StoredLiveTurnRow>(
      `
        SELECT turns.turn,
               EXISTS (
                 SELECT 1
                 FROM meeting_core.live_meeting_summary_coverage AS coverage
                 WHERE coverage.meeting_id = turns.meeting_id
                   AND coverage.turn_id = turns.turn_id
               ) AS is_summarized
        FROM meeting_core.live_meeting_turns AS turns
        WHERE turns.meeting_id = $1
        ORDER BY turns.start_ms, turns.end_ms, turns.speaker_id, turns.turn_id
      `,
      [meetingId],
    );
    return result.rows.map((row) => restoreStoredLiveTurn(row, meetingId));
  }

  public appendGenerationTelemetry(
    meetingId: string,
    telemetry: LiveGenerationTelemetrySnapshot,
  ): Promise<LiveAppendResult> {
    return this.appendGenerationRecord(
      telemetryTable,
      meetingId,
      normalizeLiveGenerationTelemetry(telemetry),
    );
  }

  public appendGenerationUsage(
    meetingId: string,
    usage: LiveGenerationUsageSnapshot,
  ): Promise<LiveAppendResult> {
    return this.appendGenerationRecord(usageTable, meetingId, normalizeLiveGenerationUsage(usage));
  }

  public async commitSummary(input: CommitLiveMeetingSummaryInput): Promise<void> {
    const telemetry = input.telemetry === undefined
      ? undefined
      : normalizeLiveGenerationTelemetry(input.telemetry);
    const usage = input.usage === undefined
      ? undefined
      : normalizeLiveGenerationUsage(input.usage);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.state.saveWithExecutor(client, input.snapshot, input.expectedRevision);
      await this.appendSummaryCoverage(client, input);
      if (usage !== undefined) {
        await this.appendGenerationRecord(usageTable, input.snapshot.meetingId, usage, client);
      }
      if (telemetry !== undefined) {
        await this.appendGenerationRecord(telemetryTable, input.snapshot.meetingId, telemetry, client);
      }
      await client.query("COMMIT");
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockLifecycle(
    client: PoolClient,
    meetingId: string,
  ): Promise<LockedLifecycleRow | null> {
    const result = await client.query<LockedLifecycleRow>(
      `
        SELECT revision::float8 AS revision,
               snapshot ->> 'status' AS status
        FROM meeting_core.live_meetings
        WHERE meeting_id = $1
        FOR UPDATE
      `,
      [meetingId],
    );
    return result.rows[0] ?? null;
  }

  private async findTurnReplay(
    executor: LiveMeetingQueryExecutor,
    meetingId: string,
    turn: TranscriptTurnSnapshot,
  ): Promise<boolean | null> {
    const result = await executor.query<ExistingRecordRow>(
      `
        SELECT turn = $3::jsonb AS payload_matches
        FROM meeting_core.live_meeting_turns
        WHERE meeting_id = $1
          AND turn_id = $2
      `,
      [meetingId, turn.turnId, turn],
    );
    return result.rows[0]?.payload_matches ?? null;
  }

  private async appendSummaryCoverage(
    client: PoolClient,
    input: CommitLiveMeetingSummaryInput,
  ): Promise<void> {
    const ids = [...new Set(input.newlySummarizedTurnIds)];
    if (ids.length !== input.newlySummarizedTurnIds.length) {
      throw new LiveMeetingInvariantError("DUPLICATE_IDENTIFIER", "summary coverage turn IDs must be unique");
    }
    if (ids.length === 0) {
      return;
    }
    const summaryRevision = input.snapshot.draftSummary?.revision;
    if (summaryRevision === undefined) {
      throw new LiveMeetingInvariantError("INVALID_SNAPSHOT", "summary coverage requires a summary draft");
    }
    const present = await client.query<CountRow>(
      `
        SELECT count(*)::integer AS count
        FROM meeting_core.live_meeting_turns
        WHERE meeting_id = $1
          AND turn_id = ANY($2::text[])
      `,
      [input.snapshot.meetingId, ids],
    );
    if (present.rows[0]?.count !== ids.length) {
      throw new LiveMeetingInvariantError("INVALID_EVIDENCE_REFERENCE", "summary coverage turn is missing");
    }
    await client.query(
      `
        INSERT INTO meeting_core.live_meeting_summary_coverage
          (meeting_id, turn_id, first_summary_revision)
        SELECT $1, supplied.turn_id, $2
        FROM unnest($3::text[]) AS supplied(turn_id)
        ON CONFLICT (meeting_id, turn_id) DO NOTHING
      `,
      [input.snapshot.meetingId, summaryRevision, ids],
    );
  }

  private async appendGenerationRecord(
    table: typeof usageTable | typeof telemetryTable,
    meetingId: string,
    payload: LiveGenerationTelemetrySnapshot | LiveGenerationUsageSnapshot,
    executor: LiveMeetingQueryExecutor = this.pool,
  ): Promise<LiveAppendResult> {
    const inserted = await executor.query(
      `
        INSERT INTO ${table} (meeting_id, run_id, payload)
        SELECT $1, $2, $3::jsonb
        WHERE EXISTS (
          SELECT 1
          FROM meeting_core.live_meetings
          WHERE meeting_id = $1
        )
        ON CONFLICT (meeting_id, run_id) DO NOTHING
        RETURNING run_id
      `,
      [meetingId, payload.runId, payload],
    );
    if (inserted.rowCount === 1) {
      return "appended";
    }
    const existing = await executor.query<ExistingRecordRow>(
      `
        SELECT payload = $3::jsonb AS payload_matches
        FROM ${table}
        WHERE meeting_id = $1
          AND run_id = $2
      `,
      [meetingId, payload.runId, payload],
    );
    const replay = existing.rows[0];
    if (replay === undefined) {
      return "not-found";
    }
    if (replay.payload_matches) {
      return "reused";
    }
    throw new LiveMeetingInvariantError(
      "CONFLICTING_COMPLETION",
      "generation run was replayed with different values",
    );
  }
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the error that made the transaction unusable.
  }
}
