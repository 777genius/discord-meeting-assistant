import {
  type CommitLiveMeetingSummaryInput,
  type LiveAppendResult,
  type LiveFinalizedTurn,
  type LiveGenerationTelemetrySnapshot,
  type LiveGenerationUsageSnapshot,
  type LiveMeetingRepository,
  type LiveMeetingSnapshot,
  type LiveMeetingSnapshotAndTimeline,
  type LiveMeetingSnapshotAndTimelineReader,
} from "@discord-meeting/meeting-core/live-meeting";
import {
  type TranscriptTurnSnapshot,
} from "@discord-meeting/meeting-core/transcription";
import type { Pool, PoolClient } from "pg";

import { PostgresLiveMeetingRecords } from "./postgres-live-meeting-records.js";
import { PostgresLiveMeetingStateStore } from "./postgres-live-meeting-state.js";

/**
 * PostgreSQL adapter for compact CAS business state plus append-only derived
 * transcript and operational generation records.
 */
export class PostgresLiveMeetingRepository implements
  LiveMeetingRepository,
  LiveMeetingSnapshotAndTimelineReader
{
  private readonly records: PostgresLiveMeetingRecords;
  private readonly state: PostgresLiveMeetingStateStore;

  public constructor(private readonly pool: Pool) {
    this.state = new PostgresLiveMeetingStateStore(pool);
    this.records = new PostgresLiveMeetingRecords(pool, this.state);
  }

  public findById(meetingId: string): Promise<LiveMeetingSnapshot | null> {
    return this.state.findById(meetingId);
  }

  public save(
    snapshot: LiveMeetingSnapshot,
    expectedRevision: number | null,
  ): Promise<void> {
    return this.state.save(snapshot, expectedRevision);
  }

  public appendFinalizedTurn(
    meetingId: string,
    turn: TranscriptTurnSnapshot,
  ): Promise<LiveAppendResult> {
    return this.records.appendFinalizedTurn(meetingId, turn);
  }

  public listFinalizedTurns(meetingId: string): Promise<readonly LiveFinalizedTurn[]> {
    return this.records.listFinalizedTurns(meetingId);
  }

  public async readSnapshotAndTimeline(
    meetingId: string,
  ): Promise<LiveMeetingSnapshotAndTimeline | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const snapshot = await this.state.findByIdWithExecutor(client, meetingId);
      if (snapshot === null) {
        await client.query("COMMIT");
        return null;
      }
      const timeline = await this.records.listFinalizedTurnsWithExecutor(client, meetingId);
      await client.query("COMMIT");
      return Object.freeze({ snapshot, timeline });
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public appendGenerationTelemetry(
    meetingId: string,
    telemetry: LiveGenerationTelemetrySnapshot,
  ): Promise<LiveAppendResult> {
    return this.records.appendGenerationTelemetry(meetingId, telemetry);
  }

  public appendGenerationUsage(
    meetingId: string,
    usage: LiveGenerationUsageSnapshot,
  ): Promise<LiveAppendResult> {
    return this.records.appendGenerationUsage(meetingId, usage);
  }

  public commitSummary(input: CommitLiveMeetingSummaryInput): Promise<void> {
    return this.records.commitSummary(input);
  }
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the query error that made this read transaction unusable.
  }
}
